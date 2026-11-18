import type { RemotePort } from "./ports";
import type { Baseline, FileEntry, FileMode, Path, RemoteChange, Sha } from "./types";
import { joinPath, normalizePath, type Excluder } from "./paths";

// Remote tree walk (§5.3) and diff against the baseline.

export interface RemoteSnapshot {
  /** Root tree sha this snapshot describes. */
  rootTree: Sha;
  /** Every blob at the head, keyed by NFC path. `size` is the blob size when the API reported it. */
  files: Record<Path, FileEntry & { size?: number }>;
  /** Tree sha per directory ("" is the root), for skipping unchanged subtrees next time. */
  dirs: Record<Path, Sha>;
  /** Entries we cannot sync (symlinks, submodules, odd modes). Reported, never fatal. */
  skipped: { path: Path; reason: string }[];
}

export interface WalkOptions {
  /** Same exclusion rules as the local scan (§7): excluded paths are invisible, excluded dirs are not fetched. */
  exclude?: Excluder;
  /** Called when a tree level has been fetched; for progress display. */
  onProgress?: (dirsVisited: number, filesSeen: number) => void;
  /** Called between tree fetches so the host can yield to the event loop. */
  yieldToHost?: () => Promise<void>;
}

/**
 * Walk the remote tree one directory at a time, descending only into
 * directories whose tree sha differs from what the baseline recorded.
 * Never uses the recursive listing, so truncation (§6.1) cannot bite us.
 */
export async function walkRemoteTree(
  remote: RemotePort,
  repo: string,
  rootTree: Sha,
  baseline: Baseline | null,
  opts: WalkOptions = {},
): Promise<RemoteSnapshot> {
  const snap: RemoteSnapshot = { rootTree, files: {}, dirs: {}, skipped: [] };
  const queue: { dir: Path; sha: Sha }[] = [{ dir: normalizePath(""), sha: rootTree }];
  let dirsVisited = 0;
  let filesSeen = 0;

  while (queue.length > 0) {
    // Non-null: loop condition guarantees an element.
    const { dir, sha } = queue.shift()!;

    if (baseline && baseline.dirs[dir] === sha) {
      // Unchanged subtree: copy what the baseline knows about it instead of fetching.
      copySubtreeFromBaseline(baseline, dir, snap);
      snap.dirs[dir] = sha;
      continue;
    }

    const tree = await remote.getTree(repo, sha);
    dirsVisited++;
    snap.dirs[dir] = sha;

    for (const entry of tree.entries) {
      const path = joinPath(dir, entry.name.normalize("NFC"));
      if (entry.type === "tree") {
        if (!opts.exclude?.(path, true)) queue.push({ dir: path, sha: entry.sha });
      } else if (opts.exclude?.(path)) {
        continue;
      } else if (entry.type === "commit") {
        snap.skipped.push({ path, reason: "git submodule" });
      } else if (entry.mode === "120000") {
        snap.skipped.push({ path, reason: "symbolic link" });
      } else if (entry.mode === "100644" || entry.mode === "100755") {
        snap.files[path] = { sha: entry.sha, mode: entry.mode as FileMode, size: entry.size };
        filesSeen++;
      } else {
        snap.skipped.push({ path, reason: `unsupported git mode ${entry.mode}` });
      }
    }

    opts.onProgress?.(dirsVisited, filesSeen);
    if (opts.yieldToHost) await opts.yieldToHost();
  }

  return snap;
}

function copySubtreeFromBaseline(baseline: Baseline, dir: Path, snap: RemoteSnapshot): void {
  const prefix = dir === "" ? "" : `${dir}/`;
  for (const [p, entry] of Object.entries(baseline.files) as [Path, FileEntry][]) {
    if (prefix === "" || p.startsWith(prefix)) snap.files[p] = entry;
  }
  for (const [d, sha] of Object.entries(baseline.dirs) as [Path, Sha][]) {
    if (d !== dir && (prefix === "" || d.startsWith(prefix))) snap.dirs[d] = sha;
  }
}

/**
 * Diff a remote snapshot against the baseline. A deletion and an addition with
 * the same blob sha (one each) are reported as a rename so identity survives.
 */
export function diffRemote(
  baseline: Baseline | null,
  snap: RemoteSnapshot,
  /** Baseline paths for which "absent from the snapshot" must NOT mean deleted (now excluded). */
  ignoreMissing: (path: Path) => boolean = () => false,
): RemoteChange[] {
  const base = baseline?.files ?? {};
  const added: { path: Path; sha: Sha; mode: FileMode; size?: number }[] = [];
  const deleted: { path: Path; oldSha: Sha }[] = [];
  const changes: RemoteChange[] = [];

  for (const [path, entry] of Object.entries(snap.files) as [Path, FileEntry & { size?: number }][]) {
    const before = base[path];
    if (!before) added.push({ path, sha: entry.sha, mode: entry.mode, size: entry.size });
    else if (before.sha !== entry.sha || before.mode !== entry.mode) {
      changes.push({ kind: "modified", path, sha: entry.sha, mode: entry.mode, oldSha: before.sha, size: entry.size });
    }
  }
  for (const [path, entry] of Object.entries(base) as [Path, FileEntry][]) {
    if (!snap.files[path] && !ignoreMissing(path)) deleted.push({ path, oldSha: entry.sha });
  }

  // Rename detection: pair up by sha only when the pairing is unambiguous.
  const deletedBySha = new Map<Sha, { path: Path; oldSha: Sha }[]>();
  for (const d of deleted) {
    const list = deletedBySha.get(d.oldSha);
    if (list) list.push(d); else deletedBySha.set(d.oldSha, [d]);
  }
  const addedBySha = new Map<Sha, typeof added>();
  for (const a of added) {
    const list = addedBySha.get(a.sha);
    if (list) list.push(a); else addedBySha.set(a.sha, [a]);
  }
  const consumed = new Set<Path>();
  for (const [sha, dels] of deletedBySha) {
    const adds = addedBySha.get(sha);
    if (dels.length === 1 && adds?.length === 1) {
      changes.push({ kind: "renamed", oldPath: dels[0].path, path: adds[0].path, sha, mode: adds[0].mode });
      consumed.add(dels[0].path);
      consumed.add(adds[0].path);
    }
  }
  for (const a of added) if (!consumed.has(a.path)) changes.push({ kind: "added", ...a });
  for (const d of deleted) if (!consumed.has(d.path)) changes.push({ kind: "deleted", ...d });

  return changes;
}

/**
 * Fetch the remote head and, unless it equals the baseline's, walk and diff it.
 * Returns `null` changes when the remote has not moved.
 */
export async function fetchRemoteChanges(
  remote: RemotePort,
  repo: string,
  branch: string,
  baseline: Baseline | null,
  opts: WalkOptions = {},
): Promise<{ head: Sha | null; snapshot: RemoteSnapshot | null; changes: RemoteChange[] }> {
  const ref = await remote.getRef(repo, branch);
  if (!ref) return { head: null, snapshot: null, changes: [] };
  if (baseline && baseline.remoteHead === ref.sha) {
    return { head: ref.sha, snapshot: null, changes: [] };
  }
  const commit = await remote.getCommit(repo, ref.sha);
  const snapshot = await walkRemoteTree(remote, repo, commit.treeSha, baseline, opts);
  return { head: ref.sha, snapshot, changes: diffRemote(baseline, snapshot, p => opts.exclude?.(p) ?? false) };
}
