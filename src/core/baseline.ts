import type { Baseline, FileEntry, Path } from "./types";
import { ancestorDirs } from "./paths";
import { mkPath } from "./types";

// The only two ways to change `baseline.files`.
//
// Invariant behind the subtree skip in remote-diff.ts: for every recorded
// `baseline.dirs[d] = S`, the baseline's files under `d` are exactly the files of
// git tree S. Changing a file entry breaks that for `d` and all its ancestors, and
// git trees can return to an earlier sha (a revert, an add-then-delete), so a stale
// mapping would make a later walk skip a directory and miss a change. Hence every
// file change drops the cached shas of its ancestors; a clean sync re-records them.

export function setBaselineFile(baseline: Baseline, path: Path, entry: FileEntry): void {
  const before = baseline.files[path];
  if (before && before.sha === entry.sha && before.mode === entry.mode) return;
  baseline.files[path] = entry;
  invalidateDirs(baseline, path);
}

export function removeBaselineFile(baseline: Baseline, path: Path): void {
  if (!(path in baseline.files)) return;
  delete baseline.files[path];
  invalidateDirs(baseline, path);
}

function invalidateDirs(baseline: Baseline, path: Path): void {
  delete baseline.dirs[mkPath("")];
  for (const d of ancestorDirs(path)) delete baseline.dirs[d];
}
