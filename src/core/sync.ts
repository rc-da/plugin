import type { Clock, Logger, RemotePort, StatePort, VaultPort } from "./ports";
import type { Baseline, FileEntry, GuardStop, LocalCache, Path, Sha, SyncPlan, SyncResult, SyncStatus } from "./types";
import { SyncError } from "./types";
import { scanLocal, type RenameRecord } from "./scan";
import { walkRemoteTree, diffRemote, type RemoteSnapshot } from "./remote-diff";
import { buildPlan } from "./plan";
import { applyPull } from "./apply";
import { pushPlan, renderCommitMessage, isPushAction, DEFAULT_COMMIT_TEMPLATE } from "./push";
import { resolvePlan } from "./merge";
import { removeBaselineFile, setBaselineFile } from "./baseline";
import type { Excluder, Platform } from "./paths";
import { checkEmptyRemote, checkMassDelete, type GuardApprovals, type MassDeleteLimits } from "./guards";

// Orchestrator (§5): scan → remote diff → plan → [guards] → apply → push → persist.
// One call = one sync pass (with up to `maxPushAttempts` push retries when another
// device commits in between). Concurrency control lives in SyncRunner below.

export interface SyncConfig {
  repo: string;
  branch: string;
  deviceName: string;
  commitTemplate?: string;
  maxFileBytes?: number;
  platform: Platform;
  caseInsensitiveFs: boolean;
  exclude: Excluder;
  /** Stable fingerprint of the rules behind `exclude` (patterns, gitignore, config-dir setting). */
  excludeKey?: string;
  maxPushAttempts?: number;
  /** Mass-deletion guard thresholds (§5.6); defaults max(10, 5%). */
  massDelete?: MassDeleteLimits;
}

export interface SyncDeps {
  vault: VaultPort;
  remote: RemotePort;
  state: StatePort;
  clock: Clock;
  log: Logger;
  config: SyncConfig;
  /** Renames observed since the last successful sync (the host clears them on success). */
  pendingRenames?: RenameRecord[];
  /**
   * Answers to an earlier guard stop (from `SyncResult.stop`), given by the user in
   * a manual sync. The built-in guards (§5.6) always run; approvals only let a
   * plan through that matches what the user saw.
   */
  approvals?: GuardApprovals;
  /**
   * Paths the user held back in the review modal (§10): every action touching them
   * becomes a skip for this sync, so they stay untouched on disk and on GitHub.
   */
  holdBack?: ReadonlySet<Path>;
  /** Extra host guard, run after the built-in ones. Return a reason to stop before anything is changed. */
  guard?: (plan: SyncPlan, ctx: GuardContext) => Promise<string | null> | string | null;
  yieldToHost?: () => Promise<void>;
  onStatus?: (phase: SyncPhase, detail?: { done: number; total: number }) => void;
}

export interface GuardContext {
  firstSync: boolean;
  baseline: Baseline;
  remoteSnapshot: RemoteSnapshot | null;
  localFileCount: number;
}

export type SyncPhase = "scanning" | "fetching" | "planning" | "pulling" | "pushing" | "finishing";

export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const { config, log } = deps;
  const maxAttempts = config.maxPushAttempts ?? 3;

  let baseline = await deps.state.loadBaseline(config.repo, config.branch);
  if (baseline && (baseline.repo !== config.repo || baseline.branch !== config.branch)) {
    log.warn("baseline belongs to a different repo/branch; starting in first-sync mode");
    baseline = null;
  }
  const firstSync = baseline === null;
  const live: Baseline = baseline ?? { repo: config.repo, branch: config.branch, remoteHead: null, files: {}, dirs: {} };
  const excludeKey = config.excludeKey ?? "";
  if (baseline && (baseline.excludeKey ?? "") !== excludeKey) {
    // Subtrees skipped under the old rules may hide files the new rules include.
    log.info("exclusion rules changed; the remote tree will be walked in full once");
    live.dirs = {};
    live.remoteHead = null;
  }
  live.excludeKey = excludeKey;
  let cache: LocalCache = await deps.state.loadLocalCache();

  const totals: SyncResult = {
    status: "noop", pulled: 0, pushed: 0, deleted: 0, renamed: 0, conflicts: 0, merged: 0,
    skipped: [], errors: [], remoteHead: live.remoteHead, attempts: 0, wroteLocally: [],
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    totals.attempts = attempt;
    const outcome = await onePass(deps, live, firstSync && attempt === 1, cache, totals);
    cache = outcome.cache;
    await deps.state.saveLocalCache(cache);
    if (outcome.kind === "retry") {
      log.info(`remote moved while pushing (attempt ${attempt}/${maxAttempts}); re-planning`);
      continue;
    }
    if (outcome.kind === "stopped") {
      log.warn(`sync stopped by the ${outcome.stop.kind} guard: ${outcome.stop.message}`);
      totals.status = "stopped";
      totals.stop = outcome.stop;
      totals.errors.push({ path: null, message: outcome.stop.message });
      return totals;
    }
    totals.status = finalStatus(totals);
    return totals;
  }
  throw new SyncError("Conflict422", `another device kept pushing; gave up after ${maxAttempts} attempts`);
}

type PassOutcome =
  | { kind: "done"; cache: LocalCache }
  | { kind: "retry"; cache: LocalCache }
  | { kind: "stopped"; stop: GuardStop; cache: LocalCache };

async function onePass(deps: SyncDeps, baseline: Baseline, firstSyncIn: boolean, cache: LocalCache, totals: SyncResult): Promise<PassOutcome> {
  const { config, remote, vault, state, log } = deps;
  const persist = (b: Baseline) => state.saveBaseline(b);
  let firstSync = firstSyncIn;
  let planBaseline = firstSync ? null : baseline;

  // 1. Local scan.
  const runScan = async () => {
    deps.onStatus?.("scanning");
    return scanLocal({
      vault, baseline: planBaseline, cache, exclude: config.exclude,
      pendingRenames: deps.pendingRenames, maxFileBytes: config.maxFileBytes,
      yieldToHost: deps.yieldToHost,
      onProgress: (done, total) => deps.onStatus?.("scanning", { done, total }),
    });
  };
  let scan = await runScan();

  // Empty-remote guard (§5.6). Resolved at most once per pass; "reupload" drops the
  // baseline and re-scans in first-sync mode so nothing is deleted on either side.
  let emptyRemoteApproved = false;
  const emptyRemoteGuard = async (head: Sha | null, remoteFiles: number): Promise<GuardStop | null> => {
    if (firstSync || emptyRemoteApproved) return null;
    const stop = checkEmptyRemote(baseline, head, remoteFiles, deps.approvals?.emptyRemote);
    if (stop) return stop;
    if (remoteFiles > 0 || Object.keys(baseline.files).length === 0) return null;
    // Approved for this head.
    emptyRemoteApproved = true;
    if (deps.approvals?.emptyRemote?.resolution === "reupload") {
      log.info("remote is empty; re-uploading this vault (first-sync mode)");
      baseline.files = {};
      baseline.dirs = {};
      baseline.remoteHead = null;
      firstSync = true;
      planBaseline = null;
      scan = await runScan();
    }
    return null;
  };

  // 2. Remote head (bootstrapping an empty repo) and diff.
  deps.onStatus?.("fetching");
  let ref = await remote.getRef(config.repo, config.branch);
  if (!ref) {
    // A missing branch we synced with before is suspicious: ask before recreating it.
    const stop = await emptyRemoteGuard(null, 0);
    if (stop) return { kind: "stopped", stop, cache: scan.cache };
    log.info("remote branch is empty; bootstrapping");
    await remote.bootstrapRepo(config.repo, config.branch);
    ref = await remote.getRef(config.repo, config.branch);
    if (!ref) throw new SyncError("Unexpected", "branch still missing after bootstrap");
  }
  const head = ref.sha;
  const commit = await remote.getCommit(config.repo, head);

  let snapshot: RemoteSnapshot | null = null;
  let remoteChanges: ReturnType<typeof diffRemote> = [];
  if (firstSync || baseline.remoteHead !== head) {
    snapshot = await walkRemoteTree(remote, config.repo, commit.treeSha, planBaseline, {
      exclude: config.exclude,
      yieldToHost: deps.yieldToHost,
      onProgress: (dirs, files) => deps.onStatus?.("fetching", { done: files, total: dirs }),
    });
    const stop = await emptyRemoteGuard(head, Object.keys(snapshot.files).length);
    if (stop) return { kind: "stopped", stop, cache: scan.cache };
    for (const s of snapshot.skipped) pushSkip(totals, s.path, s.reason);
    remoteChanges = diffRemote(planBaseline, snapshot, p => config.exclude(p));
  }
  // Paths that are excluded now are no longer ours to track; forget them. If they
  // are un-excluded later they re-enter as added on both sides (adopt or conflict).
  for (const p of Object.keys(baseline.files) as Path[]) {
    if (config.exclude(p)) removeBaselineFile(baseline, p);
  }

  for (const s of scan.skipped) pushSkip(totals, s.path, s.reason);

  // 3. Plan.
  deps.onStatus?.("planning");
  const rawPlan = buildPlan({ baseline: planBaseline, local: scan.changes, remote: remoteChanges, remoteHead: head });
  // Resolve both-changed files: 3-way merge where possible, conflict copies otherwise.
  const { plan: resolved } = await resolvePlan(rawPlan, { vault, remote, repo: config.repo, clock: deps.clock, deviceName: config.deviceName, log });
  const plan = deps.holdBack?.size ? holdBack(resolved, deps.holdBack) : resolved;

  // 4. Guards.
  const localFileCount = Object.keys(scan.files).length;
  const massDelete = checkMassDelete({
    plan, baseline, localFileCount,
    remoteFileCount: snapshot ? Object.keys(snapshot.files).length : Object.keys(baseline.files).length,
    limits: config.massDelete,
    approved: deps.approvals?.deletions,
    localApproved: emptyRemoteApproved && deps.approvals?.emptyRemote?.resolution === "applyDeletions",
  });
  if (massDelete) return { kind: "stopped", stop: massDelete, cache: scan.cache };
  if (deps.guard) {
    const reason = await deps.guard(plan, { firstSync, baseline, remoteSnapshot: snapshot, localFileCount });
    if (reason) return { kind: "stopped", stop: { kind: "custom", message: reason }, cache: scan.cache };
  }

  // Bookkeeping-only actions.
  for (const a of plan.actions) {
    if (a.kind === "baselineSet") setBaselineFile(baseline, a.path, { sha: a.sha, mode: a.mode });
    else if (a.kind === "baselineRemove") removeBaselineFile(baseline, a.path);
    else if (a.kind === "skip") pushSkip(totals, a.path, a.reason);
  }

  // 5. Apply the pull side.
  deps.onStatus?.("pulling");
  const applied = await applyPull(plan, {
    vault, remote, repo: config.repo, baseline, persist, log,
    platform: config.platform, caseInsensitiveFs: config.caseInsensitiveFs,
    scanStats: scan.stats, maxFileBytes: config.maxFileBytes, now: () => deps.clock.now(),
    onProgress: (done, total) => deps.onStatus?.("pulling", { done, total }),
  });
  totals.pulled += applied.pulled;
  totals.deleted += applied.deleted;
  totals.renamed += applied.renamed;
  totals.merged += applied.merged;
  totals.wroteLocally.push(...applied.touched);
  totals.conflicts += applied.conflicts.length;
  for (const s of applied.skipped) pushSkip(totals, s.path, s.reason);
  for (const e of applied.errors) totals.errors.push({ path: e.path, message: e.error.message });
  if (applied.conflicts.length > 0) {
    const existing = await state.loadConflicts();
    await state.saveConflicts([...existing, ...applied.conflicts]);
  }
  // A merge or conflict whose local write did not happen must not be pushed either:
  // pushing would overwrite the remote with something the vault does not contain.
  const notWritten = new Set<Path>([...applied.skipped.map(s => s.path), ...applied.errors.map(e => e.path)]);
  const pushable: SyncPlan = {
    remoteHead: plan.remoteHead,
    actions: plan.actions.filter(a => !((a.kind === "merge" || a.kind === "conflict") && notWritten.has(a.path))),
  };
  // Keep the cache warm: files we wrote get their fresh (mtime, size, sha); anything
  // we touched but could not stat is dropped so the next scan re-hashes it.
  const nextCache: LocalCache = { ...scan.cache };
  for (const a of plan.actions) {
    if (a.kind === "pull" || a.kind === "resurrect" || a.kind === "pullDelete") delete nextCache[a.path];
    if (a.kind === "pullRename") { delete nextCache[a.oldPath]; delete nextCache[a.path]; }
  }
  for (const [p, entry] of applied.cacheUpdates) nextCache[p] = entry;

  // 6. Push.
  deps.onStatus?.("pushing");
  const pushCount = pushable.actions.filter(isPushAction).length;
  let newHead: Sha = head;
  let newTree: Sha = commit.treeSha;
  let pushed = false;
  if (pushCount > 0) {
    const message = renderCommitMessage(config.commitTemplate ?? DEFAULT_COMMIT_TEMPLATE, {
      device: config.deviceName, date: deps.clock.isoDate(), count: pushCount,
    });
    let result;
    try {
      result = await pushPlan(pushable, {
        vault, remote, repo: config.repo, branch: config.branch, baseline,
        parentCommit: head, parentTree: commit.treeSha, message, log,
        onProgress: (done, total) => deps.onStatus?.("pushing", { done, total }),
      });
    } catch (e) {
      if (e instanceof SyncError && e.kind === "Conflict422") {
        await persist(baseline);
        return { kind: "retry", cache: nextCache };
      }
      throw e;
    }
    if (result) {
      pushed = true;
      newHead = result.commitSha;
      newTree = result.treeSha;
      for (const p of result.removed) removeBaselineFile(baseline, p);
      for (const w of result.written) setBaselineFile(baseline, w.path, { sha: w.sha, mode: w.mode });
      for (const s of result.skipped) pushSkip(totals, s.path, s.reason);
      totals.pushed += result.written.length + result.removed.length;
    }
  }

  // 7. Advance the baseline head/dirs only when the baseline truly mirrors the remote.
  deps.onStatus?.("finishing");
  const clean = applied.errors.length === 0 && applied.skipped.length === 0;
  if (pushed || snapshot) {
    // After a push the tree changed; re-walk it (only touched directories are fetched).
    const finalSnap = pushed
      ? await walkRemoteTree(remote, config.repo, newTree, baseline, { exclude: config.exclude, yieldToHost: deps.yieldToHost })
      : snapshot;
    if (finalSnap && clean && snapshotMatchesBaseline(finalSnap, baseline)) {
      baseline.dirs = finalSnap.dirs;
      baseline.remoteHead = newHead;
    } else if (finalSnap) {
      log.warn("baseline does not fully mirror the remote yet; the next sync will re-check the tree");
      for (const p of mismatches(finalSnap, baseline)) log.debug(`  mismatch: ${p}`);
    }
  } else if (clean) {
    baseline.remoteHead = newHead;
  }
  totals.remoteHead = baseline.remoteHead;
  await persist(baseline);
  return { kind: "done", cache: nextCache };
}

/** Replace every action that touches a held-back path (either end of a rename) by a skip. */
export function holdBack(plan: SyncPlan, held: ReadonlySet<Path>): SyncPlan {
  return {
    remoteHead: plan.remoteHead,
    actions: plan.actions.map(a => {
      const touches = held.has(a.path) || ((a.kind === "pushRename" || a.kind === "pullRename") && held.has(a.oldPath));
      return touches && a.kind !== "skip" ? { kind: "skip" as const, path: a.path, reason: "held back" } : a;
    }),
  };
}

function snapshotMatchesBaseline(snap: RemoteSnapshot, baseline: Baseline): boolean {
  return mismatches(snap, baseline).length === 0;
}

function mismatches(snap: RemoteSnapshot, baseline: Baseline): Path[] {
  const out: Path[] = [];
  for (const [p, e] of Object.entries(snap.files) as [Path, FileEntry][]) {
    if (baseline.files[p]?.sha !== e.sha) out.push(p);
  }
  for (const p of Object.keys(baseline.files) as Path[]) {
    if (!snap.files[p]) out.push(p);
  }
  return out;
}

function pushSkip(totals: SyncResult, path: Path, reason: string) {
  totals.skipped.push({ path, reason });
}

function finalStatus(t: SyncResult): SyncStatus {
  if (t.errors.length > 0 || t.skipped.length > 0) return "partial";
  if (t.pulled + t.pushed + t.deleted + t.renamed + t.conflicts + t.merged === 0) return "noop";
  return "ok";
}

/**
 * Global mutex (§5): a trigger while a sync is running sets a "run again" flag
 * instead of starting a second sync.
 */
export class SyncRunner<T = SyncResult> {
  private running: Promise<T> | null = null;
  private runAgain = false;

  constructor(private readonly run: () => Promise<T>) {}

  get isRunning(): boolean { return this.running !== null; }

  /** Start a sync, or queue one more pass if a sync is already in progress. */
  request(): Promise<T> {
    if (this.running) {
      this.runAgain = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        let result = await this.run();
        while (this.runAgain) {
          this.runAgain = false;
          result = await this.run();
        }
        return result;
      } finally {
        this.running = null;
        this.runAgain = false;
      }
    })();
    return this.running;
  }
}
