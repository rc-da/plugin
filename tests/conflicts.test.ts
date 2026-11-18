import { describe, it, expect } from "vitest";
import { FakeGitHub } from "./fakes/fake-github";
import { FakeVault } from "./fakes/fake-vault";
import { FakeState, FakeClock } from "./fakes/fake-state";
import { runSync, type SyncDeps } from "../src/core/sync";
import { buildExcluder } from "../src/core/paths";
import { conflictStamp } from "../src/core/merge";
import type { SyncResult } from "../src/core/types";
import { REPO, BRANCH, quietLog, P, text } from "./helpers";

// End-to-end §5.4 "changed/changed" rows and §5.5 conflict behaviour through the orchestrator.

const enc = (s: string) => new TextEncoder().encode(s);
const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync" });

class Device {
  vault = new FakeVault();
  state = new FakeState();
  clock = new FakeClock();
  constructor(public gh: FakeGitHub, public name: string) {}
  deps(extra: Partial<SyncDeps> = {}): SyncDeps {
    return {
      vault: this.vault, remote: this.gh, state: this.state, clock: this.clock, log: quietLog,
      config: { repo: REPO, branch: BRANCH, deviceName: this.name, platform: "posix", caseInsensitiveFs: false, exclude },
      ...extra,
    };
  }
  sync(extra: Partial<SyncDeps> = {}): Promise<SyncResult> { return runSync(this.deps(extra)); }
  files(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, b] of this.vault.snapshot()) out[p] = text(b)!;
    return out;
  }
  write(p: string, s: string | Uint8Array) { return this.vault.writeBytes(P(p), typeof s === "string" ? enc(s) : s); }
}

async function remoteFiles(gh: FakeGitHub) {
  const out: Record<string, string> = {};
  for (const [p, b] of await gh.snapshotFiles(REPO, BRANCH)) if (p !== ".gitkeep") out[p] = text(b)!;
  return out;
}

async function pair(initial: Record<string, string | Uint8Array>) {
  const gh = new FakeGitHub();
  const a = new Device(gh, "A");
  const b = new Device(gh, "B");
  for (const [p, c] of Object.entries(initial)) a.vault.seed(p, c);
  await a.sync();
  await b.sync();
  return { gh, a, b };
}

async function settle(...devices: Device[]) {
  for (let round = 0; round < 6; round++) {
    let quiet = true;
    for (const d of devices) if ((await d.sync()).status !== "noop") quiet = false;
    if (quiet) return;
  }
  throw new Error("did not converge");
}

describe("both changed — text", () => {
  it("non-overlapping edits merge automatically and converge with no conflict", async () => {
    const { gh, a, b } = await pair({ "n.md": "one\ntwo\nthree\nfour\nfive\n" });
    await a.write("n.md", "ONE\ntwo\nthree\nfour\nfive\n");
    await b.write("n.md", "one\ntwo\nthree\nfour\nFIVE\n");

    await a.sync();
    const rb = await b.sync();
    expect(rb.merged).toBe(1);
    expect(rb.conflicts).toBe(0);
    expect(b.files()).toEqual({ "n.md": "ONE\ntwo\nthree\nfour\nFIVE\n" });
    expect(await remoteFiles(gh)).toEqual({ "n.md": "ONE\ntwo\nthree\nfour\nFIVE\n" });

    await settle(a, b);
    expect(a.files()).toEqual(b.files());
    expect(b.state.conflicts).toEqual([]);
  });

  it("overlapping edits keep local in place and write the remote version as a conflict copy, pushing both", async () => {
    const { gh, a, b } = await pair({ "notes/n.md": "base\n" });
    await a.write("notes/n.md", "A's version\n");
    await b.write("notes/n.md", "B's version\n");

    await a.sync();
    const rb = await b.sync();
    expect(rb.conflicts).toBe(1);
    const copy = `notes/n (conflict B ${conflictStamp(b.clock.now())}).md`;
    expect(b.files()).toEqual({ "notes/n.md": "B's version\n", [copy]: "A's version\n" });
    expect(await remoteFiles(gh)).toEqual({ "notes/n.md": "B's version\n", [copy]: "A's version\n" });
    expect(b.state.conflicts).toMatchObject([{ path: "notes/n.md", conflictPath: copy }]);
    expect(rb.status).toBe("ok");

    await settle(a, b);
    expect(a.files()).toEqual(b.files());
  });

  it("never writes conflict markers into a note", async () => {
    const { a, b } = await pair({ "n.md": "x\n" });
    await a.write("n.md", "a\n");
    await b.write("n.md", "b\n");
    await a.sync();
    await b.sync();
    for (const content of Object.values(b.files())) expect(content).not.toMatch(/^(<<<<<<<|>>>>>>>|=======)/m);
  });

  it("a conflicted file does not stop other files from syncing", async () => {
    const { gh, a, b } = await pair({ "c.md": "x\n", "other.md": "o\n" });
    await a.write("c.md", "a\n");
    await a.write("other.md", "o from A\n");
    await b.write("c.md", "b\n");
    await b.write("new.md", "n\n");
    await a.sync();
    const rb = await b.sync();
    expect(rb.conflicts).toBe(1);
    expect(b.files()["other.md"]).toBe("o from A\n");
    expect((await remoteFiles(gh))["new.md"]).toBe("n\n");
  });

  it("JSON that merges textually but breaks syntactically becomes a conflict", async () => {
    const { a, b } = await pair({ "x.json": '["a",\n"b",\n"c",\n"d",\n"e"]' });
    await a.write("x.json", '["a",\n"b"\n]');
    await b.write("x.json", '["a",\n"b",\n"c",\n"d",\n"e",\n"f"]');
    await a.sync();
    const rb = await b.sync();
    expect(rb.conflicts).toBe(1);
    expect(rb.merged).toBe(0);
    for (const c of Object.values(b.files())) expect(() => JSON.parse(c)).not.toThrow();
  });

  it("the same change on both sides converges with no conflict and no copy", async () => {
    const { a, b } = await pair({ "n.md": "x\n" });
    await a.write("n.md", "same\n");
    await b.write("n.md", "same\n");
    await a.sync();
    const rb = await b.sync();
    expect(rb.conflicts).toBe(0);
    expect(rb.status).toBe("noop");
    expect(Object.keys(b.files())).toEqual(["n.md"]);
  });
});

describe("both changed — binary and added/added", () => {
  it("binary both-changed is a conflict copy, bytes intact on both versions", async () => {
    const { gh, a, b } = await pair({ "img.png": new Uint8Array([0, 0, 0]) });
    const av = new Uint8Array([1, 1, 1]);
    const bv = new Uint8Array([2, 2, 2]);
    await a.write("img.png", av);
    await b.write("img.png", bv);
    await a.sync();
    const rb = await b.sync();
    expect(rb.conflicts).toBe(1);
    const copy = `img (conflict B ${conflictStamp(b.clock.now())}).png`;
    expect(await b.vault.readBytes(P("img.png"))).toEqual(bv);
    expect(await b.vault.readBytes(P(copy))).toEqual(av);
    const remote = await gh.snapshotFiles(REPO, BRANCH);
    expect(remote.get("img.png")).toEqual(bv);
    expect(remote.get(copy)).toEqual(av);
  });

  it("added on both devices with different content is a conflict copy, never an overwrite", async () => {
    const { gh, a, b } = await pair({});
    await a.write("new.md", "from A");
    await b.write("new.md", "from B");
    await a.sync();
    const rb = await b.sync();
    expect(rb.conflicts).toBe(1);
    const files = await remoteFiles(gh);
    expect(Object.values(files).sort()).toEqual(["from A", "from B"]);
    await settle(a, b);
    expect(a.files()).toEqual(b.files());
  });

  it("conflict copies from the same minute get distinct names", async () => {
    const { a, b } = await pair({ "n.md": "x\n" });
    await a.write("n.md", "a1\n");
    await b.write("n.md", "b1\n");
    await a.sync();
    await b.sync();
    // Second conflict on the same file, same (fake) minute.
    await a.sync(); // A picks up B's version + copy
    await a.write("n.md", "a2\n");
    await b.write("n.md", "b2\n");
    await a.sync();
    const rb = await b.sync();
    expect(rb.conflicts).toBe(1);
    const copies = Object.keys(b.files()).filter(p => p.includes("(conflict"));
    expect(copies).toHaveLength(2);
    expect(new Set(copies).size).toBe(2);
  });
});

describe("edited during sync", () => {
  it("a merge whose local file changed since the scan is neither written nor pushed", async () => {
    const { gh, a, b } = await pair({ "n.md": "one\ntwo\nthree\n" });
    await a.write("n.md", "ONE\ntwo\nthree\n");
    await b.write("n.md", "one\ntwo\nTHREE\n");
    await a.sync();

    // User on B keeps typing while the sync runs: inject between planning and applying.
    const orig = b.vault.writeBytes.bind(b.vault);
    let injected = false;
    const guard = async () => {
      if (!injected) { injected = true; await orig(P("n.md"), enc("one\ntwo\nTHREE\nmore typing\n")); }
      return null;
    };
    const rb = await b.sync({ guard });
    expect(rb.merged).toBe(0);
    expect(rb.skipped).toEqual([{ path: "n.md", reason: "edited during sync" }]);
    expect(b.files()["n.md"]).toBe("one\ntwo\nTHREE\nmore typing\n");
    expect((await remoteFiles(gh))["n.md"]).toBe("ONE\ntwo\nthree\n"); // untouched

    // Next sync merges the newer local text cleanly.
    const rb2 = await b.sync();
    expect(rb2.merged).toBe(1);
    expect(b.files()["n.md"]).toBe("ONE\ntwo\nTHREE\nmore typing\n");
    await settle(a, b);
    expect(a.files()).toEqual(b.files());
  });
});
