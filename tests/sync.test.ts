import { describe, it, expect, vi } from "vitest";
import { FakeGitHub } from "./fakes/fake-github";
import { FakeVault } from "./fakes/fake-vault";
import { FakeState, FakeClock } from "./fakes/fake-state";
import { runSync, SyncRunner, type SyncDeps } from "../src/core/sync";
import { buildExcluder } from "../src/core/paths";
import { conflictStamp } from "../src/core/merge";
import type { RenameRecord } from "../src/core/scan";
import type { SyncResult } from "../src/core/types";
import { REPO, BRANCH, quietLog, P, text } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);
const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync" });

/** One simulated device: its own vault and state, sharing the remote. */
class Device {
  vault = new FakeVault();
  state = new FakeState();
  clock = new FakeClock();
  renames: RenameRecord[] = [];
  constructor(public readonly gh: FakeGitHub, public readonly name: string, private extra: Partial<SyncDeps> = {}) {}

  deps(extra: Partial<SyncDeps> = {}): SyncDeps {
    return {
      vault: this.vault, remote: this.gh, state: this.state, clock: this.clock, log: quietLog,
      config: { repo: REPO, branch: BRANCH, deviceName: this.name, platform: "posix", caseInsensitiveFs: false, exclude },
      pendingRenames: this.renames,
      ...this.extra, ...extra,
    };
  }

  async sync(extra: Partial<SyncDeps> = {}): Promise<SyncResult> {
    const r = await runSync(this.deps(extra));
    this.renames = [];
    return r;
  }

  files(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, b] of this.vault.snapshot()) out[p] = text(b)!;
    return out;
  }
}

async function remoteFiles(gh: FakeGitHub): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [p, b] of await gh.snapshotFiles(REPO, BRANCH)) out[p] = text(b)!;
  return out;
}

describe("runSync — first sync", () => {
  it("pushes local-only, pulls remote-only, adopts identical, flags different; then converges", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "remote-only.md": "r", "same.md": "s", "diff.md": "remote" });
    const a = new Device(gh, "A");
    a.vault.seed("local-only.md", "l");
    a.vault.seed("same.md", "s");
    a.vault.seed("diff.md", "local");

    const r = await a.sync();

    expect(r.status).toBe("ok");
    expect(r.pulled).toBe(1);
    expect(r.pushed).toBe(3); // local-only.md, diff.md (local wins), conflict copy
    expect(r.deleted).toBe(0);
    expect(r.conflicts).toBe(1);
    const copy = "diff (conflict A 2023-11-14 2213).md".replace(/\d{4}-\d{2}-\d{2} \d{4}/, conflictStamp(a.clock.now()));
    const expected = { "local-only.md": "l", "same.md": "s", "diff.md": "local", "remote-only.md": "r", [copy]: "remote" };
    expect(a.files()).toEqual(expected);
    expect(await remoteFiles(gh)).toEqual(expected);
    expect(a.state.conflicts).toMatchObject([{ path: "diff.md", conflictPath: copy }]);

    // Everything is accounted for, so the baseline mirrors the head and the next sync is a noop.
    expect(a.state.baseline!.remoteHead).toBe((await gh.getRef(REPO, BRANCH))!.sha);
    expect(Object.keys(a.state.baseline!.files).sort()).toEqual(Object.keys(expected).sort());
    expect((await a.sync()).status).toBe("noop");
  });

  it("with a clean first sync the baseline mirrors the remote and the next sync is a noop", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "r.md": "r" });
    const a = new Device(gh, "A");
    a.vault.seed("l.md", "l");
    await a.sync();
    expect(a.state.baseline!.remoteHead).toBe((await gh.getRef(REPO, BRANCH))!.sha);
    expect(Object.keys(a.state.baseline!.dirs)).toEqual([""]);

    gh.calls = {};
    const r = await a.sync();
    expect(r.status).toBe("noop");
    expect(gh.calls).toEqual({ getRef: 1, getCommit: 1 });
  });

  it("bootstraps an empty repository and pushes the vault", async () => {
    const gh = new FakeGitHub();
    const a = new Device(gh, "A");
    a.vault.seed("note.md", "n");
    const r = await a.sync();
    expect(gh.calls.bootstrapRepo).toBe(1);
    expect(r.status).toBe("ok");
    expect(await remoteFiles(gh)).toMatchObject({ "note.md": "n" });
  });

  it("a baseline for another repo/branch is discarded (first-sync mode: no deletions)", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "r.md": "r" });
    const a = new Device(gh, "A");
    a.vault.seed("l.md", "l");
    a.state.baseline = { repo: "other/repo", branch: BRANCH, remoteHead: null, files: { [P("l.md")]: { sha: P("x") as never, mode: "100644" } }, dirs: {} };
    const r = await a.sync();
    expect(r.deleted).toBe(0);
    expect(r.pushed).toBe(1);
    expect(a.state.baseline!.repo).toBe(REPO);
  });
});

describe("runSync — two devices", () => {
  it("edits, deletes and renames flow between devices and both end in noop", async () => {
    const gh = new FakeGitHub();
    const a = new Device(gh, "A");
    const b = new Device(gh, "B");
    a.vault.seed("notes/one.md", "one v1");
    a.vault.seed("notes/two.md", "two");
    a.vault.seed("img.png", new Uint8Array([1, 2, 3]));

    await a.sync();
    await b.sync();
    expect(b.files()).toMatchObject({ "notes/one.md": "one v1", "notes/two.md": "two" });
    expect(await b.vault.readBytes(P("img.png"))).toEqual(new Uint8Array([1, 2, 3]));

    // B edits one, deletes two, renames img.
    await b.vault.writeBytes(P("notes/one.md"), enc("one v2"));
    await b.vault.deleteFile(P("notes/two.md"));
    await b.vault.renameFile(P("img.png"), P("pics/img.png"));
    b.renames.push({ from: P("img.png"), to: P("pics/img.png") });
    const rb = await b.sync();
    expect(rb.pushed).toBe(4); // one.md, two.md delete, img.png delete, pics/img.png
    expect(gh.calls.postBlob).toBe(1); // only A's original upload; the rename reused the blob

    const ra = await a.sync();
    expect(ra.pulled).toBe(1);
    expect(ra.deleted).toBe(1);
    expect(ra.renamed).toBe(1);
    expect(a.files()).toEqual({ "notes/one.md": "one v2", "pics/img.png": text(new Uint8Array([1, 2, 3])) });

    expect((await a.sync()).status).toBe("noop");
    expect((await b.sync()).status).toBe("noop");
    expect(a.state.baseline!.files).toEqual(b.state.baseline!.files);
  });

  it("edits beat deletes in both directions", async () => {
    const gh = new FakeGitHub();
    const a = new Device(gh, "A");
    const b = new Device(gh, "B");
    a.vault.seed("x.md", "x1");
    a.vault.seed("y.md", "y1");
    await a.sync();
    await b.sync();

    // A deletes x and edits y; B edits x and deletes y.
    await a.vault.deleteFile(P("x.md"));
    await a.vault.writeBytes(P("y.md"), enc("y2 from A"));
    await b.vault.writeBytes(P("x.md"), enc("x2 from B"));
    await b.vault.deleteFile(P("y.md"));

    await a.sync();           // pushes delete x, edit y
    const rb = await b.sync(); // x: local modified / remote deleted → keepLocal; y: local deleted / remote modified → resurrect
    expect(rb.pulled).toBe(1);
    expect(rb.pushed).toBe(1);
    await a.sync();

    const expected = { "x.md": "x2 from B", "y.md": "y2 from A" };
    expect(a.files()).toEqual(expected);
    expect(b.files()).toEqual(expected);
    expect(await remoteFiles(gh)).toEqual({ ...expected, ".gitkeep": "" });
  });

  it("retries the push when another device commits in between (422), without losing either change", async () => {
    const gh = new FakeGitHub();
    const a = new Device(gh, "A");
    a.vault.seed("a.md", "from A");
    const original = gh.updateRef.bind(gh);
    let raced = false;
    vi.spyOn(gh, "updateRef").mockImplementation(async (repo, branch, sha) => {
      if (!raced) {
        raced = true;
        gh.seedChange(repo, branch, { "b.md": "from B" }); // B sneaks in first
      }
      return original(repo, branch, sha);
    });

    const r = await a.sync();

    expect(r.attempts).toBe(2);
    expect(r.status).toBe("ok");
    expect(await remoteFiles(gh)).toMatchObject({ "a.md": "from A", "b.md": "from B" });
    expect(a.files()).toEqual({ "a.md": "from A", "b.md": "from B" });
    expect((await a.sync()).status).toBe("noop");
  });

  it("gives up with Conflict422 after the maximum attempts", async () => {
    const gh = new FakeGitHub();
    const a = new Device(gh, "A");
    a.vault.seed("a.md", "from A");
    const original = gh.updateRef.bind(gh);
    let n = 0;
    vi.spyOn(gh, "updateRef").mockImplementation(async (repo, branch, sha) => {
      gh.seedChange(repo, branch, { [`other${n++}.md`]: "x" });
      return original(repo, branch, sha);
    });
    await expect(a.sync({ config: { ...a.deps().config, maxPushAttempts: 2 } })).rejects.toMatchObject({ kind: "Conflict422" });
    expect(gh.calls.updateRef).toBe(2);
  });
});

describe("runSync — resumability and safety", () => {
  it("a failed pull leaves the head unadvanced so the next sync retries it", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "ok.md": "ok", "deep/flaky.md": "flaky" });
    const a = new Device(gh, "A");
    const vault = new FakeVault({ failOn: new Set(["deep/flaky.md"]) });
    a.vault = vault;

    const r1 = await a.sync();
    expect(r1.status).toBe("partial");
    expect(r1.pulled).toBe(1);
    expect(a.state.baseline!.remoteHead).toBeNull();
    expect(Object.keys(a.state.baseline!.dirs)).toEqual([]); // dirs not recorded while inconsistent

    a.vault = new FakeVault();
    a.vault.seed("ok.md", "ok", 1);
    const r2 = await a.sync();
    expect(r2.pulled).toBe(1);
    expect(r2.status).toBe("ok");
    expect(a.files()).toEqual({ "ok.md": "ok", "deep/flaky.md": "flaky" });
    expect(a.state.baseline!.remoteHead).toBe((await gh.getRef(REPO, BRANCH))!.sha);
  });

  it("a remote tree that returns to an earlier shape after a partial sync is still re-walked (regression)", async () => {
    // Found by the property test. After a partial pull the baseline listed dir/n3.md
    // while its cached root tree sha still described the tree without it. When the
    // remote reverted to exactly that tree, the walk skipped the root and the local
    // dir/n3.md was never deleted.
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "n1.md": "n" });
    const b = new Device(gh, "B");
    await b.sync(); // clean: dirs recorded for the one-file tree

    gh.seedChange(REPO, BRANCH, { "b0.bin": new Uint8Array([0, 1]), "dir/n3.md": "three" });
    b.vault = new FakeVault({ failOn: new Set(["b0.bin"]) });
    b.vault.seed("n1.md", "n");
    const partial = await b.sync();
    expect(partial.status).toBe("partial");
    expect(b.files()).toMatchObject({ "dir/n3.md": "three" });

    gh.seedChange(REPO, BRANCH, { "b0.bin": null, "dir/n3.md": null }); // back to the original tree
    b.vault = new FakeVault();
    b.vault.seed("n1.md", "n", 1);
    b.vault.seed("dir/n3.md", "three", 2);
    const r = await b.sync();
    expect(r.deleted).toBe(1);
    expect(b.files()).toEqual({ "n1.md": "n" });
    expect((await b.sync()).status).toBe("noop");
  });

  it("persists the baseline incrementally during apply", async () => {
    const gh = new FakeGitHub();
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) files[`f${i}.md`] = `${i}`;
    gh.seedRepo(REPO, BRANCH, files);
    const a = new Device(gh, "A");
    await a.sync();
    expect(a.state.saves).toBeGreaterThanOrEqual(3); // 25, 50, final
  });

  it("second scan reads nothing when files are unchanged (cache)", async () => {
    const gh = new FakeGitHub();
    const a = new Device(gh, "A");
    a.vault.seed("a.md", "a");
    a.vault.seed("b.md", "b");
    await a.sync();
    const read = vi.spyOn(a.vault, "readBytes");
    await a.sync();
    expect(read).not.toHaveBeenCalled();
  });

  it("a pulled file is re-hashed on the next scan, not trusted from a stale cache", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "v1" });
    const a = new Device(gh, "A");
    await a.sync();
    gh.seedChange(REPO, BRANCH, { "a.md": "v2" });
    await a.sync();
    expect((await a.sync()).status).toBe("noop");
    expect(a.files()).toEqual({ "a.md": "v2" });
  });

  it("excluded files are never pushed, and excluding a synced file later does not delete it remotely", async () => {
    const gh = new FakeGitHub();
    const a = new Device(gh, "A");
    a.vault.seed("Private/s.md", "secret");
    a.vault.seed(".obsidian/workspace.json", "{}");
    a.vault.seed("note.md", "n");
    await a.sync();
    expect(await remoteFiles(gh)).toMatchObject({ "Private/s.md": "secret", "note.md": "n" });
    expect((await remoteFiles(gh))[".obsidian/workspace.json"]).toBeUndefined();

    const ex = buildExcluder({ configDir: ".obsidian", pluginId: "x", userPatterns: ["Private/"] });
    const cfg = { ...a.deps().config, exclude: ex, excludeKey: "v2" };
    const r = await a.sync({ config: cfg });
    expect(r.status).toBe("noop");
    expect(await remoteFiles(gh)).toMatchObject({ "Private/s.md": "secret" });
    expect(a.files()).toMatchObject({ "Private/s.md": "secret" });
    expect(a.state.baseline!.files[P("Private/s.md")]).toBeUndefined();

    // Un-excluding brings it back as "added on both sides, identical" → adopted, no conflict.
    const r2 = await a.sync();
    expect(r2.status).toBe("noop");
    expect(a.state.baseline!.files[P("Private/s.md")]).toBeDefined();
  });

  it("changing exclude rules re-walks the whole remote tree once", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "Private/s.md": "s", "a.md": "a" });
    const a = new Device(gh, "A");
    const ex = buildExcluder({ configDir: ".obsidian", pluginId: "x", userPatterns: ["Private/"] });
    await a.sync({ config: { ...a.deps().config, exclude: ex, excludeKey: "private" } });
    expect(a.files()).toEqual({ "a.md": "a" });

    gh.calls = {};
    const r = await a.sync(); // default excluder, different key, remote head unchanged
    expect(gh.calls.getTree).toBe(2); // root + Private, despite the head not moving
    expect(r.pulled).toBe(1);
    expect(a.files()).toEqual({ "a.md": "a", "Private/s.md": "s" });
  });

  it("files over the size limit are skipped on both sides and reported", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "huge-remote.bin": new Uint8Array(200) });
    const a = new Device(gh, "A");
    a.vault.seed("huge-local.bin", new Uint8Array(200));
    a.vault.seed("small.md", "s");
    const r = await a.sync({ config: { ...a.deps().config, maxFileBytes: 100 } });
    expect(r.status).toBe("partial");
    expect(r.skipped.map(s => s.path).sort()).toEqual(["huge-local.bin", "huge-remote.bin"]);
    expect(a.vault.snapshot().has("huge-remote.bin")).toBe(false);
    expect((await remoteFiles(gh))["huge-local.bin"]).toBeUndefined();
    expect((await remoteFiles(gh))["small.md"]).toBe("s");
  });

  it("a guard can stop the sync before anything changes", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "r.md": "r" });
    const a = new Device(gh, "A");
    a.vault.seed("l.md", "l");
    const r = await a.sync({ guard: () => "too many deletions" });
    expect(r.status).toBe("stopped");
    expect(r.errors).toEqual([{ path: null, message: "too many deletions" }]);
    expect(a.files()).toEqual({ "l.md": "l" });
    expect(await remoteFiles(gh)).toEqual({ "r.md": "r" });
  });

  it("reports phases in order", async () => {
    const gh = new FakeGitHub();
    const a = new Device(gh, "A");
    a.vault.seed("l.md", "l");
    const phases: string[] = [];
    await a.sync({ onStatus: p => { if (phases.at(-1) !== p) phases.push(p); } });
    expect(phases).toEqual(["scanning", "fetching", "planning", "pulling", "pushing", "finishing"]);
  });

  it("uses the commit template with device name and count", async () => {
    const gh = new FakeGitHub();
    const a = new Device(gh, "Phone");
    a.vault.seed("a.md", "a");
    a.vault.seed("b.md", "b");
    await a.sync({ config: { ...a.deps().config, commitTemplate: "{{device}} pushed {{count}}" } });
    const head = (await gh.getRef(REPO, BRANCH))!.sha;
    expect((await gh.getCommit(REPO, head)).message).toBe("Phone pushed 2");
  });
});

describe("SyncRunner", () => {
  it("coalesces concurrent requests into one run plus one follow-up", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    const runner = new SyncRunner(async () => {
      runs++;
      if (runs === 1) await gate;
      return { status: "noop" } as SyncResult;
    });

    const p1 = runner.request();
    const p2 = runner.request();
    const p3 = runner.request();
    expect(runner.isRunning).toBe(true);
    expect(p2).toBe(p1);
    release();
    await Promise.all([p1, p2, p3]);
    expect(runs).toBe(2);
    expect(runner.isRunning).toBe(false);
  });

  it("releases the lock when the run throws", async () => {
    const runner = new SyncRunner(async () => { throw new Error("boom"); });
    await expect(runner.request()).rejects.toThrow("boom");
    expect(runner.isRunning).toBe(false);
  });
});
