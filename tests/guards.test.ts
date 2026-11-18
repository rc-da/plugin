import { describe, it, expect, vi } from "vitest";
import { FakeGitHub } from "./fakes/fake-github";
import { FakeVault } from "./fakes/fake-vault";
import { FakeState, FakeClock } from "./fakes/fake-state";
import { runSync, type SyncDeps } from "../src/core/sync";
import { buildExcluder } from "../src/core/paths";
import { checkEmptyRemote, checkMassDelete, massDeleteThreshold, plannedDeletions } from "../src/core/guards";
import type { SyncPlan, SyncResult } from "../src/core/types";
import { REPO, BRANCH, quietLog, P, S, baselineWith, text } from "./helpers";

// Safety guards (§5.6): mass-deletion, empty remote, first-sync mode.
// (Edited-during-sync is covered in apply.test.ts and sync.test.ts.)

const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync" });

class Device {
  vault = new FakeVault();
  state = new FakeState();
  clock = new FakeClock();
  constructor(public readonly gh: FakeGitHub, public readonly name = "A") {}
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
    for (const [p, b] of this.vault.snapshot()) out[p] = text(b) ?? "";
    return out;
  }
}

async function remoteFiles(gh: FakeGitHub): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [p, b] of await gh.snapshotFiles(REPO, BRANCH)) out[p] = text(b) ?? "";
  delete out[".gitkeep"];
  return out;
}

function numbered(n: number, prefix = "n", content = (i: number) => `note ${i}`): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) out[`${prefix}${String(i).padStart(4, "0")}.md`] = content(i);
  return out;
}

/** A device that has fully synced `files` with the remote. */
async function synced(files: Record<string, string>): Promise<{ gh: FakeGitHub; a: Device }> {
  const gh = new FakeGitHub();
  gh.seedRepo(REPO, BRANCH, files);
  const a = new Device(gh);
  for (const [p, c] of Object.entries(files)) a.vault.seed(p, c);
  const r = await a.sync();
  expect(r.status).toBe("noop");
  return { gh, a };
}

const nulls = (paths: string[]) => Object.fromEntries(paths.map(p => [p, null]));

describe("guards — pure helpers", () => {
  it("threshold is max(10, 5%)", () => {
    expect(massDeleteThreshold(0)).toBe(10);
    expect(massDeleteThreshold(100)).toBe(10);
    expect(massDeleteThreshold(1000)).toBe(50);
    expect(massDeleteThreshold(1000, { min: 3, ratio: 0.5 })).toBe(500);
  });

  it("deletions whose content reappears under a new path on the same side are renames, not deletions", () => {
    const baseline = baselineWith({ "a/x.md": "s1", "a/y.md": "s2", "gone.md": "s3", "r/old.md": "s4" });
    const plan: SyncPlan = {
      remoteHead: S("h"),
      actions: [
        { kind: "pushDelete", path: P("a/x.md") }, { kind: "push", path: P("b/x.md"), sha: S("s1") },
        { kind: "pushDelete", path: P("gone.md") },
        { kind: "pullDelete", path: P("r/old.md") }, { kind: "pull", path: P("r/new.md"), sha: S("s4"), mode: "100644" },
        { kind: "pullDelete", path: P("a/y.md") },
      ],
    };
    expect(plannedDeletions(plan, baseline)).toEqual({ local: ["a/y.md"], remote: ["gone.md"] });
  });

  it("an approval covers exactly the listed deletions; one more asks again", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`f${i}.md`] = `s${i}`;
    const baseline = baselineWith(files);
    const plan = (n: number): SyncPlan => ({
      remoteHead: S("h"),
      actions: Array.from({ length: n }, (_, i) => ({ kind: "pullDelete" as const, path: P(`f${i}.md`) })),
    });
    const input = { baseline, localFileCount: 12, remoteFileCount: 12 };
    const stop = checkMassDelete({ ...input, plan: plan(11) });
    expect(stop).toMatchObject({ kind: "massDelete", remote: [] });
    expect(stop?.kind === "massDelete" && stop.local).toHaveLength(11);
    const approved = stop?.kind === "massDelete" ? { local: stop.local, remote: stop.remote } : undefined;
    expect(checkMassDelete({ ...input, plan: plan(11), approved })).toBeNull();
    expect(checkMassDelete({ ...input, plan: plan(12), approved })).toMatchObject({ kind: "massDelete" });
    expect(checkMassDelete({ ...input, plan: plan(10) })).toBeNull();
  });

  it("empty remote: only suspicious when the baseline had files, approval is per head", () => {
    expect(checkEmptyRemote(baselineWith({}), S("h"), 0)).toBeNull();
    expect(checkEmptyRemote(baselineWith({ "a.md": "s" }), S("h"), 1)).toBeNull();
    expect(checkEmptyRemote(baselineWith({ "a.md": "s" }), S("h"), 0)).toMatchObject({ kind: "emptyRemote", head: "h", baselineFiles: 1 });
    expect(checkEmptyRemote(baselineWith({ "a.md": "s" }), null, 0)?.message).toMatch(/missing/);
    const ok = { head: S("h"), resolution: "reupload" as const };
    expect(checkEmptyRemote(baselineWith({ "a.md": "s" }), S("h"), 0, ok)).toBeNull();
    expect(checkEmptyRemote(baselineWith({ "a.md": "s" }), S("other"), 0, ok)).not.toBeNull();
  });
});

describe("mass-deletion guard (§5.6)", () => {
  it("stops before deleting more than 10 local files because of remote deletions; nothing changes", async () => {
    const files = numbered(20);
    const { gh, a } = await synced(files);
    const doomed = Object.keys(files).slice(0, 11);
    const head = gh.seedChange(REPO, BRANCH, nulls(doomed));

    const r = await a.sync();
    expect(r.status).toBe("stopped");
    expect(r.stop).toMatchObject({ kind: "massDelete", remote: [] });
    expect(r.stop?.kind === "massDelete" && [...r.stop.local].sort()).toEqual(doomed);
    expect(r.stop?.message).toMatch(/11 of 20 files in this vault/);
    expect(a.files()).toEqual(files);
    expect((await gh.getRef(REPO, BRANCH))?.sha).toBe(head);
  });

  it("goes through once the user confirms exactly those deletions", async () => {
    const files = numbered(20);
    const { gh, a } = await synced(files);
    const doomed = Object.keys(files).slice(0, 11);
    gh.seedChange(REPO, BRANCH, nulls(doomed));
    const stop = (await a.sync()).stop;
    if (stop?.kind !== "massDelete") throw new Error("expected a massDelete stop");

    const r = await a.sync({ approvals: { deletions: { local: stop.local, remote: stop.remote } } });
    expect(r.status).toBe("ok");
    expect(r.deleted).toBe(11);
    expect(Object.keys(a.files())).toHaveLength(9);
    expect((await a.sync()).status).toBe("noop");
  });

  it("an approval does not cover deletions the user has not seen", async () => {
    const files = numbered(20);
    const { gh, a } = await synced(files);
    const keys = Object.keys(files);
    gh.seedChange(REPO, BRANCH, nulls(keys.slice(0, 11)));
    const stop = (await a.sync()).stop;
    if (stop?.kind !== "massDelete") throw new Error("expected a massDelete stop");
    gh.seedChange(REPO, BRANCH, nulls([keys[15]]));

    const r = await a.sync({ approvals: { deletions: { local: stop.local, remote: stop.remote } } });
    expect(r.status).toBe("stopped");
    expect(a.files()).toEqual(files);
  });

  it("stops before pushing more than 10 local deletions to GitHub", async () => {
    const files = numbered(20);
    const { gh, a } = await synced(files);
    const head = (await gh.getRef(REPO, BRANCH))?.sha;
    for (const p of Object.keys(files).slice(0, 12)) await a.vault.deleteFile(P(p));

    const r = await a.sync();
    expect(r.status).toBe("stopped");
    expect(r.stop).toMatchObject({ kind: "massDelete", local: [] });
    expect(r.stop?.message).toMatch(/12 of 20 files on GitHub/);
    expect((await gh.getRef(REPO, BRANCH))?.sha).toBe(head);
    expect(await remoteFiles(gh)).toEqual(files);
  });

  it("10 deletions are allowed (threshold is 'more than')", async () => {
    const files = numbered(20);
    const { gh, a } = await synced(files);
    gh.seedChange(REPO, BRANCH, nulls(Object.keys(files).slice(0, 10)));
    const r = await a.sync();
    expect(r.status).toBe("ok");
    expect(r.deleted).toBe(10);
  });

  it("in a large vault the limit is 5% of the files", async () => {
    const files = numbered(400);
    const { gh, a } = await synced(files);
    gh.seedChange(REPO, BRANCH, nulls(Object.keys(files).slice(0, 20))); // 5% of 400 = 20
    expect((await a.sync()).status).toBe("ok");
    gh.seedChange(REPO, BRANCH, nulls(Object.keys(files).slice(20, 41))); // 21 of 380 > 19
    expect((await a.sync()).status).toBe("stopped");
  });

  it("a remote folder rename of many files is not a mass deletion", async () => {
    const files = numbered(30, "old/");
    const { gh, a } = await synced(files);
    const change: Record<string, string | null> = {};
    for (const [p, c] of Object.entries(files)) { change[p] = null; change[p.replace("old/", "new/")] = c; }
    gh.seedChange(REPO, BRANCH, change);

    const r = await a.sync();
    expect(r.status).toBe("ok");
    expect(r.renamed).toBe(30);
    expect(Object.keys(a.files()).every(p => p.startsWith("new/"))).toBe(true);
  });

  it("a local folder rename of identical files (no unique rename match) is not a mass deletion", async () => {
    const files = numbered(15, "tpl/", () => "same template");
    const { gh, a } = await synced(files);
    for (const p of Object.keys(files)) await a.vault.renameFile(P(p), P(p.replace("tpl/", "templates/")));

    const r = await a.sync();
    expect(r.status).toBe("ok");
    expect(Object.keys(await remoteFiles(gh)).every(p => p.startsWith("templates/"))).toBe(true);
  });

  it("a silent sync that is stopped does not throw and opens nothing: the result carries the stop", async () => {
    const files = numbered(20);
    const { gh, a } = await synced(files);
    gh.seedChange(REPO, BRANCH, nulls(Object.keys(files)));
    const guard = vi.fn(() => null);
    const r = await a.sync({ guard });
    expect(r.status).toBe("stopped");
    expect(r.stop?.kind).toBe("emptyRemote");
    expect(guard).not.toHaveBeenCalled();
  });
});

describe("empty-remote guard (§5.6)", () => {
  it("a wiped branch stops the sync instead of deleting the vault", async () => {
    const files = { "a.md": "a", "b.md": "b", "c/d.md": "d" };
    const { gh, a } = await synced(files);
    const head = gh.seedChange(REPO, BRANCH, nulls(Object.keys(files)));

    const r = await a.sync();
    expect(r.status).toBe("stopped");
    expect(r.stop).toMatchObject({ kind: "emptyRemote", head, baselineFiles: 3 });
    expect(a.files()).toEqual(files);
  });

  it("'reupload' pushes the vault back and deletes nothing", async () => {
    const files = { "a.md": "a", "b.md": "b", "c/d.md": "d" };
    const { gh, a } = await synced(files);
    const head = gh.seedChange(REPO, BRANCH, nulls(Object.keys(files)));
    await a.vault.deleteFile(P("b.md")); // a local deletion is not replayed either: first-sync mode

    const r = await a.sync({ approvals: { emptyRemote: { head, resolution: "reupload" } } });
    expect(r.status).toBe("ok");
    expect(r.deleted).toBe(0);
    expect(await remoteFiles(gh)).toEqual({ "a.md": "a", "c/d.md": "d" });
    expect((await a.sync()).status).toBe("noop");
  });

  it("'applyDeletions' empties the vault, without a second mass-delete prompt", async () => {
    const files = numbered(15);
    const { gh, a } = await synced(files);
    const head = gh.seedChange(REPO, BRANCH, nulls(Object.keys(files)));

    const r = await a.sync({ approvals: { emptyRemote: { head, resolution: "applyDeletions" } } });
    expect(r.status).toBe("ok");
    expect(r.deleted).toBe(15);
    expect(a.files()).toEqual({});
  });

  it("an approval for an older head does not apply after the remote moved again", async () => {
    const files = { "a.md": "a" };
    const { gh, a } = await synced(files);
    const head = gh.seedChange(REPO, BRANCH, { "a.md": null });
    gh.seedChange(REPO, BRANCH, { "README": null }); // another empty commit on top
    expect(head).not.toBe((await gh.getRef(REPO, BRANCH))?.sha);

    const r = await a.sync({ approvals: { emptyRemote: { head, resolution: "applyDeletions" } } });
    expect(r.status).toBe("stopped");
    expect(a.files()).toEqual(files);
  });

  it("a deleted branch stops before it is recreated", async () => {
    const files = { "a.md": "a", "b.md": "b" };
    const { gh, a } = await synced(files);
    gh.deleteRef(REPO, BRANCH);
    const bootstrap = vi.spyOn(gh, "bootstrapRepo");

    const r = await a.sync();
    expect(r.status).toBe("stopped");
    expect(r.stop).toMatchObject({ kind: "emptyRemote", head: null });
    expect(bootstrap).not.toHaveBeenCalled();
    expect(await gh.getRef(REPO, BRANCH)).toBeNull();
    expect(a.files()).toEqual(files);

    const r2 = await a.sync({ approvals: { emptyRemote: { head: null, resolution: "reupload" } } });
    expect(r2.status).toBe("ok");
    expect(await remoteFiles(gh)).toEqual(files);
    expect((await a.sync()).status).toBe("noop");
  });

  it("an empty repo on the very first sync is normal: the vault is pushed", async () => {
    const gh = new FakeGitHub();
    const a = new Device(gh);
    a.vault.seed("a.md", "a");
    const r = await a.sync();
    expect(r.status).toBe("ok");
    expect(await remoteFiles(gh)).toEqual({ "a.md": "a" });
  });
});

describe("first-sync mode (§5.6)", () => {
  it("losing the baseline degrades to first-sync mode, never to deletions", async () => {
    const files = { "keep.md": "k", "local-del.md": "x", "remote-del.md": "y", "edited.md": "v1" };
    const { gh, a } = await synced(files);
    await a.vault.deleteFile(P("local-del.md"));
    await a.vault.writeBytes(P("edited.md"), new TextEncoder().encode("local v2"));
    gh.seedChange(REPO, BRANCH, { "remote-del.md": null, "edited.md": "remote v2" });
    a.state.baseline = null; // IndexedDB cleared, app reinstalled, …

    const r = await a.sync();
    expect(r.deleted).toBe(0);
    // Deletions on either side are undone rather than replayed; differing content becomes a conflict copy.
    expect(a.files()["local-del.md"]).toBe("x");
    expect((await remoteFiles(gh))["remote-del.md"]).toBe("y");
    expect(a.files()["edited.md"]).toBe("local v2");
    expect(r.conflicts).toBe(1);
    expect(Object.values(await remoteFiles(gh))).toContain("remote v2");
    expect(await remoteFiles(gh)).toEqual(a.files());
  });
});
