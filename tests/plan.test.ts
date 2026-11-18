import { describe, it, expect } from "vitest";
import { buildPlan, countDeletions } from "../src/core/plan";
import type { LocalChange, RemoteChange, SyncAction } from "../src/core/types";
import { baselineWith, emptyBaseline, P, S } from "./helpers";

const plan = (local: LocalChange[], remote: RemoteChange[], baseline = baselineWith({ "n.md": "base" })) =>
  buildPlan({ baseline, local, remote, remoteHead: S("head") });

const only = (actions: SyncAction[]): SyncAction => {
  expect(actions).toHaveLength(1);
  return actions[0];
};

const n = P("n.md");
const base = S("base");
const l1 = S("local1");
const r1 = S("remote1");

// One test per row of §5.4.
describe("buildPlan — §5.4 rows", () => {
  it("unchanged / unchanged → nothing", () => {
    expect(plan([], []).actions).toEqual([]);
  });

  it("changed / unchanged → push", () => {
    const a = only(plan([{ kind: "modified", path: n, sha: l1, oldSha: base }], []).actions);
    expect(a).toEqual({ kind: "push", path: n, sha: l1 });
  });

  it("unchanged / changed → pull", () => {
    const a = only(plan([], [{ kind: "modified", path: n, sha: r1, mode: "100644", oldSha: base }]).actions);
    expect(a).toEqual({ kind: "pull", path: n, sha: r1, mode: "100644" });
  });

  it("changed / changed, same sha → baseline only", () => {
    const a = only(plan(
      [{ kind: "modified", path: n, sha: l1, oldSha: base }],
      [{ kind: "modified", path: n, sha: l1, mode: "100644", oldSha: base }],
    ).actions);
    expect(a).toEqual({ kind: "baselineSet", path: n, sha: l1, mode: "100644" });
  });

  it("changed / changed, different → bothChanged with the base sha for a 3-way merge", () => {
    const a = only(plan(
      [{ kind: "modified", path: n, sha: l1, oldSha: base }],
      [{ kind: "modified", path: n, sha: r1, mode: "100644", oldSha: base }],
    ).actions);
    expect(a).toEqual({ kind: "bothChanged", path: n, localSha: l1, remoteSha: r1, baseSha: base, mode: "100644" });
  });

  it("deleted / unchanged → push deletion", () => {
    const a = only(plan([{ kind: "deleted", path: n, oldSha: base }], []).actions);
    expect(a).toEqual({ kind: "pushDelete", path: n });
  });

  it("unchanged / deleted → delete locally", () => {
    const a = only(plan([], [{ kind: "deleted", path: n, oldSha: base }]).actions);
    expect(a).toEqual({ kind: "pullDelete", path: n });
  });

  it("deleted / modified → resurrect remote version", () => {
    const a = only(plan(
      [{ kind: "deleted", path: n, oldSha: base }],
      [{ kind: "modified", path: n, sha: r1, mode: "100644", oldSha: base }],
    ).actions);
    expect(a).toEqual({ kind: "resurrect", path: n, sha: r1, mode: "100644" });
  });

  it("modified / deleted → keep local and push it back", () => {
    const a = only(plan(
      [{ kind: "modified", path: n, sha: l1, oldSha: base }],
      [{ kind: "deleted", path: n, oldSha: base }],
    ).actions);
    expect(a).toEqual({ kind: "keepLocal", path: n, sha: l1 });
  });

  it("added / added, different → conflict (never overwrite either)", () => {
    const x = P("x.md");
    const a = only(plan(
      [{ kind: "added", path: x, sha: l1 }],
      [{ kind: "added", path: x, sha: r1, mode: "100644" }],
    ).actions);
    expect(a).toEqual({ kind: "conflict", path: x, localSha: l1, remoteSha: r1, mode: "100644" });
  });

  it("added / added, same → baseline only", () => {
    const x = P("x.md");
    const a = only(plan(
      [{ kind: "added", path: x, sha: l1 }],
      [{ kind: "added", path: x, sha: l1, mode: "100644" }],
    ).actions);
    expect(a).toEqual({ kind: "baselineSet", path: x, sha: l1, mode: "100644" });
  });

  it("deleted / deleted → baseline cleanup only", () => {
    const a = only(plan(
      [{ kind: "deleted", path: n, oldSha: base }],
      [{ kind: "deleted", path: n, oldSha: base }],
    ).actions);
    expect(a).toEqual({ kind: "baselineRemove", path: n });
  });
});

describe("buildPlan — renames", () => {
  it("remote rename with local untouched → pullRename", () => {
    const a = only(plan([], [{ kind: "renamed", oldPath: n, path: P("m.md"), sha: base, mode: "100644" }]).actions);
    expect(a).toEqual({ kind: "pullRename", oldPath: n, path: P("m.md"), sha: base, mode: "100644" });
  });

  it("local rename with remote untouched → pushRename", () => {
    const a = only(plan([{ kind: "renamed", oldPath: n, path: P("m.md"), sha: base }], []).actions);
    expect(a).toEqual({ kind: "pushRename", oldPath: n, path: P("m.md"), sha: base });
  });

  it("remote rename while local modified the old path → decomposed: keep local edit, pull new path", () => {
    const actions = plan(
      [{ kind: "modified", path: n, sha: l1, oldSha: base }],
      [{ kind: "renamed", oldPath: n, path: P("m.md"), sha: base, mode: "100644" }],
    ).actions;
    const byPath = Object.fromEntries(actions.map(a => [a.path, a]));
    // old path: local modified, remote deleted → edits beat deletes
    expect(byPath["n.md"]).toEqual({ kind: "keepLocal", path: n, sha: l1 });
    // new path: remote added, local nothing → pull
    expect(byPath["m.md"]).toMatchObject({ kind: "pull", sha: base });
  });

  it("both sides renamed the same file to the same name → baseline only", () => {
    const m = P("m.md");
    const actions = plan(
      [{ kind: "renamed", oldPath: n, path: m, sha: base }],
      [{ kind: "renamed", oldPath: n, path: m, sha: base, mode: "100644" }],
    ).actions;
    expect(actions).toEqual(expect.arrayContaining([
      { kind: "baselineRemove", path: n },
      { kind: "baselineSet", path: m, sha: base, mode: "100644" },
    ]));
    expect(actions).toHaveLength(2);
  });
});

describe("buildPlan — first sync (no baseline)", () => {
  it("never deletes; adopts identical files, conflicts on different ones, pulls/pushes the rest", () => {
    const actions = buildPlan({
      baseline: null,
      local: [
        { kind: "added", path: P("same.md"), sha: S("s") },
        { kind: "added", path: P("diff.md"), sha: S("l") },
        { kind: "added", path: P("local-only.md"), sha: S("lo") },
      ],
      remote: [
        { kind: "added", path: P("same.md"), sha: S("s"), mode: "100644" },
        { kind: "added", path: P("diff.md"), sha: S("r"), mode: "100644" },
        { kind: "added", path: P("remote-only.md"), sha: S("ro"), mode: "100644" },
      ],
      remoteHead: S("h"),
    }).actions;
    const kinds = Object.fromEntries(actions.map(a => [a.path, a.kind]));
    expect(kinds).toEqual({
      "same.md": "baselineSet",
      "diff.md": "conflict",
      "local-only.md": "push",
      "remote-only.md": "pull",
    });
    expect(countDeletions({ actions, remoteHead: null })).toEqual({ local: 0, remote: 0 });
  });
});

describe("misc", () => {
  it("preserves 100755 mode on pull", () => {
    const a = only(plan([], [{ kind: "added", path: P("run.sh"), sha: r1, mode: "100755" }]).actions);
    expect(a).toMatchObject({ kind: "pull", mode: "100755" });
  });

  it("carries the remote head into the plan", () => {
    expect(buildPlan({ baseline: emptyBaseline(), local: [], remote: [], remoteHead: S("abc") }).remoteHead).toBe("abc");
  });

  it("countDeletions counts each side", () => {
    const p = plan(
      [{ kind: "deleted", path: P("a.md"), oldSha: base }],
      [{ kind: "deleted", path: P("b.md"), oldSha: base }, { kind: "deleted", path: P("c.md"), oldSha: base }],
      baselineWith({ "a.md": "base", "b.md": "base", "c.md": "base" }),
    );
    expect(countDeletions(p)).toEqual({ local: 2, remote: 1 });
  });
});
