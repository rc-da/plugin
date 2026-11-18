import type { StatePort, VaultPort } from "./ports";
import type { LocalChange } from "./types";
import { scanLocal, type RenameRecord } from "./scan";
import type { Excluder } from "./paths";

// Local changes since the last sync, for the review modal (§10). Same scan the sync
// uses; the refreshed mtime/size cache is saved so the following sync reads nothing again.

export interface PreviewInput {
  vault: VaultPort;
  state: StatePort;
  repo: string;
  branch: string;
  exclude: Excluder;
  pendingRenames?: RenameRecord[];
  maxFileBytes?: number;
  yieldToHost?: () => Promise<void>;
}

export interface Preview {
  changes: LocalChange[];
  /** True without a matching baseline: everything is "added" and the first sync merges both sides. */
  firstSync: boolean;
}

export async function previewLocalChanges(input: PreviewInput): Promise<Preview> {
  let baseline = await input.state.loadBaseline(input.repo, input.branch);
  if (baseline && (baseline.repo !== input.repo || baseline.branch !== input.branch)) baseline = null;
  const scan = await scanLocal({
    vault: input.vault, baseline, cache: await input.state.loadLocalCache(), exclude: input.exclude,
    pendingRenames: input.pendingRenames, maxFileBytes: input.maxFileBytes, yieldToHost: input.yieldToHost,
  });
  await input.state.saveLocalCache(scan.cache);
  const key = (c: LocalChange) => c.path;
  return { changes: [...scan.changes].sort((x, y) => (key(x) < key(y) ? -1 : 1)), firstSync: baseline === null };
}
