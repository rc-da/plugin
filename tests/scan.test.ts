import { describe, it, expect, vi } from "vitest";
import { FakeVault } from "./fakes/fake-vault";
import { gitBlobShaSync } from "./fakes/fake-github";
import { scanLocal, compactRenames, diffLocal } from "../src/core/scan";
import { buildExcluder } from "../src/core/paths";
import type { Baseline, LocalCache } from "../src/core/types";
import { baselineWith, emptyBaseline, P } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (s: string) => gitBlobShaSync(enc(s));
const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync" });

const scan = (vault: FakeVault, baseline: Baseline | null, cache: LocalCache = {}, extra = {}) =>
  scanLocal({ vault, baseline, cache, exclude, ...extra });

describe("scanLocal — change detection", () => {
  it("with no baseline everything is added, with git blob shas", async () => {
    const vault = new FakeVault();
    vault.seed("a.md", "a");
    vault.seed("dir/b.md", "b");
    const r = await scan(vault, null);
    expect(r.changes).toEqual(expect.arrayContaining([
      { kind: "added", path: "a.md", sha: sha("a") },
      { kind: "added", path: "dir/b.md", sha: sha("b") },
    ]));
    expect(r.changes).toHaveLength(2);
    expect(r.files[P("a.md")]).toEqual({ sha: sha("a"), mode: "100644" });
  });

  it("detects modified and deleted relative to the baseline, nothing for unchanged", async () => {
    const vault = new FakeVault();
    vault.seed("same.md", "s");
    vault.seed("mod.md", "new");
    const baseline = baselineWith({ "same.md": sha("s"), "mod.md": sha("old"), "gone.md": sha("g") });
    const r = await scan(vault, baseline);
    expect(r.changes).toEqual(expect.arrayContaining([
      { kind: "modified", path: "mod.md", sha: sha("new"), oldSha: sha("old") },
      { kind: "deleted", path: "gone.md", oldSha: sha("g") },
    ]));
    expect(r.changes).toHaveLength(2);
  });

  it("keeps the baseline's 100755 mode for local files", async () => {
    const vault = new FakeVault();
    vault.seed("run.sh", "x");
    const baseline = baselineWith({ "run.sh": { sha: sha("x"), mode: "100755" } });
    const r = await scan(vault, baseline);
    expect(r.files[P("run.sh")].mode).toBe("100755");
  });

  it("normalizes NFD paths to NFC keys", async () => {
    const vault = new FakeVault();
    vault.seed("Café.md", "x");
    const r = await scan(vault, null);
    expect(Object.keys(r.files)).toEqual(["Café.md"]);
  });

  it("records stats for every scanned file", async () => {
    const vault = new FakeVault();
    vault.seed("a.md", "abc", 42);
    const r = await scan(vault, null);
    expect(r.stats.get(P("a.md"))).toEqual({ mtime: 42, size: 3 });
  });
});

describe("scanLocal — cache", () => {
  it("does not read files whose (mtime, size) match the cache", async () => {
    const vault = new FakeVault();
    vault.seed("a.md", "aaa", 10);
    vault.seed("b.md", "bbb", 11);
    const cache: LocalCache = { [P("a.md")]: { mtime: 10, size: 3, sha: sha("aaa") } };
    const read = vi.spyOn(vault, "readBytes");
    const r = await scan(vault, null, cache);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("b.md");
    expect(r.cache[P("b.md")]).toEqual({ mtime: 11, size: 3, sha: sha("bbb") });
  });

  it("re-hashes when mtime changed even if size is equal", async () => {
    const vault = new FakeVault();
    vault.seed("a.md", "abd", 20);
    const cache: LocalCache = { [P("a.md")]: { mtime: 10, size: 3, sha: sha("abc") } };
    const r = await scan(vault, null, cache);
    expect(r.files[P("a.md")].sha).toBe(sha("abd"));
  });

  it("re-hashes when size changed even if mtime is equal (clock granularity)", async () => {
    const vault = new FakeVault();
    vault.seed("a.md", "abcd", 10);
    const cache: LocalCache = { [P("a.md")]: { mtime: 10, size: 3, sha: sha("abc") } };
    const r = await scan(vault, null, cache);
    expect(r.files[P("a.md")].sha).toBe(sha("abcd"));
  });

  it("prunes cache entries for files that no longer exist", async () => {
    const vault = new FakeVault();
    vault.seed("a.md", "a", 1);
    const cache: LocalCache = {
      [P("a.md")]: { mtime: 1, size: 1, sha: sha("a") },
      [P("gone.md")]: { mtime: 1, size: 1, sha: sha("g") },
    };
    const r = await scan(vault, null, cache);
    expect(Object.keys(r.cache)).toEqual(["a.md"]);
  });

  it("yields to the host every N hashed files", async () => {
    const vault = new FakeVault();
    for (let i = 0; i < 7; i++) vault.seed(`f${i}.md`, `${i}`);
    const yieldToHost = vi.fn(async () => {});
    await scan(vault, null, {}, { yieldEvery: 3, yieldToHost });
    expect(yieldToHost).toHaveBeenCalledTimes(2);
  });
});

describe("scanLocal — excludes and size limit", () => {
  it("never reads excluded files", async () => {
    const vault = new FakeVault();
    vault.seed(".obsidian/workspace.json", "{}");
    vault.seed(".DS_Store", "junk");
    vault.seed("note.md", "n");
    const read = vi.spyOn(vault, "readBytes");
    const r = await scan(vault, null);
    expect(Object.keys(r.files)).toEqual(["note.md"]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a baseline file that is now excluded is NOT reported as deleted", async () => {
    const vault = new FakeVault();
    vault.seed("Private/secret.md", "s");
    const baseline = baselineWith({ "Private/secret.md": sha("s") });
    const ex = buildExcluder({ configDir: ".obsidian", pluginId: "x", userPatterns: ["Private/"] });
    const r = await scanLocal({ vault, baseline, cache: {}, exclude: ex });
    expect(r.changes).toEqual([]);
  });

  it("skips files over the size limit without reading them, and never treats them as deleted", async () => {
    const vault = new FakeVault();
    vault.seed("big.bin", new Uint8Array(100));
    vault.seed("ok.md", "ok");
    const baseline = baselineWith({ "big.bin": sha("whatever") });
    const read = vi.spyOn(vault, "readBytes");
    const r = await scan(vault, baseline, {}, { maxFileBytes: 50 });
    expect(r.skipped).toEqual([{ path: "big.bin", reason: "larger than the 50 byte limit" }]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(r.changes).toEqual([{ kind: "added", path: "ok.md", sha: sha("ok") }]);
  });
});

describe("scanLocal — renames", () => {
  it("uses the host's rename log when old path was synced and new path exists", async () => {
    const vault = new FakeVault();
    vault.seed("new.md", "edited after rename");
    const baseline = baselineWith({ "old.md": sha("original") });
    const r = await scan(vault, baseline, {}, { pendingRenames: [{ from: P("old.md"), to: P("new.md") }] });
    expect(r.changes).toEqual([{ kind: "renamed", oldPath: "old.md", path: "new.md", sha: sha("edited after rename") }]);
  });

  it("infers a rename from one deletion and one addition with identical content", async () => {
    const vault = new FakeVault();
    vault.seed("b/moved.md", "same");
    const baseline = baselineWith({ "a/moved.md": sha("same") });
    const r = await scan(vault, baseline);
    expect(r.changes).toEqual([{ kind: "renamed", oldPath: "a/moved.md", path: "b/moved.md", sha: sha("same") }]);
  });

  it("a folder rename becomes one rename per file, zero deletions", async () => {
    const vault = new FakeVault();
    vault.seed("new/one.md", "1");
    vault.seed("new/two.md", "2");
    const baseline = baselineWith({ "old/one.md": sha("1"), "old/two.md": sha("2") });
    const r = await scan(vault, baseline, {}, {
      pendingRenames: [{ from: P("old/one.md"), to: P("new/one.md") }, { from: P("old/two.md"), to: P("new/two.md") }],
    });
    expect(r.changes.map(c => c.kind)).toEqual(["renamed", "renamed"]);
  });

  it("case-only rename is a rename, not delete+add", async () => {
    const vault = new FakeVault({ caseInsensitive: true });
    vault.seed("Note.md", "x");
    const baseline = baselineWith({ "note.md": sha("x") });
    const r = await scan(vault, baseline, {}, { pendingRenames: [{ from: P("note.md"), to: P("Note.md") }] });
    expect(r.changes).toEqual([{ kind: "renamed", oldPath: "note.md", path: "Note.md", sha: sha("x") }]);
  });

  it("ignores a stale rename record whose target is gone or whose source was never synced", async () => {
    const vault = new FakeVault();
    vault.seed("c.md", "c");
    const baseline = baselineWith({ "a.md": sha("a") });
    const r = await scan(vault, baseline, {}, {
      pendingRenames: [{ from: P("a.md"), to: P("b.md") }, { from: P("x.md"), to: P("c.md") }],
    });
    expect(r.changes).toEqual(expect.arrayContaining([
      { kind: "deleted", path: "a.md", oldSha: sha("a") },
      { kind: "added", path: "c.md", sha: sha("c") },
    ]));
  });

  it("compactRenames folds chains and drops round trips", () => {
    const m = compactRenames([
      { from: P("a"), to: P("b") }, { from: P("b"), to: P("c") },
      { from: P("x"), to: P("y") }, { from: P("y"), to: P("x") },
    ]);
    expect([...m]).toEqual([["a", "c"]]);
  });

  it("diffLocal does not infer renames when pairing is ambiguous", () => {
    const base = baselineWith({ "a.md": sha("d"), "b.md": sha("d") }).files;
    const files = { [P("c.md")]: { sha: sha("d"), mode: "100644" as const } };
    const kinds = diffLocal(base, files, { renames: new Map(), ignoreMissing: () => false }).map(c => c.kind).sort();
    expect(kinds).toEqual(["added", "deleted", "deleted"]);
    expect(emptyBaseline().files).toEqual({});
  });
});
