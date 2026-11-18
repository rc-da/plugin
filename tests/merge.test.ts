import { describe, it, expect } from "vitest";
import {
  isTextFile, isValidUtf8, extensionOf, decodeUtf8, encodeUtf8,
  mergeText, mergeBytes, conflictCopyPath, conflictStamp, safeDeviceName, resolvePlan,
} from "../src/core/merge";
import { FakeGitHub, gitBlobShaSync } from "./fakes/fake-github";
import { FakeVault } from "./fakes/fake-vault";
import { FakeClock } from "./fakes/fake-state";
import type { SyncPlan } from "../src/core/types";
import { REPO, quietLog, P, S, text } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);

describe("text/binary classification", () => {
  it("extensionOf", () => {
    expect(extensionOf("a/b/note.MD")).toBe("md");
    expect(extensionOf("noext")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("dir.d/file.tar.gz")).toBe("gz");
  });

  it("markdown with valid UTF-8 is text", () => {
    expect(isTextFile("n.md", enc("# héllo 🌍\r\n"))).toBe(true);
  });

  it("allow-listed extension but invalid UTF-8 is binary", () => {
    expect(isTextFile("n.md", new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false);
  });

  it("allow-listed extension with a NUL byte is binary", () => {
    expect(isTextFile("n.txt", new Uint8Array([0x41, 0x00, 0x42]))).toBe(false);
  });

  it("non-allow-listed extensions are binary even if they decode", () => {
    expect(isTextFile("img.png", enc("not really"))).toBe(false);
    expect(isTextFile("noext", enc("text"))).toBe(false);
  });

  it("a UTF-8 BOM is valid and survives a decode/encode round trip", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    expect(isValidUtf8(withBom)).toBe(true);
    expect(encodeUtf8(decodeUtf8(withBom))).toEqual(withBom);
  });

  it("empty file is text", () => {
    expect(isTextFile("empty.md", new Uint8Array(0))).toBe(true);
  });

  it("truncated multi-byte sequence at the end is invalid", () => {
    expect(isValidUtf8(new Uint8Array([0x68, 0xe2, 0x82]))).toBe(false);
  });
});

describe("mergeText", () => {
  const base = "line1\nline2\nline3\nline4\nline5\n";

  it("merges edits to different parts of the file", () => {
    const local = "line1 edited by A\nline2\nline3\nline4\nline5\n";
    const remote = "line1\nline2\nline3\nline4\nline5 edited by B\n";
    expect(mergeText(base, local, remote)).toEqual({ ok: true, merged: "line1 edited by A\nline2\nline3\nline4\nline5 edited by B\n" });
  });

  it("merges an insertion with a deletion elsewhere", () => {
    const local = "line1\nnew after 1\nline2\nline3\nline4\nline5\n";
    const remote = "line1\nline2\nline3\nline5\n";
    expect(mergeText(base, local, remote)).toEqual({ ok: true, merged: "line1\nnew after 1\nline2\nline3\nline5\n" });
  });

  it("merges appends on both sides at the end as a conflict only when adjacent", () => {
    // Both appended different lines at the very end: diff3 cannot order them → conflict.
    const local = base + "A's line\n";
    const remote = base + "B's line\n";
    expect(mergeText(base, local, remote).ok).toBe(false);
  });

  it("overlapping edits to the same line are a conflict", () => {
    const local = "line1\nline2 A\nline3\nline4\nline5\n";
    const remote = "line1\nline2 B\nline3\nline4\nline5\n";
    expect(mergeText(base, local, remote)).toEqual({ ok: false, reason: "overlapping edits" });
  });

  it("identical edits on both sides are not a conflict", () => {
    const both = "line1\nsame change\nline3\nline4\nline5\n";
    expect(mergeText(base, both, both)).toEqual({ ok: true, merged: both });
  });

  it("one side unchanged takes the other side verbatim", () => {
    const remote = "totally\ndifferent";
    expect(mergeText(base, base, remote)).toEqual({ ok: true, merged: remote });
    expect(mergeText(base, remote, base)).toEqual({ ok: true, merged: remote });
  });

  it("preserves CRLF line endings and a missing final newline", () => {
    const b = "a\r\nb\r\nc";
    const l = "a edited\r\nb\r\nc";
    const r = "a\r\nb\r\nc edited";
    expect(mergeText(b, l, r)).toEqual({ ok: true, merged: "a edited\r\nb\r\nc edited" });
  });

  it("whitespace-only and empty files", () => {
    expect(mergeText("", "x\n", "")).toEqual({ ok: true, merged: "x\n" });
    expect(mergeText("  \n", "  \n", "  \n\n")).toEqual({ ok: true, merged: "  \n\n" });
  });
});

describe("mergeBytes", () => {
  it("merges text files and returns bytes", () => {
    const r = mergeBytes("n.md", enc("a\nb\nc\n"), enc("A\nb\nc\n"), enc("a\nb\nC\n"));
    expect(r.ok).toBe(true);
    expect(text(r.bytes)).toBe("A\nb\nC\n");
  });

  it("any binary side makes it a conflict", () => {
    expect(mergeBytes("n.md", new Uint8Array([0, 1]), enc("a"), enc("b")).ok).toBe(false);
    expect(mergeBytes("img.png", enc("a"), enc("b"), enc("c")).ok).toBe(false);
  });

  it("JSON/canvas must still parse after merging", () => {
    const base = '{\n  "a": 1,\n  "m": 0,\n  "b": 2\n}';
    // Both edit different keys (separated by an unchanged line); clean merge AND valid JSON.
    const ok = mergeBytes("x.canvas", enc(base), enc('{\n  "a": 10,\n  "m": 0,\n  "b": 2\n}'), enc('{\n  "a": 1,\n  "m": 0,\n  "b": 20\n}'));
    expect(ok.ok).toBe(true);
    expect(JSON.parse(text(ok.bytes)!)).toEqual({ a: 10, m: 0, b: 20 });

    // Textually clean but syntactically broken: local removes the last key (and the
    // comma above it), remote appends a key after it → dangling comma.
    const base2 = '{\n  "a": 1,\n  "b": 2\n}';
    const local2 = '{\n  "a": 1\n}';
    const remote2 = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}';
    const r = mergeBytes("x.json", enc(base2), enc(local2), enc(remote2));
    if (r.ok) expect(() => JSON.parse(r.merged)).not.toThrow(); // if diff3 produced valid JSON that's fine too
    else expect(r.reason).toMatch(/JSON|overlapping/);
  });

  it("invalid merged JSON is reported as such", () => {
    const base = '["a",\n"b",\n"c",\n"d",\n"e"]';
    const local = '["a",\n"b"\n]';                   // dropped tail, closed early
    const remote = '["a",\n"b",\n"c",\n"d",\n"e",\n"f"]'; // appended
    const r = mergeBytes("x.json", enc(base), enc(local), enc(remote));
    expect(r.ok).toBe(false);
  });
});

describe("conflict copy naming", () => {
  it("formats the stamp in local time as YYYY-MM-DD HHmm", () => {
    const d = new Date(2026, 10, 14, 9, 5); // local
    expect(conflictStamp(d.getTime())).toBe("2026-11-14 0905");
  });

  it("sanitizes device names", () => {
    expect(safeDeviceName('My "Phone": v2/beta?')).toBe("My -Phone-- v2-beta-");
    expect(safeDeviceName("   ")).toBe("device");
  });

  it("builds the name next to the file and avoids taken names", async () => {
    const t = new Date(2026, 10, 14, 9, 5).getTime();
    const taken = new Set(["notes/a (conflict phone 2026-11-14 0905).md"]);
    const p = await conflictCopyPath(P("notes/a.md"), "phone", t, async c => taken.has(c));
    expect(p).toBe("notes/a (conflict phone 2026-11-14 0905) 2.md");
    expect(await conflictCopyPath(P("noext"), "phone", t, async () => false)).toBe("noext (conflict phone 2026-11-14 0905)");
    expect(await conflictCopyPath(P(".hidden"), "phone", t, async () => false)).toBe(".hidden (conflict phone 2026-11-14 0905)");
  });
});

describe("resolvePlan", () => {
  function setup() {
    const gh = new FakeGitHub();
    const vault = new FakeVault();
    const deps = { vault, remote: gh, repo: REPO, clock: new FakeClock(), deviceName: "dev", log: quietLog };
    return { gh, vault, deps };
  }

  it("turns a mergeable bothChanged into merge with the merged bytes", async () => {
    const { gh, vault, deps } = setup();
    const baseSha = gh.seedBlob("a\nb\nc\n");
    const remoteSha = gh.seedBlob("a\nb\nC\n");
    vault.seed("n.md", "A\nb\nc\n");
    const plan: SyncPlan = { remoteHead: null, actions: [{ kind: "bothChanged", path: P("n.md"), localSha: gitBlobShaSync(enc("A\nb\nc\n")), remoteSha, baseSha, mode: "100644" }] };
    const { plan: out, stats } = await resolvePlan(plan, deps);
    expect(stats).toEqual({ merged: 1, conflicts: 0 });
    expect(out.actions[0]).toMatchObject({ kind: "merge", path: "n.md", remoteSha });
    expect(text((out.actions[0] as { merged: Uint8Array }).merged)).toBe("A\nb\nC\n");
  });

  it("turns overlapping edits into a conflict with a conflict path", async () => {
    const { gh, vault, deps } = setup();
    const baseSha = gh.seedBlob("x\n");
    const remoteSha = gh.seedBlob("remote\n");
    vault.seed("n.md", "local\n");
    const plan: SyncPlan = { remoteHead: null, actions: [{ kind: "bothChanged", path: P("n.md"), localSha: S("l"), remoteSha, baseSha, mode: "100644" }] };
    const { plan: out, stats } = await resolvePlan(plan, deps);
    expect(stats).toEqual({ merged: 0, conflicts: 1 });
    expect(out.actions[0]).toMatchObject({ kind: "conflict", path: "n.md", conflictPath: expect.stringMatching(/^n \(conflict dev .*\)\.md$/) });
  });

  it("binary both-changed is a conflict without fetching blobs", async () => {
    const { gh, vault, deps } = setup();
    vault.seed("img.png", new Uint8Array([1, 2]));
    const plan: SyncPlan = { remoteHead: null, actions: [{ kind: "bothChanged", path: P("img.png"), localSha: S("l"), remoteSha: S("r"), baseSha: S("b"), mode: "100644" }] };
    const { plan: out } = await resolvePlan(plan, deps);
    expect(out.actions[0].kind).toBe("conflict");
    expect(gh.calls.getBlob).toBeUndefined();
  });

  it("no base sha → conflict", async () => {
    const { vault, deps } = setup();
    vault.seed("n.md", "x");
    const plan: SyncPlan = { remoteHead: null, actions: [{ kind: "bothChanged", path: P("n.md"), localSha: S("l"), remoteSha: S("r"), baseSha: null, mode: "100644" }] };
    expect((await resolvePlan(plan, deps)).plan.actions[0].kind).toBe("conflict");
  });

  it("local now equal to remote (user already typed the same) → baselineSet", async () => {
    const { gh, vault, deps } = setup();
    const remoteSha = gh.seedBlob("same\n");
    vault.seed("n.md", "same\n");
    const plan: SyncPlan = { remoteHead: null, actions: [{ kind: "bothChanged", path: P("n.md"), localSha: S("stale"), remoteSha, baseSha: S("b"), mode: "100644" }] };
    expect((await resolvePlan(plan, deps)).plan.actions[0]).toEqual({ kind: "baselineSet", path: "n.md", sha: remoteSha, mode: "100644" });
  });

  it("two conflicts on the same file name in one plan get distinct copy paths", async () => {
    const { vault, deps } = setup();
    vault.seed("a.md", "l");
    vault.seed("sub/a.md", "l");
    const plan: SyncPlan = { remoteHead: null, actions: [
      { kind: "conflict", path: P("a.md"), localSha: S("l"), remoteSha: S("r"), mode: "100644" },
      { kind: "conflict", path: P("sub/a.md"), localSha: S("l"), remoteSha: S("r"), mode: "100644" },
    ] };
    const { plan: out } = await resolvePlan(plan, deps);
    const paths = out.actions.map(a => (a as { conflictPath: string }).conflictPath);
    expect(paths[0]).toMatch(/^a \(conflict/);
    expect(paths[1]).toMatch(/^sub\/a \(conflict/);
  });

  it("network errors while fetching blobs propagate", async () => {
    const { gh, vault, deps } = setup();
    vault.seed("n.md", "local\n");
    gh.nextFault = "offline";
    const plan: SyncPlan = { remoteHead: null, actions: [{ kind: "bothChanged", path: P("n.md"), localSha: S("l"), remoteSha: S("r"), baseSha: S("b"), mode: "100644" }] };
    await expect(resolvePlan(plan, deps)).rejects.toMatchObject({ kind: "Offline" });
  });
});
