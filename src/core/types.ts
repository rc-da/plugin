// Branded string types so paths and shas can't be mixed up accidentally.
export type Path = string & { readonly __path: unique symbol };
export type Sha = string & { readonly __sha: unique symbol };

export function mkPath(s: string): Path { return s as Path; }
export function mkSha(s: string): Sha { return s as Sha; }

export type FileMode = "100644" | "100755";

export interface FileEntry {
  sha: Sha;
  mode: FileMode;
}

export interface Baseline {
  repo: string;
  branch: string;
  remoteHead: Sha | null;
  files: Record<Path, FileEntry>;
  dirs: Record<Path, Sha>;
  /**
   * Fingerprint of the exclusion rules `dirs` was recorded under. When the rules
   * change, `dirs` is discarded so previously skipped subtrees are fetched again.
   */
  excludeKey?: string;
}

export interface LocalCacheEntry {
  mtime: number;
  size: number;
  sha: Sha;
}

export type LocalCache = Record<Path, LocalCacheEntry>;

export type LocalChange =
  | { kind: "added";    path: Path; sha: Sha }
  | { kind: "modified"; path: Path; sha: Sha; oldSha: Sha }
  | { kind: "deleted";  path: Path; oldSha: Sha }
  | { kind: "renamed";  oldPath: Path; path: Path; sha: Sha };

export type RemoteChange =
  | { kind: "added";    path: Path; sha: Sha; mode: FileMode; size?: number }
  | { kind: "modified"; path: Path; sha: Sha; mode: FileMode; oldSha: Sha; size?: number }
  | { kind: "deleted";  path: Path; oldSha: Sha }
  | { kind: "renamed";  oldPath: Path; path: Path; sha: Sha; mode: FileMode };

export type SyncAction =
  // ── pull side (executed by apply.ts) ──
  | { kind: "pull";           path: Path; sha: Sha; mode: FileMode; size?: number }
  | { kind: "pullRename";     oldPath: Path; path: Path; sha: Sha; mode: FileMode }
  | { kind: "pullDelete";     path: Path }
  /** Local deleted, remote modified: edits beat deletes → bring the remote version back. */
  | { kind: "resurrect";      path: Path; sha: Sha; mode: FileMode; size?: number }
  // ── push side (executed by push.ts) ──
  | { kind: "push";           path: Path; sha: Sha }
  | { kind: "pushRename";     oldPath: Path; path: Path; sha: Sha }
  | { kind: "pushDelete";     path: Path }
  /** Local modified, remote deleted: edits beat deletes → push the local version back. */
  | { kind: "keepLocal";      path: Path; sha: Sha }
  // ── both sides changed ──
  /** Both changed, different content. The merge step (merge.ts) turns this into "merge" or "conflict". */
  | { kind: "bothChanged";    path: Path; localSha: Sha; remoteSha: Sha; baseSha: Sha | null; mode: FileMode }
  /** Local stays at `path`; the remote version is written next to it at `conflictPath` (assigned by the resolve step). */
  | { kind: "conflict";       path: Path; localSha: Sha; remoteSha: Sha; mode: FileMode; conflictPath?: Path }
  | { kind: "merge";          path: Path; merged: Uint8Array; localSha: Sha; remoteSha: Sha; mode: FileMode }
  // ── bookkeeping ──
  /** Both sides already agree: just record it in the baseline. */
  | { kind: "baselineSet";    path: Path; sha: Sha; mode: FileMode }
  /** Deleted on both sides: forget it. */
  | { kind: "baselineRemove"; path: Path }
  | { kind: "skip";           path: Path; reason: string };

export interface SyncPlan {
  actions: SyncAction[];
  remoteHead: Sha | null;
}

export type SyncStatus =
  /** Everything planned was done. */
  | "ok"
  /** Nothing to do on either side. */
  | "noop"
  /** Some files were skipped or failed; the rest went through. */
  | "partial"
  /** A guard stopped the sync before anything was changed. */
  | "stopped";

export interface SyncResult {
  status: SyncStatus;
  pulled: number;
  pushed: number;
  deleted: number;
  renamed: number;
  conflicts: number;
  merged: number;
  skipped: { path: Path; reason: string }[];
  errors: { path: Path | null; message: string }[];
  remoteHead: Sha | null;
  /** Number of push attempts it took (>1 means another device raced us). */
  attempts: number;
  /** Why a guard stopped the sync (status "stopped"); the host shows it or asks for approval. */
  stop?: GuardStop;
  /**
   * Local paths the sync itself wrote, renamed or deleted. File events for these
   * are the sync's own and must not count as user edits (no self-triggered syncs).
   */
  wroteLocally: Path[];
}

/** A safety guard (§5.6) stopped the sync before anything changed. See core/guards.ts. */
export type GuardStop =
  /** The plan deletes more than the threshold on at least one side. */
  | { kind: "massDelete"; local: Path[]; remote: Path[]; message: string }
  /**
   * The remote branch is empty (or gone) while our baseline says it held files:
   * wrong branch, wiped repo or force-push. `head` is null when the branch is missing.
   */
  | { kind: "emptyRemote"; head: Sha | null; baselineFiles: number; message: string }
  /** A host-supplied guard said no. */
  | { kind: "custom"; message: string };


export interface ConflictRecord {
  path: Path;
  conflictPath: Path;
  localSha: Sha;
  remoteSha: Sha;
  timestamp: number;
}

// ── Typed errors ────────────────────────────────────────────────────────────

export type SyncErrorKind =
  | "Offline"
  | "Timeout"
  | "AuthInvalid"
  | "PermissionDenied"
  | "RateLimited"
  | "NotFound"
  | "EmptyRepo"
  | "Conflict422"
  | "BranchProtected"
  | "ServerError"
  | "TooLarge"
  | "Unexpected";

export class SyncError extends Error {
  constructor(
    public readonly kind: SyncErrorKind,
    message: string,
    public readonly resetAt?: number,
  ) {
    super(message);
    this.name = "SyncError";
  }
}
