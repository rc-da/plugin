import type { Logger } from "./core/ports";
import type { RemoteCheck } from "./core/poll";
import { SyncError } from "./core/types";

// Automatic sync triggers (§5.1). Pure: timers are injected, so every trigger is
// unit-testable. It only decides *when*; SyncController decides whether an auto
// sync may run at all (paused, not configured, rate limited) and runs it.
//
// - startup: once, shortly after layout-ready;
// - foreground: when the app becomes visible again (mobile resume), at most every 30 s;
// - background: when the app is hidden with edits still waiting for their debounce,
//   sync right away: the mobile OS may suspend or kill us at any moment (§2);
// - edit: N seconds after the last local change (debounced);
// - interval: every M minutes, but only after a free conditional GET of the ref says
//   the remote moved, unless local changes are pending. Every FULL_EVERY ticks a
//   full sync runs anyway, to catch changes no event told us about.

export type Trigger = "startup" | "foreground" | "background" | "edit" | "interval";

export interface ScheduleOptions {
  onStartup: boolean;
  onForeground: boolean;
  /** 0 = off. */
  intervalMinutes: number;
  /** 0 = off. */
  debounceSeconds: number;
}

export interface SchedulerTimers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}

export interface SchedulerDeps {
  timers: SchedulerTimers;
  now(): number;
  log: Logger;
  /** Start an automatic sync (the controller may still decline). */
  sync(trigger: Trigger): Promise<unknown>;
  /** False while paused / unconfigured / rate limited: then not even a poll is sent. */
  canAutoSync(): boolean;
  hasLocalChanges(): boolean;
  checkRemote(): Promise<RemoteCheck>;
}

export const STARTUP_DELAY_MS = 2_000;
export const FOREGROUND_MIN_GAP_MS = 30_000;
export const FULL_EVERY = 6;

export class Scheduler {
  private opts: ScheduleOptions = { onStartup: false, onForeground: false, intervalMinutes: 0, debounceSeconds: 0 };
  private started = false;
  private debounceId: number | null = null;
  private intervalId: number | null = null;
  private startupId: number | null = null;
  private ticksSinceFull = 0;
  private lastForegroundAt = Number.NEGATIVE_INFINITY;
  private polling = false;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Apply (changed) settings; restarts the interval if needed. */
  configure(opts: ScheduleOptions) {
    const intervalChanged = opts.intervalMinutes !== this.opts.intervalMinutes;
    this.opts = { ...opts };
    if (opts.debounceSeconds <= 0) this.clearDebounce();
    if (this.started && intervalChanged) this.restartInterval();
  }

  /** Call once the workspace layout is ready. */
  start() {
    if (this.started) return;
    this.started = true;
    this.restartInterval();
    if (this.opts.onStartup) {
      this.startupId = this.deps.timers.setTimeout(() => { this.startupId = null; this.fire("startup"); }, STARTUP_DELAY_MS);
    }
  }

  stop() {
    this.started = false;
    this.clearDebounce();
    if (this.intervalId !== null) this.deps.timers.clearInterval(this.intervalId);
    if (this.startupId !== null) this.deps.timers.clearTimeout(this.startupId);
    this.intervalId = null;
    this.startupId = null;
  }

  /** A real user edit happened (the controller already filtered out the sync's own writes). */
  localChange() {
    if (!this.started || this.opts.debounceSeconds <= 0) return;
    this.clearDebounce();
    this.debounceId = this.deps.timers.setTimeout(() => { this.debounceId = null; this.fire("edit"); }, this.opts.debounceSeconds * 1000);
  }

  visibilityChanged(visible: boolean) {
    if (!this.started) return;
    if (visible) {
      const now = this.deps.now();
      if (!this.opts.onForeground || now - this.lastForegroundAt < FOREGROUND_MIN_GAP_MS) return;
      this.lastForegroundAt = now;
      this.fire("foreground");
    } else if (this.debounceId !== null) {
      this.fire("background");
    }
  }

  /** Interval tick (public for tests). */
  async tick(): Promise<void> {
    if (!this.started || this.polling || !this.deps.canAutoSync()) return;
    this.ticksSinceFull++;
    if (this.deps.hasLocalChanges() || this.ticksSinceFull >= FULL_EVERY) {
      this.fire("interval");
      return;
    }
    this.polling = true;
    try {
      if ((await this.deps.checkRemote()) === "changed") this.fire("interval");
    } catch (e) {
      // Offline: nothing to do until we are back. Anything else: run a sync so the
      // error reaches the status bar instead of failing silently every tick.
      if (e instanceof SyncError && (e.kind === "Offline" || e.kind === "Timeout")) this.deps.log.debug(`poll skipped: ${e.message}`);
      else this.fire("interval");
    } finally {
      this.polling = false;
    }
  }

  private fire(trigger: Trigger) {
    // Any sync covers waiting edits and resets the full-sync countdown.
    this.clearDebounce();
    this.ticksSinceFull = 0;
    this.deps.log.debug(`auto sync: ${trigger}`);
    this.deps.sync(trigger).catch(e => this.deps.log.error(`auto sync (${trigger}) failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  private restartInterval() {
    if (this.intervalId !== null) this.deps.timers.clearInterval(this.intervalId);
    this.intervalId = null;
    if (this.opts.intervalMinutes > 0) {
      this.intervalId = this.deps.timers.setInterval(() => { void this.tick(); }, this.opts.intervalMinutes * 60_000);
    }
  }

  private clearDebounce() {
    if (this.debounceId !== null) this.deps.timers.clearTimeout(this.debounceId);
    this.debounceId = null;
  }
}
