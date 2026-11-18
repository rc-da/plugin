import { describe, it, expect } from "vitest";
import { FakeObsidianApp } from "./fakes/fake-obsidian-app";
import { FakeGitHub } from "./fakes/fake-github";
import { FakeGitHubHttp } from "./fakes/fake-github-http";
import { FakeClock } from "./fakes/fake-state";
import { ObsidianVault, isHiddenPath, toArrayBuffer } from "../src/adapters/obsidian-vault";
import { GitHubRemote } from "../src/adapters/github";
import { MemoryKv, StateStore } from "../src/adapters/state-store";
import { runSync } from "../src/core/sync";
import { buildExcluder } from "../src/core/paths";
import { scanLocal } from "../src/core/scan";
import { REPO, BRANCH, quietLog, P, text } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);

describe("ObsidianVault — routing (§2)", () => {
  it("new notes: parent folders level by level, then vault.createBinary", async () => {
    const fx = new FakeObsidianApp();
    const v = new ObsidianVault(fx.app);
    await v.writeBytes(P("a/b/c.md"), enc("hi"));
    expect(fx.read("a/b/c.md")).toBe("hi");
    expect(fx.calls).toEqual(["vault.createFolder a", "vault.createFolder a/b", "vault.createBinary a/b/c.md"]);
  });

  it("existing notes go through vault.modifyBinary so open editors refresh", async () => {
    const fx = new FakeObsidianApp();
    fx.seed("n.md", "old");
    await new ObsidianVault(fx.app).writeBytes(P("n.md"), enc("new"));
    expect(fx.calls).toEqual(["vault.modifyBinary n.md"]);
    expect(fx.read("n.md")).toBe("new");
  });

  it("dot-paths (config dir) go through the adapter", async () => {
    const fx = new FakeObsidianApp();
    const v = new ObsidianVault(fx.app);
    await v.writeBytes(P(".obsidian/snippets/x.css"), enc("a{}"));
    expect(fx.calls).toEqual(["adapter.mkdir .obsidian", "adapter.mkdir .obsidian/snippets", "adapter.writeBinary .obsidian/snippets/x.css"]);
    expect(text(await v.readBytes(P(".obsidian/snippets/x.css")))).toBe("a{}");
    expect(isHiddenPath("a/.b/c")).toBe(true);
    expect(isHiddenPath("a/b.c")).toBe(false);
  });

  it("lists vault files plus configured hidden roots, recursively", async () => {
    const fx = new FakeObsidianApp();
    fx.seed("n.md", "n");
    fx.seed(".obsidian/app.json", "{}");
    fx.seed(".obsidian/snippets/x.css", "x");
    fx.seed(".github/workflows/ci.yml", "not listed");
    const files = await new ObsidianVault(fx.app, { hiddenRoots: () => [".obsidian"] }).listFiles();
    expect(files.map(f => f.path).sort()).toEqual([".obsidian/app.json", ".obsidian/snippets/x.css", "n.md"]);
    expect(files.find(f => f.path === "n.md")?.size).toBe(1);
  });

  it("delete uses the user's trash preference; rename never rewrites links", async () => {
    const fx = new FakeObsidianApp();
    fx.seed("a.md", "a");
    fx.seed("b.md", "b");
    const v = new ObsidianVault(fx.app);
    await v.deleteFile(P("a.md"));
    await v.renameFile(P("b.md"), P("sub/b.md"));
    expect(fx.calls).toEqual(["fileManager.trashFile a.md", "vault.createFolder sub", "vault.rename b.md -> sub/b.md"]);
    expect(fx.read("sub/b.md")).toBe("b");
  });

  it("removes only folders that are really empty (hidden children count)", async () => {
    const fx = new FakeObsidianApp();
    fx.seed("d/.hidden", "x");
    fx.folders.add("e");
    const v = new ObsidianVault(fx.app);
    await v.removeFolderIfEmpty(P("d"));
    await v.removeFolderIfEmpty(P("e"));
    await v.removeFolderIfEmpty(P("gone"));
    expect(fx.folders.has("d")).toBe(true);
    expect(fx.folders.has("e")).toBe(false);
  });

  it("stat and exists come from disk; folders are not files", async () => {
    const fx = new FakeObsidianApp();
    fx.seed("d/n.md", "abc");
    const v = new ObsidianVault(fx.app);
    expect(await v.stat(P("d/n.md"))).toMatchObject({ size: 3 });
    expect(await v.stat(P("d"))).toBeNull();
    expect(await v.fileExists(P("d"))).toBe(false);
    expect(await v.fileExists(P("d/n.md"))).toBe(true);
  });

  it("falls back to the adapter when the index lags behind the disk", async () => {
    const fx = new FakeObsidianApp();
    fx.seed("n.md", "on disk");
    const v = new ObsidianVault(fx.app);
    // Index has not seen the file yet:
    fx.vault.getFileByPath = () => null;
    await v.writeBytes(P("n.md"), enc("ours"));
    expect(fx.read("n.md")).toBe("ours");
  });
});

describe("ObsidianVault — bytes and names (§9)", () => {
  it("writes exactly the bytes of a subarray view, not its whole buffer", async () => {
    const fx = new FakeObsidianApp();
    const whole = new Uint8Array([9, 9, 1, 2, 3, 9]);
    await new ObsidianVault(fx.app).writeBytes(P("x.bin"), whole.subarray(2, 5));
    expect(fx.disk.get("x.bin")?.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(toArrayBuffer(whole))).toEqual(whole);
  });

  it("NFD names on disk are found by their NFC key for read, write, stat and delete", async () => {
    const fx = new FakeObsidianApp({ nfd: true });
    const nfc = "café/résumé.md".normalize("NFC");
    fx.seed(nfc, "v1");
    const v = new ObsidianVault(fx.app);
    const listed = await v.listFiles();
    expect(listed[0].path).toBe(nfc.normalize("NFD")); // host spelling; scan normalizes
    expect(text(await v.readBytes(P(nfc)))).toBe("v1");
    expect(await v.stat(P(nfc))).not.toBeNull();
    await v.writeBytes(P(nfc), enc("v2"));
    expect(fx.disk.has(nfc.normalize("NFD"))).toBe(true);
    expect(fx.disk.has(nfc)).toBe(false); // no NFC twin created
    expect(fx.read(nfc.normalize("NFD"))).toBe("v2");
    // A new file in the same NFD folder lands in that folder, not an NFC duplicate.
    await v.writeBytes(P("café/new.md".normalize("NFC")), enc("n"));
    expect(fx.disk.has(`${"café".normalize("NFD")}/new.md`)).toBe(true);
    await v.deleteFile(P(nfc));
    expect(fx.disk.has(nfc.normalize("NFD"))).toBe(false);
    await v.renameFile(P("café/new.md".normalize("NFC")), P("café/moved.md".normalize("NFC")));
    expect(fx.disk.has(`${"café".normalize("NFD")}/moved.md`)).toBe(true);
    expect(fx.folders.has("café".normalize("NFC"))).toBe(false);
  });

  it("scan over the adapter keys NFD files by NFC", async () => {
    const fx = new FakeObsidianApp({ nfd: true });
    fx.seed("ü.md", "x");
    const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync" });
    const r = await scanLocal({ vault: new ObsidianVault(fx.app), baseline: null, cache: {}, exclude });
    expect(Object.keys(r.files)).toEqual(["ü.md".normalize("NFC")]);
  });
});

describe("all real adapters together", () => {
  it("two devices sync through ObsidianVault + GitHubRemote + StateStore", async () => {
    const gh = new FakeGitHub();
    const http = new FakeGitHubHttp(gh, [REPO]);
    const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync" });
    const timers = { sleep: async () => {}, now: () => Date.now(), setTimer: (fn: () => void) => { const id = setTimeout(fn, 0); return () => clearTimeout(id); } };
    const device = (name: string, nfd = false) => {
      const fx = new FakeObsidianApp({ nfd });
      const deps = {
        vault: new ObsidianVault(fx.app), remote: new GitHubRemote({ http: http.client, getToken: () => "test-token", log: quietLog, timers }),
        state: new StateStore(new MemoryKv()), clock: new FakeClock(), log: quietLog,
        config: { repo: REPO, branch: BRANCH, deviceName: name, platform: "posix" as const, caseInsensitiveFs: false, exclude },
      };
      return { fx, sync: () => runSync(deps) };
    };
    const a = device("A");
    const b = device("B", true);
    a.fx.seed("Notes/Café.md", "one\ntwo\n");
    a.fx.seed("img.bin", new Uint8Array([0, 255, 0]));
    a.fx.seed(".obsidian/workspace.json", "{}"); // excluded, never listed anyway

    expect((await a.sync()).status).toBe("ok");
    expect((await b.sync()).pulled).toBe(2);
    expect(b.fx.read("Notes/Café.md")).toBe("one\ntwo\n");

    // Edit on the NFD device; must come back to A under the same name, no duplicates.
    const bCafe = [...b.fx.disk.keys()].find(k => k.normalize("NFC") === "Notes/Café.md".normalize("NFC"))!;
    b.fx.disk.get(bCafe)!.data = enc("one\ntwo\nthree\n");
    b.fx.disk.get(bCafe)!.mtime = 99_999;
    expect((await b.sync()).pushed).toBe(1);
    await a.sync();
    expect(a.fx.read("Notes/Café.md")).toBe("one\ntwo\nthree\n");
    expect([...(await gh.snapshotFiles(REPO, BRANCH)).keys()].sort()).toEqual([".gitkeep", "Notes/Café.md", "img.bin"]);
    expect((await a.sync()).status).toBe("noop");
    expect((await b.sync()).status).toBe("noop");
  });
});

describe("hidden repo files the vault cannot list (regression)", () => {
  it("a .github/ workflow in the repo is never deleted by syncing through the Obsidian adapter", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "note.md": "n", ".github/workflows/ci.yml": "on: push", ".editorconfig": "root = true", ".gitignore": "*.tmp\n" });
    const http = new FakeGitHubHttp(gh, [REPO]);
    const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync" });
    const timers = { sleep: async () => {}, now: () => Date.now(), setTimer: (fn: () => void) => { const id = setTimeout(fn, 0); return () => clearTimeout(id); } };
    const fx = new FakeObsidianApp();
    const deps = {
      vault: new ObsidianVault(fx.app), remote: new GitHubRemote({ http: http.client, getToken: () => "test-token", log: quietLog, timers }),
      state: new StateStore(new MemoryKv()), clock: new FakeClock(), log: quietLog,
      config: { repo: REPO, branch: BRANCH, deviceName: "A", platform: "posix" as const, caseInsensitiveFs: false, exclude },
    };
    await runSync(deps);
    await runSync(deps);
    await runSync(deps);
    const remote = await gh.snapshotFiles(REPO, BRANCH);
    expect(text(remote.get(".github/workflows/ci.yml"))).toBe("on: push");
    expect(text(remote.get(".editorconfig"))).toBe("root = true");
    expect(text(remote.get(".gitignore"))).toBe("*.tmp\n");
    expect(fx.read(".gitignore")).toBe("*.tmp\n"); // .gitignore is synced (it shapes the excludes)
    expect(fx.read(".github/workflows/ci.yml")).toBeUndefined(); // other dot-paths stay remote-only
    expect((await runSync(deps)).status).toBe("noop");
  });
});
