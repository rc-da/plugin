import { describe, it, expect } from "vitest";
import { FakeGitHub, gitBlobShaSync } from "./fakes/fake-github";
import { FakeVault } from "./fakes/fake-vault";
import { FakeState, FakeClock } from "./fakes/fake-state";
import { resolveConflict, staleConflicts, withConflictMarkers } from "../src/core/conflicts";
import { previewLocalChanges } from "../src/core/preview";
import { holdBack, runSync, type SyncDeps } from "../src/core/sync";
import { buildExcluder } from "../src/core/paths";
import { ModalCoordinator, type ModalLike } from "../src/ui/modal-coordinator";
import { holdBackSet } from "../src/ui/review-modal";
import type { ConflictRecord, LocalChange } from "../src/core/types";
import { REPO, BRANCH, quietLog, P, text } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);
const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync" });

function rec(vault: FakeVault, local: string | Uint8Array, remote: string | Uint8Array, path = "n.md", copy = "n (conflict B 2026-11-18 1200).md"): ConflictRecord {
  const l = typeof local === "string" ? enc(local) : local;
  const r = typeof remote === "string" ? enc(remote) : remote;
  vault.seed(path, l);
  vault.seed(copy, r);
  return { path: P(path), conflictPath: P(copy), localSha: gitBlobShaSync(l), remoteSha: gitBlobShaSync(r), timestamp: 0 };
}

describe("resolveConflict (§5.5)", () => {
  it("keep mine: deletes the other version", async () => {
    const v = new FakeVault();
    const r = rec(v, "mine", "theirs");
    expect(await resolveConflict(v, r, "keepLocal")).toEqual({ status: "resolved" });
    expect([...v.snapshot().keys()]).toEqual(["n.md"]);
    expect(text(await v.readBytes(P("n.md")))).toBe("mine");
  });

  it("keep theirs: replaces mine with the other version", async () => {
    const v = new FakeVault();
    const r = rec(v, "mine", "theirs");
    expect(await resolveConflict(v, r, "keepRemote")).toEqual({ status: "resolved" });
    expect([...v.snapshot().keys()]).toEqual(["n.md"]);
    expect(text(await v.readBytes(P("n.md")))).toBe("theirs");
  });

  it("keep both: touches nothing", async () => {
    const v = new FakeVault();
    const r = rec(v, "mine", "theirs");
    expect(await resolveConflict(v, r, "keepBoth")).toEqual({ status: "resolved" });
    expect(v.snapshot().size).toBe(2);
  });

  it("never discards an edit made after the conflict was recorded", async () => {
    const v = new FakeVault();
    const r = rec(v, "mine", "theirs");
    await v.writeBytes(P("n.md"), enc("mine, edited later"));
    const out = await resolveConflict(v, r, "keepRemote");
    expect(out.status).toBe("refused");
    expect(text(await v.readBytes(P("n.md")))).toBe("mine, edited later");

    const v2 = new FakeVault();
    const r2 = rec(v2, "mine", "theirs");
    await v2.writeBytes(r2.conflictPath, enc("theirs, edited later"));
    expect((await resolveConflict(v2, r2, "keepLocal")).status).toBe("refused");
    expect(text(await v2.readBytes(r2.conflictPath))).toBe("theirs, edited later");
  });

  it("edit manually: markers around only the differing part; both versions survive", async () => {
    const v = new FakeVault();
    const r = rec(v, "# T\nmine\nend\n", "# T\ntheirs\nend\n");
    expect(await resolveConflict(v, r, "editManually")).toEqual({ status: "resolved" });
    expect(text(await v.readBytes(P("n.md")))).toBe(
      `# T\n<<<<<<< this device\nmine\n=======\ntheirs\n>>>>>>> ${r.conflictPath}\nend\n`);
    expect(await v.fileExists(r.conflictPath)).toBe(false);
  });

  it("edit manually is refused for binary files", async () => {
    const v = new FakeVault();
    const r = rec(v, new Uint8Array([0, 1]), new Uint8Array([0, 2]), "a.png", "a (conflict).png");
    expect((await resolveConflict(v, r, "editManually")).status).toBe("refused");
    expect(v.snapshot().size).toBe(2);
  });

  it("local file gone: keep theirs moves the copy into place; keep mine is refused", async () => {
    const v = new FakeVault();
    const r = rec(v, "mine", "theirs");
    await v.deleteFile(P("n.md"));
    expect((await resolveConflict(v, r, "keepLocal")).status).toBe("refused");
    expect(await resolveConflict(v, r, "keepRemote")).toEqual({ status: "resolved" });
    expect(text(await v.readBytes(P("n.md")))).toBe("theirs");
  });

  it("copy gone: the record is stale", async () => {
    const v = new FakeVault();
    const r = rec(v, "mine", "theirs");
    await v.deleteFile(r.conflictPath);
    expect(await resolveConflict(v, r, "keepRemote")).toEqual({ status: "stale" });
    expect(await staleConflicts(v, [r])).toEqual([r]);
    expect(text(await v.readBytes(P("n.md")))).toBe("mine");
  });

  it("markers: identical texts unchanged; whole-file difference wraps everything", () => {
    expect(withConflictMarkers("same\n", "same\n", "x")).toBe("same\n");
    expect(withConflictMarkers("a", "b", "x")).toBe("<<<<<<< this device\na\n=======\nb\n>>>>>>> x");
  });

  it("end to end: a real conflict, resolved with keep theirs, converges on both devices", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "pic.bin": new Uint8Array([0, 0]) });
    const dev = (name: string) => {
      const vault = new FakeVault();
      vault.seed("pic.bin", new Uint8Array([0, 0]));
      const state = new FakeState();
      const deps: SyncDeps = { vault, remote: gh, state, clock: new FakeClock(), log: quietLog,
        config: { repo: REPO, branch: BRANCH, deviceName: name, platform: "posix", caseInsensitiveFs: false, exclude } };
      return { vault, state, sync: () => runSync(deps) };
    };
    const a = dev("A");
    const b = dev("B");
    await a.sync();
    await b.sync();
    await a.vault.writeBytes(P("pic.bin"), new Uint8Array([0, 1]));
    await b.vault.writeBytes(P("pic.bin"), new Uint8Array([0, 2]));
    await a.sync();
    expect((await b.sync()).conflicts).toBe(1);
    const [record] = b.state.conflicts;
    expect(await resolveConflict(b.vault, record, "keepRemote")).toEqual({ status: "resolved" });
    await b.sync();
    await a.sync();
    for (const d of [a, b]) {
      expect([...d.vault.snapshot().keys()]).toEqual(["pic.bin"]);
      expect(await d.vault.readBytes(P("pic.bin"))).toEqual(new Uint8Array([0, 1]));
    }
  });
});

describe("previewLocalChanges (review modal)", () => {
  it("lists added, modified, deleted and renamed files, sorted; refreshes the cache", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "keep.md": "k", "edit.md": "e", "del.md": "d", "old.md": "o" });
    const vault = new FakeVault();
    for (const [p, c] of Object.entries({ "keep.md": "k", "edit.md": "e", "del.md": "d", "old.md": "o" })) vault.seed(p, c);
    const state = new FakeState();
    await runSync({ vault, remote: gh, state, clock: new FakeClock(), log: quietLog,
      config: { repo: REPO, branch: BRANCH, deviceName: "A", platform: "posix", caseInsensitiveFs: false, exclude } });
    await vault.writeBytes(P("edit.md"), enc("e2"));
    await vault.deleteFile(P("del.md"));
    await vault.renameFile(P("old.md"), P("new.md"));
    vault.seed("add.md", "a");

    const p = await previewLocalChanges({ vault, state, repo: REPO, branch: BRANCH, exclude, pendingRenames: [{ from: P("old.md"), to: P("new.md") }] });
    expect(p.firstSync).toBe(false);
    expect(p.changes.map(c => [c.kind, c.path])).toEqual([["added", "add.md"], ["deleted", "del.md"], ["modified", "edit.md"], ["renamed", "new.md"]]);
    expect(state.cache[P("add.md")]).toBeDefined();
  });

  it("without a baseline everything is new and firstSync is flagged", async () => {
    const vault = new FakeVault();
    vault.seed("a.md", "a");
    const p = await previewLocalChanges({ vault, state: new FakeState(), repo: REPO, branch: BRANCH, exclude });
    expect(p).toMatchObject({ firstSync: true, changes: [{ kind: "added", path: "a.md" }] });
  });
});

describe("hold back (review modal → runSync)", () => {
  async function synced(files: Record<string, string>) {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, files);
    const vault = new FakeVault();
    for (const [p, c] of Object.entries(files)) vault.seed(p, c);
    const deps: SyncDeps = { vault, remote: gh, state: new FakeState(), clock: new FakeClock(), log: quietLog,
      config: { repo: REPO, branch: BRANCH, deviceName: "A", platform: "posix", caseInsensitiveFs: false, exclude } };
    await runSync(deps);
    return { gh, vault, deps };
  }
  const remoteText = async (gh: FakeGitHub, p: string) => text((await gh.snapshotFiles(REPO, BRANCH)).get(p));

  it("held files stay untouched on both sides; the rest syncs; next sync picks them up", async () => {
    const { gh, vault, deps } = await synced({ "held.md": "1\n", "go.md": "1\n", "gone.md": "x" });
    await vault.writeBytes(P("held.md"), enc("local\n"));
    await vault.writeBytes(P("go.md"), enc("local\n"));
    await vault.deleteFile(P("gone.md"));
    gh.seedChange(REPO, BRANCH, { "held.md": "remote\n" });

    const r = await runSync({ ...deps, holdBack: new Set([P("held.md"), P("gone.md")]) });
    expect(r.skipped.map(s => [s.path, s.reason]).sort()).toEqual([["gone.md", "held back"], ["held.md", "held back"]]);
    expect(text(await vault.readBytes(P("held.md")))).toBe("local\n");   // not overwritten / merged
    expect(await remoteText(gh, "held.md")).toBe("remote\n");           // not pushed
    expect(await remoteText(gh, "gone.md")).toBe("x");                  // deletion not pushed
    expect(await remoteText(gh, "go.md")).toBe("local\n");              // the rest went through

    const r2 = await runSync(deps);
    expect(r2.conflicts + r2.merged).toBeGreaterThan(0);
    expect(await remoteText(gh, "gone.md")).toBeUndefined();
  });

  it("holding back deletions keeps them out of the mass-deletion guard", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.md`] = `${i}`;
    const { vault, deps } = await synced(files);
    for (let i = 0; i < 12; i++) await vault.deleteFile(P(`f${i}.md`));
    expect((await runSync(deps)).status).toBe("stopped");
    const held = new Set([0, 1, 2].map(i => P(`f${i}.md`)));
    expect((await runSync({ ...deps, holdBack: held })).status).toBe("partial"); // 9 deletions: under the limit
  });

  it("holdBack() skips a rename when either end is held", () => {
    const plan = { remoteHead: null, actions: [
      { kind: "pullRename" as const, oldPath: P("old.md"), path: P("new.md"), sha: gitBlobShaSync(enc("x")), mode: "100644" as const },
      { kind: "pushRename" as const, oldPath: P("a.md"), path: P("b.md"), sha: gitBlobShaSync(enc("y")) },
      { kind: "push" as const, path: P("c.md"), sha: gitBlobShaSync(enc("z")) },
    ] };
    const out = holdBack(plan, new Set([P("old.md"), P("b.md")]));
    expect(out.actions.map(a => a.kind)).toEqual(["skip", "skip", "push"]);
  });

  it("holdBackSet holds both ends of a rename", () => {
    const changes: LocalChange[] = [
      { kind: "renamed", oldPath: P("a.md"), path: P("b.md"), sha: gitBlobShaSync(enc("x")) },
      { kind: "added", path: P("c.md"), sha: gitBlobShaSync(enc("c")) },
    ];
    expect([...holdBackSet(changes, new Set(["b.md"]))].sort()).toEqual(["a.md", "b.md"]);
    expect([...holdBackSet(changes, new Set())]).toEqual([]);
  });
});

describe("ModalCoordinator (§10 modal rule)", () => {
  class M implements ModalLike {
    log: string[];
    private cbs: (() => void)[] = [];
    constructor(public name: string, log: string[]) { this.log = log; }
    open() { this.log.push(`open ${this.name}`); }
    close() { this.log.push(`close ${this.name}`); for (const cb of this.cbs.splice(0)) cb(); }
    onClosed(cb: () => void) { this.cbs.push(cb); }
  }

  it("closes the current modal, waits a frame, then opens the next; never two at once", async () => {
    const log: string[] = [];
    const c = new ModalCoordinator(async () => { log.push("frame"); });
    await c.open(() => new M("a", log));
    await c.open(() => new M("b", log));
    expect(log).toEqual(["frame", "open a", "close a", "frame", "open b"]);
    expect(c.isOpen).toBe(true);
  });

  it("opening from inside a closing modal still goes through a frame", async () => {
    const log: string[] = [];
    let frames = 0;
    const c = new ModalCoordinator(async () => { frames++; });
    const a = new M("a", log);
    await c.open(() => a);
    a.onClosed(() => { void c.open(() => new M("b", log)); }); // e.g. "confirm" button opens the next step
    a.close();
    expect(log).toEqual(["open a", "close a"]); // b not opened synchronously
    await Promise.resolve(); await Promise.resolve();
    expect(log).toEqual(["open a", "close a", "open b"]);
    expect(frames).toBe(2);
  });

  it("two opens racing: only the newest one opens", async () => {
    const log: string[] = [];
    let release!: () => void; // set synchronously by the Promise executor
    const gate = new Promise<void>(r => { release = r; });
    const c = new ModalCoordinator(() => gate);
    const p1 = c.open(() => new M("a", log));
    const p2 = c.open(() => new M("b", log));
    release();
    await Promise.all([p1, p2]);
    expect(log).toEqual(["open b"]);
  });

  it("a modal closed by the user frees the slot", async () => {
    const log: string[] = [];
    const c = new ModalCoordinator(async () => {});
    const a = new M("a", log);
    await c.open(() => a);
    a.close();
    expect(c.isOpen).toBe(false);
  });
});
