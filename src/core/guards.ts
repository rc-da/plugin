import type { Baseline, GuardStop, Path, Sha, SyncPlan } from "./types";

export type { GuardStop };

// Safety guards (§5.6) that run after planning and before anything is changed.
// They are pure: the orchestrator calls them and turns a non-null result into a
// "stopped" sync. A manual sync can show the stop to the user and re-run with
// the matching approval; a silent sync just flags the status bar.

export interface GuardApprovals {
  /**
   * Deletions the user confirmed after a `massDelete` stop. The guard lets a plan
   * through only if every deletion it would make is in these lists, so a plan
   * that grew in the meantime asks again.
   */
  deletions?: { local: readonly Path[]; remote: readonly Path[] };
  /**
   * Answer to an `emptyRemote` stop, valid only for the head it was given for.
   * - "reupload": forget the baseline and treat this as a first sync, so the
   *   local vault is pushed back and nothing is deleted anywhere.
   * - "applyDeletions": the remote really was emptied on purpose; delete locally.
   */
  emptyRemote?: { head: Sha | null; resolution: "reupload" | "applyDeletions" };
}

export interface MassDeleteLimits {
  /** Never stop for this many deletions or fewer. Default 10. */
  min?: number;
  /** …or for this fraction of the side's files or fewer. Default 0.05. */
  ratio?: number;
}

/** max(min, ratio × files): a plan may delete up to this many files per side. */
export function massDeleteThreshold(fileCount: number, limits: MassDeleteLimits = {}): number {
  return Math.max(limits.min ?? 10, (limits.ratio ?? 0.05) * fileCount);
}

/**
 * Deletions in a plan, per side. A deletion whose old content reappears under a
 * new path on the same side is a rename (e.g. a folder rename decomposed into
 * delete + add) and is not counted: renames are not deletions (§9).
 */
export function plannedDeletions(plan: SyncPlan, baseline: Baseline): { local: Path[]; remote: Path[] } {
  const pulledShas = new Set<Sha>();
  const pushedShas = new Set<Sha>();
  for (const a of plan.actions) {
    if (a.kind === "pull" || a.kind === "resurrect") pulledShas.add(a.sha);
    else if (a.kind === "push" || a.kind === "keepLocal") pushedShas.add(a.sha);
  }
  const local: Path[] = [];
  const remote: Path[] = [];
  for (const a of plan.actions) {
    const old = baseline.files[a.path]?.sha;
    if (a.kind === "pullDelete" && !(old !== undefined && pulledShas.has(old))) local.push(a.path);
    else if (a.kind === "pushDelete" && !(old !== undefined && pushedShas.has(old))) remote.push(a.path);
  }
  return { local, remote };
}

export interface MassDeleteInput {
  plan: SyncPlan;
  baseline: Baseline;
  localFileCount: number;
  remoteFileCount: number;
  limits?: MassDeleteLimits;
  approved?: GuardApprovals["deletions"];
  /** Skip the local side (the user already approved emptying it via `emptyRemote`). */
  localApproved?: boolean;
}

export function checkMassDelete(input: MassDeleteInput): GuardStop | null {
  const { local, remote } = plannedDeletions(input.plan, input.baseline);
  const tooManyLocal = !input.localApproved && local.length > massDeleteThreshold(input.localFileCount, input.limits);
  const tooManyRemote = remote.length > massDeleteThreshold(input.remoteFileCount, input.limits);
  if (!tooManyLocal && !tooManyRemote) return null;
  if (input.approved && covers(input.approved.local, local) && covers(input.approved.remote, remote)) return null;
  const parts: string[] = [];
  if (tooManyLocal) parts.push(`${local.length} of ${input.localFileCount} files in this vault`);
  if (tooManyRemote) parts.push(`${remote.length} of ${input.remoteFileCount} files on GitHub`);
  return {
    kind: "massDelete",
    local,
    remote,
    message: `This sync would delete ${parts.join(" and ")}. Nothing was changed; review and confirm to continue.`,
  };
}

function covers(approved: readonly Path[], wanted: Path[]): boolean {
  const set = new Set(approved);
  return wanted.every(p => set.has(p));
}

/**
 * Empty-remote check. `remoteFiles` is the number of files on the remote after
 * excludes (null when the branch is missing). Returns a stop unless the baseline
 * is empty too or the user approved this exact head.
 */
export function checkEmptyRemote(
  baseline: Baseline,
  head: Sha | null,
  remoteFiles: number,
  approved?: GuardApprovals["emptyRemote"],
): GuardStop | null {
  const baselineFiles = Object.keys(baseline.files).length;
  if (remoteFiles > 0 || baselineFiles === 0) return null;
  if (approved && approved.head === head) return null;
  return {
    kind: "emptyRemote",
    head,
    baselineFiles,
    message: head === null
      ? `The branch is missing on GitHub, but ${baselineFiles} files were synced with it before. Nothing was changed.`
      : `The branch on GitHub is empty, but ${baselineFiles} files were synced with it before. Nothing was changed.`,
  };
}
