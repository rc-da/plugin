import { describe, it, expect, vi } from "vitest";
import { FakeGitHub, gitBlobShaSync } from "./fakes/fake-github";
import { FakeVault } from "./fakes/fake-vault";
import { applyPull, type ApplyDeps } from "../src/core/apply";
import { walkRemoteTree, diffRemote } from "../src/core/remote-diff";
import { buildPlan } from "../src/core/plan";
import type { Baseline, SyncPlan } from "../src/core/types";
import { mkPath } from "../src/core/types";
import { REPO, BRANCH, emptyBaseline, quietLog, recordingLog, P, S, text } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);

function deps(gh: FakeGitHub, vault: FakeVault, baseline: Baseline, extra: Partial<ApplyDeps> = {}): ApplyDeps {
  return {
    vault, remote: gh, repo: REPO, baseline,
    persist: async () => {},
    log: quietLog,
    platform: "posix",
    caseInsensitiveFs: false,
    ...extra,
  };
}

/** Walk the remote, diff against baseline, plan with no local changes. */
async function planFromRemote(gh: FakeGitHub, baseline: Baseline | null): Promise<SyncPlan> {
  const snap = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, baseline);
  return buildPlan({ baseline, local: [], remote: diffRemote(baseline, snap), remoteHead: S("h") });
}

/** Baseline that matches the current remote exactly (as if fully synced). */
async function syncedBaseline(gh: FakeGitHub): Promise<Baseline> {
  const snap = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, null);
  return { ...emptyBaseline(), files: snap.files, dirs: snap.dirs };
}

describe("applyPull — writes", () => {
  it("writes pulled files byte-for-byte and records them in the baseline", async () => {
    const gh = new FakeGitHub();
    const bin = new Uint8Array([0, 255, 10, 13, 0, 128]);
    gh.seedRepo(REPO, BRANCH, { "a.md": "hello", "deep/dir/b.bin": bin, "empty.md": "" });
    const vault = new FakeVault();
    const baseline = emptyBaseline();

    const res = await applyPull(await planFromRemote(gh, null), deps(gh, vault, baseline));

    expect(res.pulled).toBe(3);
    expect(res.errors).toEqual([]);
    expect(text(await vault.readBytes(P("a.md")))).toBe("hello");
    expect(await vault.readBytes(P("deep/dir/b.bin"))).toEqual(bin);
    expect((await vault.readBytes(P("empty.md"))).byteLength).toBe(0);
    expect(Object.keys(baseline.files).sort()).toEqual(["a.md", "deep/dir/b.bin", "empty.md"]);
    expect(baseline.files[P("a.md")].sha).toBe(gitBlobShaSync(enc("hello")));
  });

  it("reports (mtime, size, sha) of written files for the local cache", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "hello" });
    const vault = new FakeVault();
    const res = await applyPull(await planFromRemote(gh, null), deps(gh, vault, emptyBaseline()));
    const st = (await vault.stat(P("a.md")))!;
    expect(res.cacheUpdates.get(P("a.md"))).toEqual({ ...st, sha: gitBlobShaSync(enc("hello")) });
  });

  it("overwrites a locally unchanged file with the remote modification", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "v1" });
    const vault = new FakeVault();
    vault.seed("a.md", "v1");
    const baseline = await syncedBaseline(gh);

    gh.seedChange(REPO, BRANCH, { "a.md": "v2" });
    await applyPull(await planFromRemote(gh, baseline), deps(gh, vault, baseline));
    expect(text(await vault.readBytes(P("a.md")))).toBe("v2");
  });

  it("refuses to write a blob whose content does not hash to its sha", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "good" });
    vi.spyOn(gh, "getBlob").mockResolvedValue(enc("tampered"));
    const vault = new FakeVault();
    const baseline = emptyBaseline();
    const log = recordingLog();

    const res = await applyPull(await planFromRemote(gh, null), deps(gh, vault, baseline, { log }));

    expect(res.pulled).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(await vault.fileExists(P("a.md"))).toBe(false);
    expect(baseline.files[P("a.md")]).toBeUndefined();
    expect(log.lines.some(l => l.includes("refusing to write"))).toBe(true);
  });

  it("one failing file does not stop the others", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "a", "bad.md": "b", "c.md": "c" });
    const vault = new FakeVault({ failOn: new Set(["bad.md"]) });
    const baseline = emptyBaseline();

    const res = await applyPull(await planFromRemote(gh, null), deps(gh, vault, baseline));

    expect(res.pulled).toBe(2);
    expect(res.errors.map(e => e.path)).toEqual(["bad.md"]);
    expect(await vault.fileExists(P("a.md"))).toBe(true);
    expect(await vault.fileExists(P("c.md"))).toBe(true);
    expect(baseline.files[P("bad.md")]).toBeUndefined();
  });

  it("skips names invalid on this platform with a warning, never aborting", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "ok.md": "ok", "CON.md": "reserved", "bad:name.md": "colon" });
    const vault = new FakeVault();
    const log = recordingLog();

    const res = await applyPull(await planFromRemote(gh, null), deps(gh, vault, emptyBaseline(), { platform: "windows", log }));

    expect(res.pulled).toBe(1);
    expect(res.skipped.map(s => s.path).sort()).toEqual(["CON.md", "bad:name.md"]);
    expect(res.errors).toEqual([]);
    expect(log.lines.filter(l => l.startsWith("warn"))).toHaveLength(2);
  });

  it("on a case-insensitive filesystem pulls the first of two case-colliding paths and skips the second", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "Readme.md": "one", "readme.md": "two" });
    const vault = new FakeVault({ caseInsensitive: true });
    const baseline = emptyBaseline();

    const res = await applyPull(await planFromRemote(gh, null), deps(gh, vault, baseline, { caseInsensitiveFs: true }));

    expect(res.pulled).toBe(1);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toMatch(/differs only in case/);
    expect(Object.keys(baseline.files)).toHaveLength(1);
    // Exactly one file on disk, with the content of the one we recorded.
    const files = await vault.listFiles();
    expect(files).toHaveLength(1);
    const kept = Object.keys(baseline.files)[0];
    expect(text(await vault.readBytes(mkPath(kept)))).toBe(kept === "Readme.md" ? "one" : "two");
  });

  it("on a case-sensitive filesystem both case variants are written", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "Readme.md": "one", "readme.md": "two" });
    const vault = new FakeVault();
    const res = await applyPull(await planFromRemote(gh, null), deps(gh, vault, emptyBaseline()));
    expect(res.pulled).toBe(2);
  });
});

describe("applyPull — edited-during-sync guard", () => {
  it("does not overwrite a file whose mtime/size changed since the scan", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "v1" });
    const vault = new FakeVault();
    vault.seed("a.md", "v1");
    const baseline = await syncedBaseline(gh);
    const scanStats = new Map([[P("a.md"), (await vault.stat(P("a.md")))!]]);

    gh.seedChange(REPO, BRANCH, { "a.md": "remote v2" });
    const plan = await planFromRemote(gh, baseline);
    // User types while we were planning:
    await vault.writeBytes(P("a.md"), enc("user typed this"));

    const res = await applyPull(plan, deps(gh, vault, baseline, { scanStats }));

    expect(res.pulled).toBe(0);
    expect(res.skipped).toEqual([{ path: "a.md", reason: "edited during sync" }]);
    expect(text(await vault.readBytes(P("a.md")))).toBe("user typed this");
    expect(baseline.files[P("a.md")].sha).toBe(gitBlobShaSync(enc("v1"))); // baseline untouched
  });

  it("does not delete a file that was edited since the scan", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "v1" });
    const vault = new FakeVault();
    vault.seed("a.md", "v1");
    const baseline = await syncedBaseline(gh);
    const scanStats = new Map([[P("a.md"), (await vault.stat(P("a.md")))!]]);

    gh.seedChange(REPO, BRANCH, { "a.md": null });
    const plan = await planFromRemote(gh, baseline);
    await vault.writeBytes(P("a.md"), enc("still working on this"));

    const res = await applyPull(plan, deps(gh, vault, baseline, { scanStats }));
    expect(res.deleted).toBe(0);
    expect(await vault.fileExists(P("a.md"))).toBe(true);
  });

  it("a file created locally after the scan is not overwritten by a remote add", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, {});
    const vault = new FakeVault();
    const baseline = await syncedBaseline(gh);
    gh.seedChange(REPO, BRANCH, { "new.md": "remote" });
    const plan = await planFromRemote(gh, baseline);
    await vault.writeBytes(P("new.md"), enc("local"));

    const res = await applyPull(plan, deps(gh, vault, baseline, { scanStats: new Map() }));
    expect(res.skipped).toHaveLength(1);
    expect(text(await vault.readBytes(P("new.md")))).toBe("local");
  });

  it("a resurrect does not overwrite a file the user re-created after the scan (regression)", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "v1" });
    const vault = new FakeVault(); // a.md deleted locally before the scan
    const baseline = await syncedBaseline(gh);
    gh.seedChange(REPO, BRANCH, { "a.md": "remote v2" });
    const snap = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, baseline);
    const plan = buildPlan({
      baseline,
      local: [{ kind: "deleted", path: P("a.md"), oldSha: baseline.files[P("a.md")].sha }],
      remote: diffRemote(baseline, snap),
      remoteHead: S("h"),
    });
    expect(plan.actions.map(a => a.kind)).toEqual(["resurrect"]);
    await vault.writeBytes(P("a.md"), enc("user re-created this"));

    const res = await applyPull(plan, deps(gh, vault, baseline, { scanStats: new Map() }));
    expect(res.pulled).toBe(0);
    expect(res.skipped).toEqual([{ path: "a.md", reason: "edited during sync" }]);
    expect(text(await vault.readBytes(P("a.md")))).toBe("user re-created this");
  });

  it("a remote rename does not land on a file the user created at the target after the scan (regression)", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "old.md": "content" });
    const vault = new FakeVault();
    vault.seed("old.md", "content");
    const baseline = await syncedBaseline(gh);
    const scanStats = new Map([[P("old.md"), (await vault.stat(P("old.md")))!]]);
    gh.seedChange(REPO, BRANCH, { "old.md": null, "new.md": "content" });
    const plan = await planFromRemote(gh, baseline);
    expect(plan.actions.map(a => a.kind)).toEqual(["pullRename"]);
    await vault.writeBytes(P("new.md"), enc("typed into a new note"));

    const res = await applyPull(plan, deps(gh, vault, baseline, { scanStats }));
    expect(res.renamed).toBe(0);
    expect(res.skipped).toEqual([{ path: "new.md", reason: "edited during sync" }]);
    expect(text(await vault.readBytes(P("new.md")))).toBe("typed into a new note");
    expect(text(await vault.readBytes(P("old.md")))).toBe("content");
  });
});

describe("applyPull — deletes and renames", () => {
  it("deletes locally and prunes emptied folders deepest first", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a/b/c.md": "c", "a/keep.md": "k" });
    const vault = new FakeVault();
    vault.seed("a/b/c.md", "c");
    vault.seed("a/keep.md", "k");
    const baseline = await syncedBaseline(gh);
    const removed: string[] = [];
    vi.spyOn(vault, "removeFolderIfEmpty").mockImplementation(async p => { removed.push(p); });

    gh.seedChange(REPO, BRANCH, { "a/b/c.md": null });
    const res = await applyPull(await planFromRemote(gh, baseline), deps(gh, vault, baseline));

    expect(res.deleted).toBe(1);
    expect(await vault.fileExists(P("a/b/c.md"))).toBe(false);
    expect(await vault.fileExists(P("a/keep.md"))).toBe(true);
    expect(baseline.files[P("a/b/c.md")]).toBeUndefined();
    expect(removed).toEqual(["a/b", "a"]);
  });

  it("deleting an already-missing file still cleans the baseline", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "a" });
    const vault = new FakeVault(); // file never existed locally
    const baseline = await syncedBaseline(gh);
    gh.seedChange(REPO, BRANCH, { "a.md": null });
    const res = await applyPull(await planFromRemote(gh, baseline), deps(gh, vault, baseline));
    expect(res.deleted).toBe(1);
    expect(res.errors).toEqual([]);
    expect(baseline.files[P("a.md")]).toBeUndefined();
  });

  it("applies a remote rename as a local rename without re-downloading", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "old.md": "content" });
    const vault = new FakeVault();
    vault.seed("old.md", "content");
    const baseline = await syncedBaseline(gh);

    gh.seedChange(REPO, BRANCH, { "old.md": null, "sub/new.md": "content" });
    gh.calls = {};
    const res = await applyPull(await planFromRemote(gh, baseline), deps(gh, vault, baseline));

    expect(res.renamed).toBe(1);
    expect(gh.calls.getBlob).toBeUndefined();
    expect(await vault.fileExists(P("old.md"))).toBe(false);
    expect(text(await vault.readBytes(P("sub/new.md")))).toBe("content");
    expect(Object.keys(baseline.files)).toEqual(["sub/new.md"]);
  });

  it("a rename whose source is already gone locally falls back to writing the new path", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "old.md": "content" });
    const vault = new FakeVault(); // no old.md locally
    const baseline = await syncedBaseline(gh);
    gh.seedChange(REPO, BRANCH, { "old.md": null, "new.md": "content" });

    const res = await applyPull(await planFromRemote(gh, baseline), deps(gh, vault, baseline));
    expect(res.renamed).toBe(1);
    expect(text(await vault.readBytes(P("new.md")))).toBe("content");
  });

  it("resurrect brings back a remotely modified file the local side deleted", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "v1" });
    const vault = new FakeVault(); // deleted locally
    const baseline = await syncedBaseline(gh);
    gh.seedChange(REPO, BRANCH, { "a.md": "v2" });
    const snap = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, baseline);
    const plan = buildPlan({
      baseline,
      local: [{ kind: "deleted", path: P("a.md"), oldSha: baseline.files[P("a.md")].sha }],
      remote: diffRemote(baseline, snap),
      remoteHead: S("h"),
    });
    expect(plan.actions[0].kind).toBe("resurrect");

    const res = await applyPull(plan, deps(gh, vault, baseline));
    expect(res.pulled).toBe(1);
    expect(text(await vault.readBytes(P("a.md")))).toBe("v2");
  });
});

describe("applyPull — persistence and progress", () => {
  it("persists the baseline every N operations and at the end", async () => {
    const gh = new FakeGitHub();
    const files: Record<string, string> = {};
    for (let i = 0; i < 7; i++) files[`f${i}.md`] = `${i}`;
    gh.seedRepo(REPO, BRANCH, files);
    const vault = new FakeVault();
    const baseline = emptyBaseline();
    const sizes: number[] = [];
    const persist = async (b: Baseline) => { sizes.push(Object.keys(b.files).length); };

    await applyPull(await planFromRemote(gh, null), deps(gh, vault, baseline, { persist, persistEvery: 3 }));

    // after 3, after 6, and final (7)
    expect(sizes).toEqual([3, 6, 7]);
  });

  it("a crash mid-way leaves a baseline that only claims what was actually written", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "a", "b.md": "b", "c.md": "c" });
    const vault = new FakeVault();
    const baseline = emptyBaseline();
    let writes = 0;
    const original = vault.writeBytes.bind(vault);
    vi.spyOn(vault, "writeBytes").mockImplementation(async (p, d) => {
      if (++writes === 2) throw new Error("app killed");
      return original(p, d);
    });

    const res = await applyPull(await planFromRemote(gh, null), deps(gh, vault, baseline));

    expect(res.pulled).toBe(2);
    for (const [p] of Object.entries(baseline.files)) {
      expect(await vault.fileExists(mkPath(p))).toBe(true);
    }
    expect(Object.keys(baseline.files)).toHaveLength(2);
  });

  it("reports progress for every pull action", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "a", "b.md": "b" });
    const vault = new FakeVault();
    const seen: string[] = [];
    await applyPull(await planFromRemote(gh, null), deps(gh, vault, emptyBaseline(), {
      onProgress: (d, t) => seen.push(`${d}/${t}`),
    }));
    expect(seen).toEqual(["1/2", "2/2"]);
  });

  it("ignores push-side actions entirely", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, {});
    const vault = new FakeVault();
    vault.seed("local.md", "mine");
    const plan: SyncPlan = {
      remoteHead: null,
      actions: [
        { kind: "push", path: P("local.md"), sha: S("x") },
        { kind: "pushDelete", path: P("gone.md") },
      ],
    };
    const res = await applyPull(plan, deps(gh, vault, emptyBaseline()));
    expect(res).toEqual({ pulled: 0, deleted: 0, renamed: 0, skipped: [], errors: [], cacheUpdates: new Map(), merged: 0, conflicts: [], touched: [] });
    expect(await vault.fileExists(P("local.md"))).toBe(true);
  });
});
