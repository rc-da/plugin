import { describe, it, expect } from "vitest";
import { SyncController, type ControllerDeps } from "../src/sync-controller";
import type { SyncDeps } from "../src/core/sync";
import { SyncError, type SyncResult } from "../src/core/types";
import type { StatusState } from "../src/ui/status-model";
import { quietLog, P } from "./helpers";

const ok = (patch: Partial<SyncResult> = {}): SyncResult => ({
  status: "ok", pulled: 1, pushed: 2, deleted: 0, renamed: 0, conflicts: 0, merged: 0,
  skipped: [], errors: [], remoteHead: null, attempts: 1, wroteLocally: [], ...patch,
});

function harness(opts: { run?: (d: SyncDeps) => Promise<SyncResult>; prepare?: ControllerDeps["prepare"]; now?: number; rate?: { remaining: number; resetAt: number } | null } = {}) {
  const notices: string[] = [];
  const localChanges: number[] = [];
  const states: StatusState[] = [];
  const runs: SyncDeps[] = [];
  let now = opts.now ?? 1_000_000;
  const c = new SyncController({
    prepare: opts.prepare ?? (async () => ({ ok: true, deps: {} as never })),
    notify: m => notices.push(m),
    onState: s => states.push(s),
    loadConflictCount: async () => 0,
    rateLimit: () => opts.rate ?? null,
    now: () => now,
    formatTime: () => "12:34",
    onLocalChange: () => { localChanges.push(now); },
    log: quietLog,
    run: async d => { runs.push(d); return (opts.run ?? (async () => ok()))(d); },
  });
  c.setConfigured(true);
  return { c, notices, states, runs, localChanges, setNow: (n: number) => { now = n; } };
}

describe("SyncController — manual vs silent (§10)", () => {
  it("manual sync reports a summary; auto sync stays quiet", async () => {
    const h = harness();
    await h.c.sync("manual");
    expect(h.notices).toEqual(["Synced: 1 pulled, 2 pushed."]);
    await h.c.sync("auto");
    expect(h.notices).toHaveLength(1);
    expect(h.c.status.lastSyncAt).toBe(1_000_000);
    expect(h.c.status.phase).toBe("idle");
  });

  it("noop and partial messages", async () => {
    const noop = harness({ run: async () => ok({ status: "noop", pulled: 0, pushed: 0 }) });
    await noop.c.sync("manual");
    expect(noop.notices).toEqual(["Already up to date."]);
    const partial = harness({ run: async () => ok({ status: "partial", skipped: [{ path: P("a"), reason: "big" }] }) });
    await partial.c.sync("manual");
    expect(partial.notices[0]).toMatch(/1 file\(s\) skipped/);
  });

  it("conflicts are announced even in silent syncs (a notice, never a modal)", async () => {
    const h = harness({ run: async () => ok({ conflicts: 2 }) });
    await h.c.sync("auto");
    expect(h.notices).toEqual(["2 conflict(s): the other version was saved next to the file."]);
  });

  it("guard stops: silent sync only flags the status; manual says why", async () => {
    const stop = { kind: "massDelete" as const, local: [], remote: [], message: "would delete 40 files" };
    const h = harness({ run: async () => ok({ status: "stopped", stop }) });
    await h.c.sync("auto");
    expect(h.notices).toEqual([]);
    expect(h.c.status.stopped).toEqual(stop);
    expect(h.c.status.lastSyncAt).toBeNull(); // a stopped sync is not a sync
    await h.c.sync("manual");
    expect(h.notices).toEqual(["Sync stopped: would delete 40 files"]);
  });

  it("passes approvals of a manual sync through to core", async () => {
    const h = harness();
    await h.c.sync("manual", { approvals: { deletions: { local: [P("a")], remote: [] } } });
    expect(h.runs[0].approvals).toEqual({ deletions: { local: ["a"], remote: [] } });
    await h.c.sync("manual");
    expect(h.runs[1].approvals).toBeUndefined(); // one-shot
  });
});

describe("SyncController — errors (§6.3, §6.4)", () => {
  it("offline: silent in auto mode, shown in manual mode", async () => {
    const h = harness({ run: async () => { throw new SyncError("Offline", "Can't reach GitHub."); } });
    await h.c.sync("auto");
    expect(h.notices).toEqual([]);
    expect(h.c.status.error?.kind).toBe("Offline");
    await h.c.sync("manual");
    expect(h.notices).toEqual(["Sync failed: Can't reach GitHub."]);
  });

  it("problems the user must fix get one notice in auto mode, not one per sync", async () => {
    const h = harness({ run: async () => { throw new SyncError("AuthInvalid", "token expired"); } });
    await h.c.sync("auto");
    await h.c.sync("auto");
    expect(h.notices).toEqual(["Sync failed: token expired"]);
  });

  it("rate limited: blocks auto syncs until the reset, says when", async () => {
    let calls = 0;
    const h = harness({ run: async () => { calls++; throw new SyncError("RateLimited", "limit", 2_000_000); } });
    await h.c.sync("manual");
    expect(h.notices).toEqual(["GitHub rate limit reached. Sync resumes at 12:34."]);
    expect(await h.c.sync("auto")).toBeNull();
    expect(calls).toBe(1);
    h.setNow(2_000_001);
    await h.c.sync("auto");
    expect(calls).toBe(2);
  });

  it("auto syncs pause while fewer than 100 requests are left (§6.2)", async () => {
    const h = harness({ rate: { remaining: 50, resetAt: 5_000_000 } });
    expect(await h.c.sync("auto")).toBeNull();
    expect(h.runs).toHaveLength(0);
    await h.c.sync("manual"); // manual still allowed
    expect(h.runs).toHaveLength(1);
  });

  it("a bug (non-SyncError) is reported, not swallowed, and the lock is released", async () => {
    const h = harness({ run: async () => { throw new TypeError("x is undefined"); } });
    await h.c.sync("manual");
    expect(h.notices).toEqual(["Sync failed: x is undefined"]);
    expect(h.c.isSyncing).toBe(false);
  });

  it("not configured / no token", async () => {
    const h = harness({ prepare: async () => ({ ok: false, reason: "noToken" }) });
    await h.c.sync("auto");
    expect(h.notices).toEqual([]);
    await h.c.sync("manual");
    expect(h.notices[0]).toMatch(/No GitHub token on this device/);
    expect(h.runs).toHaveLength(0);
  });
});

describe("SyncController — local change tracking", () => {
  it("renames are handed to the scan and cleared after a successful sync", async () => {
    const h = harness();
    h.c.recordRename("a.md", "b.md");
    expect(h.c.status.pending).toBe(1);
    await h.c.sync("auto");
    expect(h.runs[0].pendingRenames).toEqual([{ from: "a.md", to: "b.md" }]);
    expect(h.c.status.pending).toBe(0);
    await h.c.sync("auto");
    expect(h.runs[1].pendingRenames).toEqual([]);
  });

  it("renames survive a stopped sync (nothing was pushed)", async () => {
    const h = harness({ run: async () => ok({ status: "stopped", stop: { kind: "custom", message: "m" } }) });
    h.c.recordRename("a.md", "b.md");
    await h.c.sync("auto");
    await h.c.sync("auto");
    expect(h.runs[1].pendingRenames).toEqual([{ from: "a.md", to: "b.md" }]);
  });

  it("events for paths the sync itself wrote are its own and are ignored", async () => {
    let c!: SyncController; // assigned right below, before any sync runs
    const h = harness({ run: async () => { c.recordRename("x", "y"); c.noteLocalChange("z"); return ok({ wroteLocally: [P("x"), P("y"), P("z")] }); } });
    c = h.c;
    await h.c.sync("auto");
    expect(h.c.status.pending).toBe(0);
    expect(h.localChanges).toEqual([]); // no self-triggered follow-up
    await h.c.sync("auto");
    expect(h.runs[1].pendingRenames).toEqual([]);
  });

  it("a user edit during a sync is kept and triggers a follow-up", async () => {
    let c!: SyncController; // assigned right below, before any sync runs
    const h = harness({ run: async () => { c.noteLocalChange("pulled.md"); c.noteLocalChange("typing.md"); return ok({ wroteLocally: [P("pulled.md")] }); } });
    c = h.c;
    await h.c.sync("auto");
    expect(h.c.status.pending).toBe(1);
    expect(h.localChanges).toHaveLength(1);
  });

  it("a file skipped as 'edited during sync' triggers a follow-up even without an event", async () => {
    const h = harness({ run: async () => ok({ status: "partial", skipped: [{ path: P("n.md"), reason: "edited during sync" }] }) });
    await h.c.sync("auto");
    expect(h.localChanges).toHaveLength(1);
  });

  it("late file-watcher events for the sync's own writes are ignored within the grace window only", async () => {
    const h = harness({ run: async () => ok({ wroteLocally: [P("café.md".normalize("NFC"))] }) });
    await h.c.sync("auto");
    h.c.noteLocalChange("café.md".normalize("NFD")); // watcher reports the on-disk (NFD) name
    expect(h.c.status.pending).toBe(0);
    h.setNow(1_000_000 + 6_000);
    h.c.noteLocalChange("café.md");
    expect(h.c.status.pending).toBe(1);
    expect(h.localChanges).toHaveLength(1);
  });

  it("a failed sync treats everything seen during it as user edits (safe side)", async () => {
    let c!: SyncController; // assigned right below, before any sync runs
    const h = harness({ run: async () => { c.noteLocalChange("a.md"); throw new SyncError("Offline", "x"); } });
    c = h.c;
    await h.c.sync("auto");
    expect(h.c.status.pending).toBe(1);
  });

  it("paused: auto syncs skip, manual still runs", async () => {
    const h = harness();
    h.c.setPaused(true);
    expect(await h.c.sync("auto")).toBeNull();
    expect((await h.c.sync("manual"))?.status).toBe("ok");
  });

  it("a manual request during a running auto sync queues one manual follow-up", async () => {
    let release!: () => void; // set synchronously by the Promise executor
    const gate = new Promise<void>(r => { release = r; });
    let n = 0;
    const h = harness({ run: async () => { if (n++ === 0) await gate; return ok(); } });
    const first = h.c.sync("auto");
    await Promise.resolve();
    const second = h.c.sync("manual");
    expect(h.notices).toEqual(["A sync is already running; another one will follow."]);
    release();
    await Promise.all([first, second]);
    expect(h.runs).toHaveLength(2);
    expect(h.notices.at(-1)).toBe("Synced: 1 pulled, 2 pushed.");
  });
});

describe("SyncController — modals (milestone 9)", () => {
  it("a manual sync stopped by a guard asks the host (modal); a silent one does not", async () => {
    const stop = { kind: "massDelete" as const, local: [P("a")], remote: [], message: "m" };
    const asked: unknown[] = [];
    const notices: string[] = [];
    const c = new SyncController({
      prepare: async () => ({ ok: true, deps: {} as never }), notify: m => notices.push(m), onState: () => {},
      loadConflictCount: async () => 0, rateLimit: () => null, now: () => 0, log: quietLog,
      onGuardStop: s => asked.push(s), run: async () => ok({ status: "stopped", stop }),
    });
    c.setConfigured(true);
    await c.sync("auto");
    expect(asked).toEqual([]);
    await c.sync("manual");
    expect(asked).toEqual([stop]);
    expect(notices).toEqual([]);
  });

  it("hold-back reaches core, and held files keep their renames and pending marks", async () => {
    const h = harness();
    h.c.recordRename("a.md", "b.md");
    h.c.noteLocalChange("c.md");
    await h.c.sync("manual", { holdBack: new Set([P("b.md"), P("a.md")]) });
    expect(h.runs[0].holdBack).toEqual(new Set(["b.md", "a.md"]));
    expect(h.c.pendingRenames).toEqual([{ from: "a.md", to: "b.md" }]);
    expect(h.c.status.pending).toBe(1); // b.md still pending, c.md synced
    await h.c.sync("auto");
    expect(h.runs[1].holdBack).toBeUndefined(); // auto syncs never hold back
  });
});
