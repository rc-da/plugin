import type { VaultPort } from "./ports";
import type { Baseline, FileEntry, LocalCache, LocalChange, Path, Sha } from "./types";
import { gitBlobSha } from "./hash";
import { normalizePath, type Excluder } from "./paths";

// Local change detection (§5.2). Reads only files whose (mtime, size) no longer
// matches the cache; everything else reuses the cached sha.

export interface RenameRecord {
  from: Path;
  to: Path;
}

export interface ScanInput {
  vault: VaultPort;
  baseline: Baseline | null;
  /** Previous cache; a fresh, pruned copy is returned. Safe to lose. */
  cache: LocalCache;
  exclude: Excluder;
  /** Renames observed by the host since the last sync, oldest first. */
  pendingRenames?: RenameRecord[];
  /** Files above this size are skipped (never read, never treated as deleted). */
  maxFileBytes?: number;
  /** Yield to the host every N hashed files so the GC can run (§5.2). */
  yieldEvery?: number;
  yieldToHost?: () => Promise<void>;
  onProgress?: (scanned: number, total: number) => void;
}

export interface ScanResult {
  /** Current local state of every synced file. */
  files: Record<Path, FileEntry>;
  /** (mtime, size) per file at scan time, for the edited-during-sync guard. */
  stats: Map<Path, { mtime: number; size: number }>;
  changes: LocalChange[];
  cache: LocalCache;
  skipped: { path: Path; reason: string }[];
}

export async function scanLocal(input: ScanInput): Promise<ScanResult> {
  const { vault, baseline, exclude } = input;
  const yieldEvery = input.yieldEvery ?? 25;
  const files: Record<Path, FileEntry> = {};
  const stats = new Map<Path, { mtime: number; size: number }>();
  const skipped: ScanResult["skipped"] = [];
  const cache: LocalCache = {};
  const base = baseline?.files ?? {};

  const listed = await vault.listFiles();
  const total = listed.length;
  let scanned = 0;
  let hashedSinceYield = 0;

  for (const f of listed) {
    scanned++;
    const path = normalizePath(f.path);
    if (exclude(path)) continue;
    if (input.maxFileBytes !== undefined && f.size > input.maxFileBytes) {
      skipped.push({ path, reason: `larger than the ${input.maxFileBytes} byte limit` });
      continue;
    }

    const cached = input.cache[path];
    let sha: Sha;
    if (cached && cached.mtime === f.mtime && cached.size === f.size) {
      sha = cached.sha;
    } else {
      // f.path is the host's spelling (may be NFD); the port resolves it.
      const bytes = await vault.readBytes(f.path);
      sha = await gitBlobSha(bytes);
      if (++hashedSinceYield >= yieldEvery && input.yieldToHost) {
        hashedSinceYield = 0;
        await input.yieldToHost();
      }
    }
    cache[path] = { mtime: f.mtime, size: f.size, sha };
    stats.set(path, { mtime: f.mtime, size: f.size });
    // Obsidian exposes no exec bit: keep the mode the repo already has, else 100644.
    files[path] = { sha, mode: base[path]?.mode ?? "100644" };
    input.onProgress?.(scanned, total);
  }

  const skippedPaths = new Set(skipped.map(s => s.path));
  const changes = diffLocal(base, files, {
    renames: compactRenames(input.pendingRenames ?? []),
    ignoreMissing: (p: Path) => skippedPaths.has(p) || exclude(p),
  });

  return { files, stats, changes, cache, skipped };
}

/**
 * Fold a rename log so chains (a→b, b→c) become a→c and round trips (a→b, b→a) vanish.
 * Returns a map from original path to final path.
 */
export function compactRenames(log: RenameRecord[]): Map<Path, Path> {
  const finalOf = new Map<Path, Path>();   // original → current
  const originOf = new Map<Path, Path>();  // current → original
  for (const { from, to } of log) {
    const origin = originOf.get(from) ?? from;
    originOf.delete(from);
    finalOf.set(origin, to);
    originOf.set(to, origin);
  }
  for (const [origin, current] of finalOf) if (origin === current) finalOf.delete(origin);
  return finalOf;
}

/**
 * Diff the current local files against the baseline.
 * Baseline paths that are now excluded or skipped are not reported as deleted:
 * "don't sync this" must never turn into "delete this on the remote".
 */
export function diffLocal(
  base: Record<Path, FileEntry>,
  files: Record<Path, FileEntry>,
  opts: { renames: Map<Path, Path>; ignoreMissing: (p: Path) => boolean },
): LocalChange[] {
  const changes: LocalChange[] = [];
  const handled = new Set<Path>();

  // 1. Renames the host told us about: old path gone, new path present, old path was synced.
  for (const [from, to] of opts.renames) {
    const before = base[from];
    const now = files[to];
    if (!before || !now || files[from] || base[to]) continue;
    changes.push({ kind: "renamed", oldPath: from, path: to, sha: now.sha });
    handled.add(from);
    handled.add(to);
  }

  const added: { path: Path; sha: Sha }[] = [];
  const deleted: { path: Path; oldSha: Sha }[] = [];
  for (const [path, entry] of Object.entries(files) as [Path, FileEntry][]) {
    if (handled.has(path)) continue;
    const before = base[path];
    if (!before) added.push({ path, sha: entry.sha });
    else if (before.sha !== entry.sha) changes.push({ kind: "modified", path, sha: entry.sha, oldSha: before.sha });
  }
  for (const [path, entry] of Object.entries(base) as [Path, FileEntry][]) {
    if (handled.has(path) || files[path] || opts.ignoreMissing(path)) continue;
    deleted.push({ path, oldSha: entry.sha });
  }

  // 2. Renames we can infer: exactly one deletion and one addition with the same content.
  const delBySha = groupBy(deleted, d => d.oldSha);
  const addBySha = groupBy(added, a => a.sha);
  const consumed = new Set<Path>();
  for (const [sha, dels] of delBySha) {
    const adds = addBySha.get(sha);
    if (dels.length === 1 && adds?.length === 1) {
      changes.push({ kind: "renamed", oldPath: dels[0].path, path: adds[0].path, sha });
      consumed.add(dels[0].path);
      consumed.add(adds[0].path);
    }
  }
  for (const a of added) if (!consumed.has(a.path)) changes.push({ kind: "added", ...a });
  for (const d of deleted) if (!consumed.has(d.path)) changes.push({ kind: "deleted", ...d });
  return changes;
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = out.get(k);
    if (list) list.push(it); else out.set(k, [it]);
  }
  return out;
}
