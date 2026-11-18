import { describe, it, expect } from "vitest";
import { Scheduler, FULL_EVERY, STARTUP_DELAY_MS, type ScheduleOptions, type SchedulerDeps, type Trigger } from "../src/scheduler";
import { checkRemote } from "../src/core/poll";
import type { RemoteCheck } from "../src/core/poll";
import { SyncError } from "../src/core/types";
import { FakeGitHub } from "./fakes/fake-github";
import { FakeVault } from "./fakes/fake-vault";
import { FakeState, FakeClock } from "./fakes/fake-state";
import { runSync } from "../src/core/sync";
import { buildExcluder } from "../src/core/paths";
import { REPO, BRANCH, quietLog } from "./helpers";

/** Deterministic timers: advance(ms) fires due callbacks in order. */
class FakeTimers {
  now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; fn: () => void; every?: number }>();
  setTimeout = (fn: () => void, ms: number) => { const id = this.nextId++; this.tasks.set(id, { at: this.now + ms, fn }); return id; };
  clearTimeout = (id: number) => { this.tasks.delete(id); };
  setInterval = (fn: () => void, ms: number) => { const id = this.nextId++; this.tasks.set(id, { at: this.now + ms, fn, every: ms }); return id; };
  clearInterval = (id: number) => { this.tasks.delete(id); };
  get pending() { return this.tasks.size; }
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, task] = due;
      this.now = task.at;
      if (task.every) task.at += task.every; else this.tasks.delete(id);
      task.fn();
      await new Promise(r => setTimeout(r, 0)); // let async ticks settle
    }
    this.now = end;
  }
}

const OPTS: ScheduleOptions = { onStartup: true, onForeground: true, intervalMinutes: 5, debounceSeconds: 60 };

function setup(opts: Partial<ScheduleOptions> = {}, over: Partial<SchedulerDeps> = {}) {
  const timers = new FakeTimers();
  const fired: Trigger[] = [];
  const state = { local: false, can: true, remote: "unchanged" as RemoteCheck | Error, polls: 0 };
  const s = new Scheduler({
    timers, now: () => timers.now, log: quietLog,
    sync: async t => { fired.push(t); },
    canAutoSync: () => state.can,
    hasLocalChanges: () => state.local,
    checkRemote: async () => { state.polls++; if (state.remote instanceof Error) throw state.remote; return state.remote; },
    ...over,
  });
  s.configure({ ...OPTS, ...opts });
  return { s, timers, fired, state };
}

describe("Scheduler (§5.1)", () => {
  it("startup: one sync shortly after layout-ready, only if enabled", async () => {
    const a = setup();
    a.s.start();
    await a.timers.advance(STARTUP_DELAY_MS);
    expect(a.fired).toEqual(["startup"]);
    const b = setup({ onStartup: false });
    b.s.start();
    await b.timers.advance(STARTUP_DELAY_MS);
    expect(b.fired).toEqual([]);
  });

  it("debounce: syncs N seconds after the *last* edit", async () => {
    const { s, timers, fired } = setup({ onStartup: false });
    s.start();
    s.localChange();
    await timers.advance(40_000);
    s.localChange(); // keeps typing
    await timers.advance(40_000);
    expect(fired).toEqual([]);
    await timers.advance(20_000);
    expect(fired).toEqual(["edit"]);
  });

  it("debounce off (0) never fires; turning it off cancels a waiting one", async () => {
    const { s, timers, fired } = setup({ onStartup: false });
    s.start();
    s.localChange();
    s.configure({ ...OPTS, onStartup: false, debounceSeconds: 0 });
    await timers.advance(120_000);
    s.localChange();
    await timers.advance(120_000);
    expect(fired).toEqual([]);
  });

  it("no triggers before start() (vault still loading)", async () => {
    const { s, timers, fired } = setup();
    s.localChange();
    s.visibilityChanged(true);
    await timers.advance(10 * 60_000);
    expect(fired).toEqual([]);
  });

  it("foreground: syncs on return, at most every 30 s", async () => {
    const { s, timers, fired } = setup({ onStartup: false });
    s.start();
    s.visibilityChanged(true);
    s.visibilityChanged(true);
    await timers.advance(31_000);
    s.visibilityChanged(true);
    expect(fired).toEqual(["foreground", "foreground"]);
  });

  it("going to the background with edits waiting syncs right away (mobile may suspend us)", async () => {
    const { s, timers, fired } = setup({ onStartup: false });
    s.start();
    s.visibilityChanged(false);
    expect(fired).toEqual([]); // nothing waiting
    s.localChange();
    s.visibilityChanged(false);
    expect(fired).toEqual(["background"]);
    await timers.advance(120_000);
    expect(fired).toEqual(["background"]); // the debounce was consumed
  });

  it("interval: polls first and syncs only when the remote moved", async () => {
    const { s, timers, fired, state } = setup({ onStartup: false });
    s.start();
    await timers.advance(5 * 60_000);
    expect(state.polls).toBe(1);
    expect(fired).toEqual([]);
    state.remote = "changed";
    await timers.advance(5 * 60_000);
    expect(fired).toEqual(["interval"]);
  });

  it("interval: pending local changes sync without polling", async () => {
    const { s, timers, fired, state } = setup({ onStartup: false, debounceSeconds: 0 });
    s.start();
    state.local = true;
    await timers.advance(5 * 60_000);
    expect(fired).toEqual(["interval"]);
    expect(state.polls).toBe(0);
  });

  it(`interval: a full sync every ${FULL_EVERY} ticks even if polls say nothing changed`, async () => {
    const { s, timers, fired, state } = setup({ onStartup: false });
    s.start();
    await timers.advance(FULL_EVERY * 5 * 60_000);
    expect(fired).toEqual(["interval"]);
    expect(state.polls).toBe(FULL_EVERY - 1);
  });

  it("interval: no poll at all while auto sync is not allowed (paused / rate limited)", async () => {
    const { s, timers, fired, state } = setup({ onStartup: false });
    state.can = false;
    s.start();
    await timers.advance(60 * 60_000);
    expect(state.polls).toBe(0);
    expect(fired).toEqual([]);
  });

  it("interval: offline polls are skipped quietly; other poll errors run a sync so they surface", async () => {
    const { s, timers, fired, state } = setup({ onStartup: false });
    s.start();
    state.remote = new SyncError("Offline", "no network");
    await timers.advance(5 * 60_000);
    expect(fired).toEqual([]);
    state.remote = new SyncError("AuthInvalid", "expired");
    await timers.advance(5 * 60_000);
    expect(fired).toEqual(["interval"]);
  });

  it("changing the interval restarts it; 0 turns it off; stop() clears every timer", async () => {
    const { s, timers, state } = setup({ onStartup: false });
    s.start();
    s.configure({ ...OPTS, onStartup: false, intervalMinutes: 1 });
    await timers.advance(60_000);
    expect(state.polls).toBe(1);
    s.configure({ ...OPTS, onStartup: false, intervalMinutes: 0 });
    await timers.advance(60 * 60_000);
    expect(state.polls).toBe(1);
    s.localChange();
    s.stop();
    expect(timers.pending).toBe(0);
  });
});

describe("checkRemote (ETag polling, §5.1)", () => {
  const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync" });

  async function synced() {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "a" });
    const vault = new FakeVault();
    vault.seed("a.md", "a");
    const state = new FakeState();
    const deps = { vault, remote: gh, state, clock: new FakeClock(), log: quietLog,
      config: { repo: REPO, branch: BRANCH, deviceName: "A", platform: "posix" as const, caseInsensitiveFs: false, exclude } };
    await runSync(deps);
    return { gh, state, deps };
  }

  it("unchanged remote → 'unchanged', and the second poll is a 304", async () => {
    const { gh, state } = await synced();
    expect(await checkRemote(gh, state, REPO, BRANCH)).toBe("unchanged");
    expect(await checkRemote(gh, state, REPO, BRANCH)).toBe("unchanged");
    expect(state.polls.size).toBe(1);
  });

  it("a new remote commit → 'changed'", async () => {
    const { gh, state } = await synced();
    await checkRemote(gh, state, REPO, BRANCH);
    gh.seedChange(REPO, BRANCH, { "b.md": "b" });
    expect(await checkRemote(gh, state, REPO, BRANCH)).toBe("changed");
  });

  it("a change seen by a poll stays 'changed' (via 304) until a sync actually succeeds", async () => {
    const { gh, state, deps } = await synced();
    gh.seedChange(REPO, BRANCH, { "b.md": "b" });
    expect(await checkRemote(gh, state, REPO, BRANCH)).toBe("changed");
    // The sync after the poll fails…
    gh.faultAt(1, "offline");
    await expect(runSync(deps)).rejects.toThrow();
    // …so the next poll (a 304 now) must still say changed.
    expect(await checkRemote(gh, state, REPO, BRANCH)).toBe("changed");
    await runSync(deps);
    expect(await checkRemote(gh, state, REPO, BRANCH)).toBe("unchanged");
  });

  it("no baseline, deleted branch → 'changed' (let a sync and its guards look)", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, {});
    expect(await checkRemote(gh, new FakeState(), REPO, BRANCH)).toBe("changed");
    const s = await synced();
    s.gh.deleteRef(REPO, BRANCH);
    expect(await checkRemote(s.gh, s.state, REPO, BRANCH)).toBe("changed");
  });
});

describe("SyncResult.wroteLocally (no self-triggered syncs)", () => {
  it("lists every local path a sync wrote, renamed, deleted or created as a conflict copy", async () => {
    const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync" });
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "keep.md": "k", "gone.md": "g", "old.md": "rename me", "both.bin": "\u0000base", "merge.md": "1\n2\n3\n" });
    const vault = new FakeVault();
    for (const [p, c] of Object.entries({ "keep.md": "k", "gone.md": "g", "old.md": "rename me", "both.bin": "\u0000base", "merge.md": "1\n2\n3\n" })) vault.seed(p, c);
    const deps = { vault, remote: gh, state: new FakeState(), clock: new FakeClock(), log: quietLog,
      config: { repo: REPO, branch: BRANCH, deviceName: "A", platform: "posix" as const, caseInsensitiveFs: false, exclude } };
    await runSync(deps);
    gh.seedChange(REPO, BRANCH, { "gone.md": null, "old.md": null, "new.md": "rename me", "added.md": "a", "both.bin": "\u0000remote", "merge.md": "ONE\n2\n3\n" });
    await vault.writeBytes("both.bin" as never, new TextEncoder().encode("\u0000local"));
    await vault.writeBytes("merge.md" as never, new TextEncoder().encode("1\n2\nTHREE\n"));

    const r = await runSync(deps);
    const conflictCopy = [...vault.snapshot().keys()].find(p => p.includes("conflict"));
    expect(conflictCopy).toBeDefined();
    expect([...r.wroteLocally].sort()).toEqual(["added.md", conflictCopy, "gone.md", "merge.md", "new.md", "old.md"].sort());
    expect(r.wroteLocally).not.toContain("keep.md");
    expect(r.wroteLocally).not.toContain("both.bin"); // local version stays in place untouched
  });
});
