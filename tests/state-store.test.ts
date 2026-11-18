import { describe, it, expect } from "vitest";
import { MemoryKv, StateStore, vaultInstanceId, type KvBackend } from "../src/adapters/state-store";
import { SyncError } from "../src/core/types";
import { baselineWith, P, S, REPO, BRANCH } from "./helpers";

describe("StateStore (§4)", () => {
  it("round-trips baseline, cache, conflicts and etags", async () => {
    const s = new StateStore(new MemoryKv());
    const b = baselineWith({ "a.md": "s1" }, S("h"));
    await s.saveBaseline(b);
    await s.saveLocalCache({ [P("a.md")]: { mtime: 1, size: 2, sha: S("s1") } });
    await s.saveConflicts([{ path: P("a.md"), conflictPath: P("a (conflict).md"), localSha: S("l"), remoteSha: S("r"), timestamp: 5 }]);
    await s.saveRefPoll(REPO, BRANCH, { sha: S("h"), etag: "W/\"e\"" });
    expect(await s.loadBaseline(REPO, BRANCH)).toEqual(b);
    expect((await s.loadLocalCache())[P("a.md")].sha).toBe("s1");
    expect(await s.loadConflicts()).toHaveLength(1);
    expect(await s.loadRefPoll(REPO, BRANCH)).toEqual({ sha: "h", etag: "W/\"e\"" });
    expect(await s.loadRefPoll(REPO, "other")).toBeNull();
  });

  it("saves a snapshot: later in-place mutation by core does not leak into storage", async () => {
    const s = new StateStore(new MemoryKv());
    const b = baselineWith({ "a.md": "s1" });
    await s.saveBaseline(b);
    b.files[P("b.md")] = { sha: S("s2"), mode: "100644" };
    expect(Object.keys((await s.loadBaseline(REPO, BRANCH))!.files)).toEqual(["a.md"]);
  });

  it("empty or corrupt state loads as absent (first-sync mode, never deletions)", async () => {
    const kv = new MemoryKv();
    const s = new StateStore(kv);
    expect(await s.loadBaseline(REPO, BRANCH)).toBeNull();
    expect(await s.loadLocalCache()).toEqual({});
    expect(await s.loadConflicts()).toEqual([]);
    await kv.set("baseline", { v: 1, data: { repo: REPO } });       // truncated
    expect(await s.loadBaseline(REPO, BRANCH)).toBeNull();
    await kv.set("baseline", { v: 99, data: baselineWith({}) });     // future schema
    expect(await s.loadBaseline(REPO, BRANCH)).toBeNull();
    await kv.set("cache", "garbage");
    expect(await s.loadLocalCache()).toEqual({});
  });

  it("a backend that throws on read degrades to absent; on write it is a typed error", async () => {
    const broken: KvBackend = {
      get: async () => { throw new Error("IDB gone"); },
      set: async () => { throw Object.assign(new Error("full"), { name: "QuotaExceededError" }); },
      delete: async () => {},
    };
    const s = new StateStore(broken);
    expect(await s.loadBaseline(REPO, BRANCH)).toBeNull();
    const e = await s.saveBaseline(baselineWith({})).catch(x => x);
    expect(e).toBeInstanceOf(SyncError);
    expect(e.message).toMatch(/QuotaExceededError/);
  });

  it("clear() forgets the baseline", async () => {
    const s = new StateStore(new MemoryKv());
    await s.saveBaseline(baselineWith({ "a.md": "s" }));
    await s.clear();
    expect(await s.loadBaseline(REPO, BRANCH)).toBeNull();
  });

  it("vault instance id is created once and reused", () => {
    const store = new Map<string, unknown>();
    const load = (k: string) => store.get(k) ?? null;
    const save = (k: string, v: string) => { store.set(k, v); };
    const id = vaultInstanceId(load, save, () => 0.5);
    expect(id).toMatch(/^[0-9a-z]{16}$/);
    expect(vaultInstanceId(load, save, () => 0.1)).toBe(id);
  });
});
