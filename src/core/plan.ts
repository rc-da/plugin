import type { Baseline, FileMode, LocalChange, Path, RemoteChange, Sha, SyncAction, SyncPlan } from "./types";

// Build a SyncPlan from local + remote change lists (§5.4). Pure.
//
// Renames are kept whole only when the other side left both paths alone;
// otherwise they are decomposed into delete + add and handled per path.

type Side =
  | { kind: "added"; sha: Sha; mode: FileMode; size?: number }
  | { kind: "modified"; sha: Sha; mode: FileMode; oldSha: Sha; size?: number }
  | { kind: "deleted"; oldSha: Sha };

export interface PlanInput {
  baseline: Baseline | null;
  local: LocalChange[];
  remote: RemoteChange[];
  remoteHead: Sha | null;
}

export function buildPlan(input: PlanInput): SyncPlan {
  const { baseline, local, remote } = input;
  const actions: SyncAction[] = [];
  const localTouched = new Set<Path>();
  const remoteTouched = new Set<Path>();
  for (const c of local) { localTouched.add(c.path); if (c.kind === "renamed") localTouched.add(c.oldPath); }
  for (const c of remote) { remoteTouched.add(c.path); if (c.kind === "renamed") remoteTouched.add(c.oldPath); }

  const L = new Map<Path, Side>();
  const R = new Map<Path, Side>();

  for (const c of local) {
    if (c.kind === "renamed") {
      if (!remoteTouched.has(c.oldPath) && !remoteTouched.has(c.path)) {
        actions.push({ kind: "pushRename", oldPath: c.oldPath, path: c.path, sha: c.sha });
        continue;
      }
      const base = baseline?.files[c.oldPath];
      L.set(c.oldPath, { kind: "deleted", oldSha: base?.sha ?? c.sha });
      L.set(c.path, { kind: "added", sha: c.sha, mode: base?.mode ?? "100644" });
    } else if (c.kind === "added") {
      L.set(c.path, { kind: "added", sha: c.sha, mode: baseline?.files[c.path]?.mode ?? "100644" });
    } else if (c.kind === "modified") {
      L.set(c.path, { kind: "modified", sha: c.sha, oldSha: c.oldSha, mode: baseline?.files[c.path]?.mode ?? "100644" });
    } else {
      L.set(c.path, { kind: "deleted", oldSha: c.oldSha });
    }
  }

  for (const c of remote) {
    if (c.kind === "renamed") {
      if (!localTouched.has(c.oldPath) && !localTouched.has(c.path)) {
        actions.push({ kind: "pullRename", oldPath: c.oldPath, path: c.path, sha: c.sha, mode: c.mode });
        continue;
      }
      R.set(c.oldPath, { kind: "deleted", oldSha: c.sha });
      R.set(c.path, { kind: "added", sha: c.sha, mode: c.mode });
    } else if (c.kind === "added") {
      R.set(c.path, { kind: "added", sha: c.sha, mode: c.mode, size: c.size });
    } else if (c.kind === "modified") {
      R.set(c.path, { kind: "modified", sha: c.sha, mode: c.mode, oldSha: c.oldSha, size: c.size });
    } else {
      R.set(c.path, { kind: "deleted", oldSha: c.oldSha });
    }
  }

  const paths = new Set<Path>([...L.keys(), ...R.keys()]);
  for (const path of paths) {
    actions.push(decide(path, L.get(path), R.get(path), baseline?.files[path]?.sha ?? null));
  }

  return { actions, remoteHead: input.remoteHead };
}

function decide(path: Path, l: Side | undefined, r: Side | undefined, baseSha: Sha | null): SyncAction {
  // ── only one side changed ──
  if (!l && r) {
    if (r.kind === "deleted") return { kind: "pullDelete", path };
    return r.size === undefined
      ? { kind: "pull", path, sha: r.sha, mode: r.mode }
      : { kind: "pull", path, sha: r.sha, mode: r.mode, size: r.size };
  }
  if (l && !r) {
    if (l.kind === "deleted") return { kind: "pushDelete", path };
    return { kind: "push", path, sha: l.sha };
  }
  if (!l || !r) return { kind: "skip", path, reason: "no change on either side" }; // unreachable

  // ── both deleted ──
  if (l.kind === "deleted" && r.kind === "deleted") return { kind: "baselineRemove", path };

  // ── edits beat deletes ──
  if (l.kind === "deleted") {
    // r has content (added or modified)
    return r.kind === "deleted"
      ? { kind: "baselineRemove", path }
      : r.size === undefined
        ? { kind: "resurrect", path, sha: r.sha, mode: r.mode }
        : { kind: "resurrect", path, sha: r.sha, mode: r.mode, size: r.size };
  }
  if (r.kind === "deleted") {
    return { kind: "keepLocal", path, sha: l.sha };
  }

  // ── both have content ──
  if (l.sha === r.sha) return { kind: "baselineSet", path, sha: r.sha, mode: r.mode };

  if (l.kind === "modified" && r.kind === "modified") {
    // Merge candidate; merge.ts decides merge vs conflict.
    return { kind: "bothChanged", path, localSha: l.sha, remoteSha: r.sha, baseSha, mode: r.mode };
  }
  // added/added (first sync, or both created the same name) or an inconsistent
  // added/modified pairing: there is no common base, so never overwrite either.
  return { kind: "conflict", path, localSha: l.sha, remoteSha: r.sha, mode: r.mode };
}

/** Count what a plan would delete on each side (input to the mass-deletion guard, §5.6). */
export function countDeletions(plan: SyncPlan): { local: number; remote: number } {
  let local = 0;
  let remote = 0;
  for (const a of plan.actions) {
    if (a.kind === "pullDelete") local++;
    else if (a.kind === "pushDelete") remote++;
  }
  return { local, remote };
}
