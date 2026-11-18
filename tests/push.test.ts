import { describe, it, expect, vi } from "vitest";
import { FakeGitHub, gitBlobShaSync } from "./fakes/fake-github";
import { FakeVault } from "./fakes/fake-vault";
import { pushPlan, renderCommitMessage, type PushDeps } from "../src/core/push";
import { walkRemoteTree } from "../src/core/remote-diff";
import type { Baseline, SyncAction, SyncPlan } from "../src/core/types";
import { REPO, BRANCH, emptyBaseline, quietLog, P, S, text } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);
const plan = (...actions: SyncAction[]): SyncPlan => ({ actions, remoteHead: null });

async function setup(remoteFiles: Record<string, string | Uint8Array> = {}) {
  const gh = new FakeGitHub();
  const head = gh.seedRepo(REPO, BRANCH, remoteFiles);
  const tree = gh.headTreeSha(REPO, BRANCH)!;
  const snap = await walkRemoteTree(gh, REPO, tree, null);
  const baseline: Baseline = { ...emptyBaseline(head), files: snap.files, dirs: snap.dirs };
  const vault = new FakeVault();
  const deps = (extra: Partial<PushDeps> = {}): PushDeps => ({
    vault, remote: gh, repo: REPO, branch: BRANCH, baseline,
    parentCommit: head, parentTree: tree, message: "msg", log: quietLog, ...extra,
  });
  return { gh, vault, baseline, head, tree, deps };
}

describe("pushPlan", () => {
  it("returns null and makes no requests when there is nothing to push", async () => {
    const { gh, deps } = await setup({ "a.md": "a" });
    gh.calls = {};
    const r = await pushPlan(plan({ kind: "pull", path: P("a.md"), sha: S("x"), mode: "100644" }), deps());
    expect(r).toBeNull();
    expect(gh.calls).toEqual({});
  });

  it("pushes text inline (no blob request), commits on the parent and fast-forwards the ref", async () => {
    const { gh, vault, head, deps } = await setup({ "keep.md": "k" });
    vault.seed("new.md", "hello\r\nworld");
    const r = await pushPlan(plan({ kind: "push", path: P("new.md"), sha: S("ignored") }), deps());

    expect(r).not.toBeNull();
    expect(gh.calls.postBlob).toBeUndefined();
    expect(gh.calls.postTree).toBe(1);
    expect(gh.calls.postCommit).toBe(1);
    expect(gh.calls.updateRef).toBe(1);
    const files = await gh.snapshotFiles(REPO, BRANCH);
    expect(text(files.get("new.md"))).toBe("hello\r\nworld"); // CRLF preserved
    expect(text(files.get("keep.md"))).toBe("k");
    expect((await gh.getRef(REPO, BRANCH))!.sha).toBe(r!.commitSha);
    expect((await gh.getCommit(REPO, r!.commitSha)).message).toBe("msg");
    expect(r!.written).toEqual([{ path: "new.md", sha: gitBlobShaSync(enc("hello\r\nworld")), mode: "100644" }]);
    expect(head).not.toBe(r!.commitSha);
  });

  it("uploads binaries as blobs, byte-identical, with throttling", async () => {
    const { gh, vault, deps } = await setup();
    const bin = new Uint8Array([0, 1, 2, 255, 0, 10]);
    vault.seed("img.png", bin);
    const throttle = vi.fn(async () => {});
    await pushPlan(plan({ kind: "push", path: P("img.png"), sha: S("x") }), deps({ throttle }));
    expect(gh.calls.postBlob).toBe(1);
    expect(throttle).toHaveBeenCalledTimes(1);
    expect((await gh.snapshotFiles(REPO, BRANCH)).get("img.png")).toEqual(bin);
  });

  it("a .md file with invalid UTF-8 goes as a blob, not inline", async () => {
    const { gh, vault, deps } = await setup();
    const bytes = new Uint8Array([0x61, 0xff, 0x62]);
    vault.seed("weird.md", bytes);
    await pushPlan(plan({ kind: "push", path: P("weird.md"), sha: S("x") }), deps());
    expect(gh.calls.postBlob).toBe(1);
    expect((await gh.snapshotFiles(REPO, BRANCH)).get("weird.md")).toEqual(bytes);
  });

  it("records the sha of what was actually read, even if the file changed after planning", async () => {
    const { vault, deps } = await setup();
    vault.seed("a.md", "final content");
    const r = await pushPlan(plan({ kind: "push", path: P("a.md"), sha: S("stale-planned-sha") }), deps());
    expect(r!.written[0].sha).toBe(gitBlobShaSync(enc("final content")));
  });

  it("pushes deletions and keeps other files", async () => {
    const { gh, deps } = await setup({ "a.md": "a", "b.md": "b" });
    const r = await pushPlan(plan({ kind: "pushDelete", path: P("a.md") }), deps());
    expect([...(await gh.snapshotFiles(REPO, BRANCH)).keys()]).toEqual(["b.md"]);
    expect(r!.removed).toEqual(["a.md"]);
  });

  it("a rename with unchanged content reuses the existing blob and uploads nothing", async () => {
    const { gh, vault, baseline, deps } = await setup({ "old.md": "same" });
    vault.seed("new.md", "same");
    const read = vi.spyOn(vault, "readBytes");
    const sha = baseline.files[P("old.md")].sha;
    const r = await pushPlan(plan({ kind: "pushRename", oldPath: P("old.md"), path: P("new.md"), sha }), deps());
    expect(read).not.toHaveBeenCalled();
    expect(gh.calls.postBlob).toBeUndefined();
    const files = await gh.snapshotFiles(REPO, BRANCH);
    expect([...files.keys()]).toEqual(["new.md"]);
    expect(r!.removed).toEqual(["old.md"]);
    expect(r!.written).toEqual([{ path: "new.md", sha, mode: "100644" }]);
  });

  it("a rename with edited content uploads the new content", async () => {
    const { gh, vault, deps } = await setup({ "old.md": "v1" });
    vault.seed("new.md", "v2");
    await pushPlan(plan({ kind: "pushRename", oldPath: P("old.md"), path: P("new.md"), sha: gitBlobShaSync(enc("v2")) }), deps());
    const files = await gh.snapshotFiles(REPO, BRANCH);
    expect(text(files.get("new.md"))).toBe("v2");
    expect(files.has("old.md")).toBe(false);
  });

  it("keepLocal pushes the local file back", async () => {
    const { gh, vault, deps } = await setup();
    vault.seed("a.md", "mine");
    await pushPlan(plan({ kind: "keepLocal", path: P("a.md"), sha: S("x") }), deps());
    expect(text((await gh.snapshotFiles(REPO, BRANCH)).get("a.md"))).toBe("mine");
  });

  it("merge pushes the merged bytes", async () => {
    const { gh, deps } = await setup({ "a.md": "base" });
    await pushPlan(plan({ kind: "merge", path: P("a.md"), merged: enc("merged"), localSha: S("l"), remoteSha: S("r"), mode: "100644" }), deps());
    expect(text((await gh.snapshotFiles(REPO, BRANCH)).get("a.md"))).toBe("merged");
  });

  it("conflict pushes the local file at its path and the remote blob at the conflict path without uploading", async () => {
    const { gh, vault, baseline, deps } = await setup({ "n.md": "remote version" });
    vault.seed("n.md", "local version");
    vault.seed("n (conflict A 2026-11-14 0900).md", "remote version");
    const remoteSha = baseline.files[P("n.md")].sha;
    gh.calls = {};
    const r = await pushPlan(plan({
      kind: "conflict", path: P("n.md"), localSha: S("l"), remoteSha, mode: "100644",
      conflictPath: P("n (conflict A 2026-11-14 0900).md"),
    }), deps());
    expect(gh.calls.postBlob).toBeUndefined();
    const files = await gh.snapshotFiles(REPO, BRANCH);
    expect(text(files.get("n.md"))).toBe("local version");
    expect(text(files.get("n (conflict A 2026-11-14 0900).md"))).toBe("remote version");
    expect(r!.written.map(w => w.path).sort()).toEqual(["n (conflict A 2026-11-14 0900).md", "n.md"]);
  });

  it("preserves 100755 from the baseline", async () => {
    const { gh, vault, deps } = await setup({ "run.sh": { content: "v1", mode: "100755" } as never });
    vault.seed("run.sh", "v2");
    await pushPlan(plan({ kind: "push", path: P("run.sh"), sha: S("x") }), deps());
    const tree = await gh.getTree(REPO, gh.headTreeSha(REPO, BRANCH)!);
    expect(tree.entries.find(e => e.name === "run.sh")!.mode).toBe("100755");
  });

  it("a file that vanished before pushing is skipped; the rest is pushed", async () => {
    const { gh, vault, deps } = await setup();
    vault.seed("b.md", "b");
    const r = await pushPlan(plan(
      { kind: "push", path: P("gone.md"), sha: S("x") },
      { kind: "push", path: P("b.md"), sha: S("y") },
    ), deps());
    expect(r!.skipped).toEqual([{ path: "gone.md", reason: "file disappeared before it could be pushed" }]);
    expect([...(await gh.snapshotFiles(REPO, BRANCH)).keys()]).toEqual(["b.md"]);
  });

  it("if every action is skipped, no commit is made", async () => {
    const { gh, deps } = await setup({ "a.md": "a" });
    gh.calls = {};
    const r = await pushPlan(plan({ kind: "push", path: P("gone.md"), sha: S("x") }), deps());
    expect(r).toBeNull();
    expect(gh.calls.postTree).toBeUndefined();
  });

  it("splits large pushes into chained tree requests", async () => {
    const { gh, vault, deps } = await setup({ "existing.md": "e" });
    const files: Record<string, string> = {};
    const actions: SyncAction[] = [];
    for (let i = 0; i < 12; i++) {
      files[`f${i}.md`] = `content ${i}`;
      vault.seed(`f${i}.md`, files[`f${i}.md`]);
      actions.push({ kind: "push", path: P(`f${i}.md`), sha: S("x") });
    }
    await pushPlan(plan(...actions), deps({ maxEntries: 5 }));
    expect(gh.calls.postTree).toBe(3); // 5 + 5 + 2
    expect(gh.calls.postCommit).toBe(1);
    const snap = await gh.snapshotFiles(REPO, BRANCH);
    expect(snap.size).toBe(13);
    for (const [p, c] of Object.entries(files)) expect(text(snap.get(p))).toBe(c);
  });

  it("splits by body size too", async () => {
    const { gh, vault, deps } = await setup();
    const actions: SyncAction[] = [];
    for (let i = 0; i < 4; i++) {
      vault.seed(`f${i}.md`, "x".repeat(1000));
      actions.push({ kind: "push", path: P(`f${i}.md`), sha: S("x") });
    }
    await pushPlan(plan(...actions), deps({ maxBodyBytes: 2500 }));
    expect(gh.calls.postTree).toBe(2);
  });

  it("throws Conflict422 untouched when the ref moved", async () => {
    const { gh, vault, deps } = await setup({ "a.md": "a" });
    vault.seed("b.md", "b");
    gh.seedChange(REPO, BRANCH, { "other.md": "other device" });
    await expect(pushPlan(plan({ kind: "push", path: P("b.md"), sha: S("x") }), deps()))
      .rejects.toMatchObject({ kind: "Conflict422" });
  });

  it("network errors abort instead of being swallowed as skips", async () => {
    const { gh, vault, deps } = await setup();
    vault.seed("img.png", new Uint8Array([1]));
    gh.nextFault = "serverError";
    await expect(pushPlan(plan({ kind: "push", path: P("img.png"), sha: S("x") }), deps()))
      .rejects.toMatchObject({ kind: "ServerError" });
  });

  it("refuses to proceed if the uploaded blob sha differs from the local hash", async () => {
    const { gh, vault, deps } = await setup();
    vault.seed("img.png", new Uint8Array([1]));
    vi.spyOn(gh, "postBlob").mockResolvedValue(S("deadbeef"));
    const r = await pushPlan(plan({ kind: "push", path: P("img.png"), sha: S("x") }), deps());
    expect(r).toBeNull();
  });
});

describe("renderCommitMessage", () => {
  it("fills all placeholders", () => {
    expect(renderCommitMessage("{{ device }}: {{count}} @ {{date}}", { device: "phone", date: "2026-11-14", count: 3 }))
      .toBe("phone: 3 @ 2026-11-14");
  });
});
