import type { Logger } from "./core/ports";
import { runSync, SyncRunner, type SyncDeps } from "./core/sync";
import type { RenameRecord } from "./core/scan";
import type { GuardStop, Path, SyncErrorKind, SyncResult } from "./core/types";
import { SyncError } from "./core/types";
import type { GuardApprovals } from "./core/guards";
import { t } from "./i18n";
import { INITIAL_STATUS, type StatusState } from "./ui/status-model";

// Between the Obsidian plugin and core/sync: one place that decides what a manual
// vs an automatic ("silent") sync shows the user (§10), tracks renames for the scan
// (§5.2), and holds auto-sync back while rate limited or paused (§6.2, §6.4).
// No Obsidian imports: everything platform-specific is injected.

export type SyncMode = "manual" | "auto";

type CoreDeps = Omit<SyncDeps, "pendingRenames" | "onStatus" | "approvals" | "holdBack">;

export interface ManualOptions {
  /** Answers to a guard stop the user just confirmed. */
  approvals?: GuardApprovals;
  /** Paths the user unticked in the review modal. */
  holdBack?: ReadonlySet<Path>;
}

export interface ControllerDeps {
  /** Fresh dependencies for one run (settings may have changed), or why sync cannot run. */
  prepare(): Promise<{ ok: true; deps: CoreDeps } | { ok: false; reason: "notConfigured" | "noToken" }>;
  notify(msg: string): void;
  onState(s: StatusState): void;
  loadConflictCount(): Promise<number>;
  /** Last rate-limit headers seen, if any. */
  rateLimit(): { remaining: number; resetAt: number } | null;
  now(): number;
  log: Logger;
  /** Formats a time of day for notices (locale-aware in the host). */
  formatTime?(epochMs: number): string;
  /** A real local edit was recorded (feeds the debounce trigger). */
  onLocalChange?(): void;
  /** A guard stopped a *manual* sync: the host asks the user (modal). Silent syncs never call this. */
  onGuardStop?(stop: GuardStop): void;
  /** Injectable for tests. */
  run?: (deps: SyncDeps) => Promise<SyncResult>;
}

/**
 * File events can reach us a moment after the write that caused them (desktop file
 * watcher). For this long after a sync, events for paths the sync itself wrote are
 * still treated as its own.
 */
export const OWN_WRITE_GRACE_MS = 5_000;

const nfc = (p: string) => p.normalize("NFC");

/** Errors the user has to fix; worth one notice even during silent syncs. */
const NEEDS_USER: ReadonlySet<SyncErrorKind> = new Set(["AuthInvalid", "PermissionDenied", "NotFound", "BranchProtected"]);

export class SyncController {
  private state: StatusState = { ...INITIAL_STATUS };
  private readonly runner = new SyncRunner<SyncResult | null>(() => this.runOnce());
  private nextManual = false;
  private nextOptions: ManualOptions = {};
  /** Events seen while a sync runs; settled against SyncResult.wroteLocally afterwards. */
  private duringSync: { paths: Set<string>; renames: RenameRecord[] } | null = null;
  private ownWrites = new Set<string>();
  private ownWritesUntil = 0;
  private readonly renames: RenameRecord[] = [];
  private readonly pendingPaths = new Set<string>();
  private lastNotifiedError: string | null = null;

  constructor(private readonly deps: ControllerDeps) {}

  get status(): Readonly<StatusState> { return this.state; }
  get isSyncing(): boolean { return this.runner.isRunning; }

  /**
   * Request a sync. Manual syncs always run (and report); auto syncs are skipped
   * while paused, unconfigured or rate limited. A request during a running sync
   * queues one follow-up run; a manual request makes that follow-up manual.
   */
  sync(mode: SyncMode, options: ManualOptions = {}): Promise<SyncResult | null> {
    if (mode === "manual") {
      if (this.runner.isRunning) this.deps.notify(t("notice.alreadyRunning"));
      this.nextManual = true;
      if (options.approvals || options.holdBack) this.nextOptions = options;
    } else if (!this.autoAllowed()) {
      return Promise.resolve(null);
    }
    return this.runner.request();
  }

  setPaused(paused: boolean) { this.update({ paused }); }
  setConfigured(configured: boolean) { this.update({ configured }); }

  /** Vault rename event. */
  recordRename(from: string, to: string) {
    const rename = { from: from as Path, to: to as Path };
    if (this.duringSync) { this.duringSync.renames.push(rename); this.duringSync.paths.add(to); return; }
    if (this.isOwnWrite(to)) return;
    this.renames.push(rename);
    this.markChanged(to);
  }

  /** Vault create/modify/delete event (already filtered against excludes by the host). */
  noteLocalChange(path: string) {
    if (this.duringSync) { this.duringSync.paths.add(path); return; }
    if (this.isOwnWrite(path)) return;
    this.markChanged(path);
  }

  get hasLocalChanges(): boolean { return this.pendingPaths.size > 0; }

  /** Renames recorded since the last sync (for the review preview). */
  get pendingRenames(): readonly RenameRecord[] { return this.renames; }

  /** Same checks the controller applies before an auto sync (for the scheduler's poll). */
  canAutoSync(): boolean { return this.autoAllowed(); }

  private isOwnWrite(path: string): boolean {
    return this.deps.now() < this.ownWritesUntil && this.ownWrites.has(nfc(path));
  }

  private markChanged(path: string) {
    this.pendingPaths.add(path);
    this.update({ pending: this.pendingPaths.size });
    this.deps.onLocalChange?.();
  }

  /**
   * After a sync: events for paths it wrote were its own; everything else seen during
   * the sync was the user and needs another sync. So does a file the sync skipped
   * because it was being edited.
   */
  private settleDuringSync(r: SyncResult | null) {
    const seen = this.duringSync;
    this.duringSync = null;
    if (!seen) return;
    this.ownWrites = new Set((r?.wroteLocally ?? []).map(nfc));
    this.ownWritesUntil = this.deps.now() + OWN_WRITE_GRACE_MS;
    let followUp = r?.skipped.some(s => s.reason === "edited during sync") ?? false;
    for (const rn of seen.renames) if (!this.ownWrites.has(nfc(rn.to))) this.renames.push(rn);
    for (const p of seen.paths) {
      if (this.ownWrites.has(nfc(p))) continue;
      this.pendingPaths.add(p);
      followUp = true;
    }
    this.update({ pending: this.pendingPaths.size });
    if (followUp) this.deps.onLocalChange?.();
  }

  async refreshConflicts() {
    this.update({ conflicts: await this.deps.loadConflictCount() });
  }

  private autoAllowed(): boolean {
    const s = this.state;
    if (s.paused || !s.configured) return false;
    const now = this.deps.now();
    if (s.blockedUntil !== null && s.blockedUntil > now) return false;
    const rl = this.deps.rateLimit();
    // §6.2: under 100 requests left, leave the rest for manual syncs.
    if (rl && rl.remaining < 100 && rl.resetAt > now) return false;
    return true;
  }

  private async runOnce(): Promise<SyncResult | null> {
    const manual = this.nextManual;
    const { approvals, holdBack } = manual ? this.nextOptions : {};
    this.nextManual = false;
    this.nextOptions = {};

    const prep = await this.deps.prepare();
    if (!prep.ok) {
      this.update({ configured: prep.reason !== "notConfigured" });
      if (manual) this.deps.notify(t(prep.reason === "noToken" ? "notice.noToken" : "notice.notConfigured"));
      return null;
    }
    this.update({ configured: true });

    const renames = [...this.renames];
    const pendingAtStart = new Set(this.pendingPaths);
    this.duringSync = { paths: new Set(), renames: [] };
    let result: SyncResult | null = null;
    this.update({ phase: "scanning", progress: null });
    const run = this.deps.run ?? runSync;
    try {
      const r = await run({
        ...prep.deps,
        pendingRenames: renames,
        approvals,
        holdBack,
        onStatus: (phase, detail) => this.update({ phase, progress: detail ?? null }),
      });
      result = r;
      if (r.status !== "stopped") {
        // Held-back files were not synced: keep their renames and pending marks.
        const held = (p: string) => holdBack?.has(p as Path) ?? false;
        const keep = renames.filter(rn => held(rn.from) || held(rn.to));
        this.renames.splice(0, renames.length, ...keep);
        for (const p of pendingAtStart) if (!held(p)) this.pendingPaths.delete(p);
      }
      this.lastNotifiedError = null;
      this.update({
        lastSyncAt: r.status === "stopped" ? this.state.lastSyncAt : this.deps.now(),
        error: null, stopped: r.stop ?? null, blockedUntil: null, pending: this.pendingPaths.size,
        conflicts: await this.deps.loadConflictCount(),
      });
      this.report(r, manual);
      return r;
    } catch (e) {
      const err = e instanceof SyncError ? e : new SyncError("Unexpected", e instanceof Error ? e.message : String(e));
      this.deps.log.error(`sync failed (${err.kind}): ${err.message}`);
      const blockedUntil = err.kind === "RateLimited" && err.resetAt ? err.resetAt : null;
      this.update({ error: { kind: err.kind, message: err.message }, blockedUntil });
      const key = `${err.kind}:${err.message}`;
      if (manual) {
        if (err.kind === "RateLimited" && blockedUntil) this.deps.notify(t("notice.rateLimited", { time: this.time(blockedUntil) }));
        else this.deps.notify(t("notice.failed", { message: err.message }));
      } else if (NEEDS_USER.has(err.kind) && this.lastNotifiedError !== key) {
        this.deps.notify(t("notice.failed", { message: err.message }));
      }
      this.lastNotifiedError = key;
      return null;
    } finally {
      this.settleDuringSync(result);
      this.update({ phase: "idle", progress: null });
    }
  }

  private report(r: SyncResult, manual: boolean) {
    if (r.status === "stopped") {
      // Silent syncs only flag the status bar (§5.6); manual ones ask (modal) or say why.
      if (!manual) return;
      if (r.stop && r.stop.kind !== "custom" && this.deps.onGuardStop) this.deps.onGuardStop(r.stop);
      else this.deps.notify(t("notice.stopped", { message: r.stop?.message ?? r.errors[0]?.message ?? "" }));
      return;
    }
    if (r.conflicts > 0) this.deps.notify(t("notice.conflicts", { count: r.conflicts }));
    if (!manual) return;
    if (r.status === "partial") { this.deps.notify(t("notice.partial", { count: r.skipped.length + r.errors.length })); return; }
    if (r.status === "noop") { this.deps.notify(t("notice.upToDate")); return; }
    const parts: string[] = [];
    if (r.pulled + r.renamed) parts.push(t("summary.pulled", { n: r.pulled + r.renamed }));
    if (r.pushed) parts.push(t("summary.pushed", { n: r.pushed }));
    if (r.deleted) parts.push(t("summary.deleted", { n: r.deleted }));
    if (r.merged) parts.push(t("summary.merged", { n: r.merged }));
    this.deps.notify(t("notice.synced", { summary: parts.join(", ") }));
  }

  private time(ms: number): string {
    return this.deps.formatTime ? this.deps.formatTime(ms) : new Date(ms).toISOString().slice(11, 16);
  }

  private update(patch: Partial<StatusState>) {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }
}
