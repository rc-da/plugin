import type { Logger, RemotePort, VaultPort } from "./ports";
import type { Baseline, ConflictRecord, FileMode, LocalCacheEntry, Path, Sha, SyncAction, SyncPlan } from "./types";
import { gitBlobSha } from "./hash";
import { ancestorDirs, caseKey, validatePath, type Platform } from "./paths";
import { removeBaselineFile, setBaselineFile } from "./baseline";

// Execute the pull side of a plan (§5.7): writes/renames → deletes → empty folders.
// Every completed operation is reflected in `baseline` immediately and persisted
// in batches, so a sync killed halfway resumes correctly (§4).

export interface ApplyDeps {
  vault: VaultPort;
  remote: RemotePort;
  repo: string;
  /** Mutated in place as operations complete. */
  baseline: Baseline;
  /** Persist the baseline; called every `persistEvery` ops and at the end. */
  persist: (baseline: Baseline) => Promise<void>;
  log: Logger;
  platform: Platform;
  caseInsensitiveFs: boolean;
  /**
   * mtime/size of each local file as seen by the scan. If a file differs now,
   * it was edited during the sync and must not be overwritten (§5.6).
   */
  scanStats?: Map<Path, { mtime: number; size: number }>;
  /** Blobs above this size are skipped and reported, never fatal (§6.1). */
  maxFileBytes?: number;
  /** Epoch ms, for conflict records. */
  now?: () => number;
  persistEvery?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface ApplyResult {
  pulled: number;
  deleted: number;
  renamed: number;
  skipped: { path: Path; reason: string }[];
  errors: { path: Path; error: Error }[];
  /** (mtime, size, sha) of every file written, so the next scan need not re-hash it. */
  cacheUpdates: Map<Path, LocalCacheEntry>;
  /** Every local path this apply created, changed, renamed or deleted (so the host can tell its own file events from the user's). */
  touched: Path[];
  /** Merged files written locally (their push happens afterwards). */
  merged: number;
  /** Conflict copies written locally. */
  conflicts: ConflictRecord[];
}

type PullAction = Extract<SyncAction, { kind: "pull" | "pullRename" | "pullDelete" | "resurrect" | "merge" | "conflict" }>;

function isPullAction(a: SyncAction): a is PullAction {
  return a.kind === "pull" || a.kind === "pullRename" || a.kind === "pullDelete" || a.kind === "resurrect"
    || a.kind === "merge" || a.kind === "conflict";
}

export async function applyPull(plan: SyncPlan, deps: ApplyDeps): Promise<ApplyResult> {
  const result: ApplyResult = {
    pulled: 0, deleted: 0, renamed: 0, skipped: [], errors: [], cacheUpdates: new Map(), merged: 0, conflicts: [], touched: [],
  };
  const persistEvery = deps.persistEvery ?? 25;
  const pullActions = plan.actions.filter(isPullAction);
  const total = pullActions.length;
  let done = 0;
  let sinceLastPersist = 0;

  const tick = async () => {
    done++;
    sinceLastPersist++;
    deps.onProgress?.(done, total);
    if (sinceLastPersist >= persistEvery) {
      await deps.persist(deps.baseline);
      sinceLastPersist = 0;
    }
  };

  // Case-insensitive FS: track every name we know to exist so a second remote
  // path differing only in case is skipped instead of clobbering the first.
  const occupied = new Map<string, Path>();
  if (deps.caseInsensitiveFs) {
    for (const p of Object.keys(deps.baseline.files) as Path[]) occupied.set(caseKey(p), p);
  }

  const writes = pullActions.filter((a): a is Extract<PullAction, { kind: "pull" | "resurrect" }> =>
    a.kind === "pull" || a.kind === "resurrect");
  const renames = pullActions.filter((a): a is Extract<PullAction, { kind: "pullRename" }> => a.kind === "pullRename");
  const deletes = pullActions.filter((a): a is Extract<PullAction, { kind: "pullDelete" }> => a.kind === "pullDelete");
  const merges = pullActions.filter((a): a is Extract<PullAction, { kind: "merge" }> => a.kind === "merge");
  const conflicts = pullActions.filter((a): a is Extract<PullAction, { kind: "conflict" }> => a.kind === "conflict");

  // 1. Renames first so a rename + write to the new path land in the right order.
  for (const a of renames) {
    try {
      const check = validatePath(a.path, deps.platform);
      if (!check.ok) { skip(result, deps, a.path, check.reason ?? "invalid name"); await tick(); continue; }
      // Neither the source nor the target may have changed since the scan: the
      // target would be clobbered by the rename (§5.6 edited-during-sync).
      const touched = (await editedSinceScan(deps, a.oldPath)) ? a.oldPath
        : (await editedSinceScan(deps, a.path)) ? a.path : null;
      if (touched !== null) {
        skip(result, deps, touched, "edited during sync");
        await tick();
        continue;
      }
      if (await deps.vault.fileExists(a.oldPath)) {
        await deps.vault.renameFile(a.oldPath, a.path);
      } else {
        // Source already gone locally: fall back to a plain write of the new path.
        await writeBlob(deps, a.path, a.sha, a.mode);
      }
      await rememberStat(deps, result, a.path, a.sha);
      removeBaselineFile(deps.baseline, a.oldPath);
      setBaselineFile(deps.baseline, a.path, { sha: a.sha, mode: a.mode });
      if (deps.caseInsensitiveFs) { occupied.delete(caseKey(a.oldPath)); occupied.set(caseKey(a.path), a.path); }
      result.renamed++;
      result.touched.push(a.oldPath, a.path);
    } catch (e) {
      fail(result, deps, a.path, e);
    }
    await tick();
  }

  // 2. Writes.
  for (const a of writes) {
    try {
      const check = validatePath(a.path, deps.platform);
      if (!check.ok) { skip(result, deps, a.path, check.reason ?? "invalid name"); await tick(); continue; }
      if (deps.caseInsensitiveFs) {
        const other = occupied.get(caseKey(a.path));
        if (other !== undefined && other !== a.path) {
          skip(result, deps, a.path, `differs only in case from "${other}" on a case-insensitive filesystem`);
          await tick();
          continue;
        }
      }
      if (deps.maxFileBytes !== undefined && a.size !== undefined && a.size > deps.maxFileBytes) {
        skip(result, deps, a.path, `larger than the ${deps.maxFileBytes} byte limit`);
        await tick();
        continue;
      }
      // Applies to resurrects too: the user may have re-created the deleted file.
      if (await editedSinceScan(deps, a.path)) {
        skip(result, deps, a.path, "edited during sync");
        await tick();
        continue;
      }
      await writeBlob(deps, a.path, a.sha, a.mode);
      await rememberStat(deps, result, a.path, a.sha);
      setBaselineFile(deps.baseline, a.path, { sha: a.sha, mode: a.mode });
      if (deps.caseInsensitiveFs) occupied.set(caseKey(a.path), a.path);
      result.pulled++;
      result.touched.push(a.path);
    } catch (e) {
      fail(result, deps, a.path, e);
    }
    await tick();
  }

  // 2b. Merges: write the merged text over the local file. The baseline is NOT
  // updated here; the push records the merged sha once the remote has it.
  for (const a of merges) {
    try {
      if (await editedSinceScan(deps, a.path)) {
        skip(result, deps, a.path, "edited during sync");
        await tick();
        continue;
      }
      await deps.vault.writeBytes(a.path, a.merged);
      await rememberStat(deps, result, a.path, await gitBlobSha(a.merged));
      result.merged++;
      result.touched.push(a.path);
    } catch (e) {
      fail(result, deps, a.path, e);
    }
    await tick();
  }

  // 2c. Conflicts: local stays in place; the remote version is written next to it.
  for (const a of conflicts) {
    try {
      if (!a.conflictPath) throw new Error("conflict action without a conflict path (resolve step not run)");
      const check = validatePath(a.conflictPath, deps.platform);
      if (!check.ok) { skip(result, deps, a.path, check.reason ?? "invalid conflict copy name"); await tick(); continue; }
      await writeBlob(deps, a.conflictPath, a.remoteSha, a.mode);
      await rememberStat(deps, result, a.conflictPath, a.remoteSha);
      if (deps.caseInsensitiveFs) occupied.set(caseKey(a.conflictPath), a.conflictPath);
      result.touched.push(a.conflictPath);
      result.conflicts.push({
        path: a.path, conflictPath: a.conflictPath, localSha: a.localSha, remoteSha: a.remoteSha, timestamp: deps.now?.() ?? 0,
      });
      deps.log.warn(`conflict in ${a.path}: remote version saved as ${a.conflictPath}`);
    } catch (e) {
      fail(result, deps, a.path, e);
    }
    await tick();
  }

  // 3. Deletes, then prune directories they emptied (deepest first).
  const emptiedDirs = new Set<Path>();
  for (const a of deletes) {
    try {
      if (await editedSinceScan(deps, a.path)) {
        skip(result, deps, a.path, "edited during sync");
        await tick();
        continue;
      }
      if (await deps.vault.fileExists(a.path)) await deps.vault.deleteFile(a.path);
      removeBaselineFile(deps.baseline, a.path);
      if (deps.caseInsensitiveFs) occupied.delete(caseKey(a.path));
      for (const d of ancestorDirs(a.path)) emptiedDirs.add(d);
      result.deleted++;
      result.touched.push(a.path);
    } catch (e) {
      fail(result, deps, a.path, e);
    }
    await tick();
  }
  const dirsDeepestFirst = [...emptiedDirs].sort((x, y) => y.split("/").length - x.split("/").length);
  for (const d of dirsDeepestFirst) {
    try {
      await deps.vault.removeFolderIfEmpty(d);
    } catch (e) {
      deps.log.warn(`could not remove folder ${d}: ${String(e)}`);
    }
  }

  // Baseline directory shas are refreshed by the orchestrator once the whole
  // sync (including push) has succeeded; here we only track files.
  await deps.persist(deps.baseline);
  return result;
}

async function writeBlob(deps: ApplyDeps, path: Path, sha: Sha, _mode: FileMode): Promise<void> {
  const bytes = await deps.remote.getBlob(deps.repo, sha);
  // Integrity check: the blob id is the hash of its content, so a mismatch means
  // a corrupted or wrong download. Never write such bytes into the vault.
  const actual = await gitBlobSha(bytes);
  if (actual !== sha) {
    throw new Error(`blob ${sha} for ${path} downloaded with sha ${actual}; refusing to write`);
  }
  await deps.vault.writeBytes(path, bytes);
}

async function rememberStat(deps: ApplyDeps, result: ApplyResult, path: Path, sha: Sha): Promise<void> {
  const st = await deps.vault.stat(path);
  if (st) result.cacheUpdates.set(path, { mtime: st.mtime, size: st.size, sha });
}

async function editedSinceScan(deps: ApplyDeps, path: Path): Promise<boolean> {
  if (!deps.scanStats) return false;
  const seen = deps.scanStats.get(path);
  const now = await deps.vault.stat(path);
  if (!seen) return now !== null; // file appeared since the scan
  if (!now) return false;          // file vanished: nothing to protect
  return seen.mtime !== now.mtime || seen.size !== now.size;
}

function skip(result: ApplyResult, deps: ApplyDeps, path: Path, reason: string): void {
  deps.log.warn(`skipped ${path}: ${reason}`);
  result.skipped.push({ path, reason });
}

function fail(result: ApplyResult, deps: ApplyDeps, path: Path, e: unknown): void {
  const error = e instanceof Error ? e : new Error(String(e));
  deps.log.error(`failed ${path}: ${error.message}`);
  result.errors.push({ path, error });
}
