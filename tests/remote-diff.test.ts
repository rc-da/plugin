import { describe, it, expect } from "vitest";
import { FakeGitHub } from "./fakes/fake-github";
import { walkRemoteTree, diffRemote, fetchRemoteChanges } from "../src/core/remote-diff";
import { buildExcluder } from "../src/core/paths";
import type { Baseline, RemoteChange } from "../src/core/types";
import { REPO, BRANCH, emptyBaseline, P, S } from "./helpers";

const byPath = (changes: RemoteChange[]) =>
  Object.fromEntries(changes.map(c => [c.path, c]));

describe("walkRemoteTree", () => {
  it("lists every blob with its full NFC path and records a sha per directory", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, {
      "root.md": "r",
      "notes/a.md": "a",
      "notes/deep/b.md": "b",
      "img/pic.png": new Uint8Array([1, 2, 3]),
    });
    const root = gh.headTreeSha(REPO, BRANCH)!;
    const snap = await walkRemoteTree(gh, REPO, root, null);

    expect(Object.keys(snap.files).sort()).toEqual(["img/pic.png", "notes/a.md", "notes/deep/b.md", "root.md"]);
    expect(Object.keys(snap.dirs).sort()).toEqual(["", "img", "notes", "notes/deep"]);
    expect(snap.dirs[P("")]).toBe(root);
    expect(gh.calls.getTree).toBe(4); // one request per directory, never recursive
  });

  it("normalizes NFD entry names to NFC", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "Café.md": "x" });
    const snap = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, null);
    expect(Object.keys(snap.files)).toEqual(["Café.md"]);
  });

  it("skips symlinks and submodules, reporting them", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, {
      "ok.md": "fine",
      "link": { sha: "0".repeat(40), mode: "120000", type: "blob" },
      "vendor/lib": { sha: "1".repeat(40), mode: "160000", type: "commit" },
    });
    const snap = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, null);
    expect(Object.keys(snap.files)).toEqual(["ok.md"]);
    expect(snap.skipped.map(s => [s.path, s.reason])).toEqual([
      ["link", "symbolic link"],
      ["vendor/lib", "git submodule"],
    ]);
  });

  it("preserves 100755 mode", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "run.sh": { content: "#!/bin/sh", mode: "100755" } });
    const snap = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, null);
    expect(snap.files[P("run.sh")].mode).toBe("100755");
  });

  it("does not descend into directories whose tree sha is unchanged since the baseline", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, {
      "big/one.md": "1",
      "big/two.md": "2",
      "big/sub/three.md": "3",
      "small/x.md": "x",
    });
    const first = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, null);
    const baseline: Baseline = { ...emptyBaseline(), files: first.files, dirs: first.dirs };

    // Other device touches only small/
    gh.seedChange(REPO, BRANCH, { "small/x.md": "x2", "small/y.md": "y" });
    gh.calls = {};
    const second = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, baseline);

    expect(gh.calls.getTree).toBe(2); // root + small; big/ and big/sub skipped
    expect(Object.keys(second.files).sort()).toEqual(
      ["big/one.md", "big/sub/three.md", "big/two.md", "small/x.md", "small/y.md"],
    );
    // Skipped subtree's dir shas are carried over too.
    expect(second.dirs[P("big")]).toBe(first.dirs[P("big")]);
    expect(second.dirs[P("big/sub")]).toBe(first.dirs[P("big/sub")]);
  });

  it("reports progress", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a/x.md": "x", "b.md": "b" });
    const seen: number[][] = [];
    await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, null, {
      onProgress: (d, f) => seen.push([d, f]),
    });
    expect(seen.at(-1)).toEqual([2, 2]);
  });
});

describe("walkRemoteTree — excludes", () => {
  const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "x", userPatterns: ["Private/", "*.log"] });

  it("excluded files are invisible and excluded directories are never fetched", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, {
      "note.md": "n",
      "debug.log": "x",
      ".gitkeep": "",
      ".obsidian/app.json": "{}",
      "Private/secret.md": "s",
      "Private/deep/more.md": "m",
    });
    const snap = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, null, { exclude });
    expect(Object.keys(snap.files)).toEqual(["note.md"]);
    expect(gh.calls.getTree).toBe(1); // root only
    expect(Object.keys(snap.dirs)).toEqual([""]);
  });

  it("a baseline path that is now excluded is not reported as deleted", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "Private/s.md": "s", "a.md": "a" });
    const before = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, null);
    const baseline: Baseline = { ...emptyBaseline(), files: before.files, dirs: {} };
    const after = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, baseline, { exclude });
    expect(diffRemote(baseline, after, p => exclude(p))).toEqual([]);
    expect(diffRemote(baseline, after)).toMatchObject([{ kind: "deleted", path: "Private/s.md" }]);
  });
});

describe("diffRemote", () => {
  it("classifies added, modified, deleted", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "keep.md": "k", "mod.md": "m1", "gone.md": "g" });
    const before = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, null);
    const baseline: Baseline = { ...emptyBaseline(), files: before.files, dirs: before.dirs };

    gh.seedChange(REPO, BRANCH, { "mod.md": "m2", "gone.md": null, "new.md": "n" });
    const after = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, baseline);
    const changes = byPath(diffRemote(baseline, after));

    expect(changes["keep.md"]).toBeUndefined();
    expect(changes["mod.md"]).toMatchObject({ kind: "modified", oldSha: before.files[P("mod.md")].sha });
    expect(changes["gone.md"]).toMatchObject({ kind: "deleted" });
    expect(changes["new.md"]).toMatchObject({ kind: "added" });
  });

  it("detects a rename when one deletion and one addition share a sha", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "old/name.md": "same content" });
    const before = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, null);
    const baseline: Baseline = { ...emptyBaseline(), files: before.files, dirs: before.dirs };

    gh.seedChange(REPO, BRANCH, { "old/name.md": null, "new/name.md": "same content" });
    const after = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, baseline);
    const changes = diffRemote(baseline, after);

    expect(changes).toEqual([
      { kind: "renamed", oldPath: "old/name.md", path: "new/name.md", sha: before.files[P("old/name.md")].sha, mode: "100644" },
    ]);
  });

  it("does not guess renames when the sha pairing is ambiguous", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "dup", "b.md": "dup" });
    const before = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, null);
    const baseline: Baseline = { ...emptyBaseline(), files: before.files, dirs: before.dirs };

    gh.seedChange(REPO, BRANCH, { "a.md": null, "b.md": null, "c.md": "dup" });
    const after = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, baseline);
    const kinds = diffRemote(baseline, after).map(c => c.kind).sort();
    expect(kinds).toEqual(["added", "deleted", "deleted"]);
  });

  it("a mode change alone counts as modified", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "run.sh": "x" });
    const before = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, null);
    const baseline: Baseline = { ...emptyBaseline(), files: before.files, dirs: before.dirs };
    gh.seedRepo(REPO, BRANCH, { "run.sh": { content: "x", mode: "100755" } });
    const after = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, baseline);
    expect(diffRemote(baseline, after)).toMatchObject([{ kind: "modified", path: "run.sh", mode: "100755" }]);
  });

  it("with no baseline everything is added", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "a", "b/c.md": "c" });
    const snap = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, null);
    expect(diffRemote(null, snap).map(c => c.kind)).toEqual(["added", "added"]);
  });
});

describe("fetchRemoteChanges", () => {
  it("returns no changes and makes a single request when the head is unchanged", async () => {
    const gh = new FakeGitHub();
    const head = gh.seedRepo(REPO, BRANCH, { "a.md": "a" });
    const baseline = emptyBaseline(head);
    const res = await fetchRemoteChanges(gh, REPO, BRANCH, baseline);
    expect(res).toEqual({ head, snapshot: null, changes: [] });
    expect(gh.calls).toEqual({ getRef: 1 });
  });

  it("returns null head for a branch that does not exist", async () => {
    const gh = new FakeGitHub();
    const res = await fetchRemoteChanges(gh, REPO, "nope", null);
    expect(res.head).toBeNull();
    expect(res.changes).toEqual([]);
  });

  it("walks and diffs when the head moved", async () => {
    const gh = new FakeGitHub();
    const head1 = gh.seedRepo(REPO, BRANCH, { "a.md": "a" });
    const first = await walkRemoteTree(gh, REPO, gh.headTreeSha(REPO, BRANCH)!, null);
    const baseline: Baseline = { ...emptyBaseline(head1), files: first.files, dirs: first.dirs };
    const head2 = gh.seedChange(REPO, BRANCH, { "b.md": "b" });

    const res = await fetchRemoteChanges(gh, REPO, BRANCH, baseline);
    expect(res.head).toBe(head2);
    expect(res.changes).toMatchObject([{ kind: "added", path: "b.md" }]);
    expect(res.snapshot?.rootTree).toBe(gh.headTreeSha(REPO, BRANCH));
  });

  it("propagates typed errors untouched", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "a" });
    gh.nextFault = "rateLimit";
    await expect(fetchRemoteChanges(gh, REPO, BRANCH, null)).rejects.toMatchObject({ kind: "RateLimited" });
    expect(S("x")).toBe("x"); // keep helper import used
  });
});
