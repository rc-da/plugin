import type { Logger, PushTreeEntry, RemotePort, VaultPort } from "./ports";
import type { Baseline, FileMode, Path, Sha, SyncAction, SyncPlan } from "./types";
import { SyncError } from "./types";
import { gitBlobSha } from "./hash";
import { decodeUtf8, isTextFile } from "./merge";

// Push side of a plan (§5.8): build trees on top of the remote head, commit, update the ref.
// Nothing here mutates the baseline; the orchestrator does that after updateRef succeeds,
// using the `written` list returned.

export interface PushDeps {
  vault: VaultPort;
  remote: RemotePort;
  repo: string;
  branch: string;
  baseline: Baseline;
  /** Commit the new tree on top of this commit… */
  parentCommit: Sha;
  /** …whose root tree is this. */
  parentTree: Sha;
  message: string;
  log: Logger;
  /** Split tree requests beyond these limits (defaults ~8 MB / 500 entries). */
  maxBodyBytes?: number;
  maxEntries?: number;
  /** Called before each binary blob upload; the host can slow down here (§6.1 secondary limit). */
  throttle?: () => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}

export interface PushResult {
  commitSha: Sha;
  treeSha: Sha;
  /** Final content per path as committed: the orchestrator copies this into the baseline. */
  written: { path: Path; sha: Sha; mode: FileMode }[];
  /** Paths removed from the repo (including rename sources). */
  removed: Path[];
  skipped: { path: Path; reason: string }[];
}

type PushAction = Extract<SyncAction, { kind: "push" | "pushRename" | "pushDelete" | "keepLocal" | "merge" | "conflict" }>;

export function isPushAction(a: SyncAction): a is PushAction {
  return a.kind === "push" || a.kind === "pushRename" || a.kind === "pushDelete" || a.kind === "keepLocal"
    || a.kind === "merge" || a.kind === "conflict";
}

const DEFAULT_MAX_BODY = 8 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 500;

/**
 * Push every push-side action of the plan. Returns null when there is nothing to
 * push (no empty commits). Throws SyncError("Conflict422") if the ref moved.
 */
export async function pushPlan(plan: SyncPlan, deps: PushDeps): Promise<PushResult | null> {
  const actions = plan.actions.filter(isPushAction);
  if (actions.length === 0) return null;

  const entries: PushTreeEntry[] = [];
  const written: PushResult["written"] = [];
  const removed: Path[] = [];
  const skipped: PushResult["skipped"] = [];
  let done = 0;
  const tick = () => deps.onProgress?.(++done, actions.length);

  for (const a of actions) {
    try {
      switch (a.kind) {
        case "pushDelete":
          entries.push({ path: a.path, mode: "100644", sha: null });
          removed.push(a.path);
          break;

        case "pushRename": {
          const before = deps.baseline.files[a.oldPath];
          entries.push({ path: a.oldPath, mode: "100644", sha: null });
          removed.push(a.oldPath);
          if (before && before.sha === a.sha) {
            // Content unchanged: point the new path at the blob the repo already has.
            entries.push({ path: a.path, mode: before.mode, sha: before.sha });
            written.push({ path: a.path, sha: before.sha, mode: before.mode });
          } else {
            const e = await contentEntry(deps, a.path, before?.mode ?? "100644");
            entries.push(e.entry);
            written.push(e.written);
          }
          break;
        }

        case "push":
        case "keepLocal": {
          const mode = deps.baseline.files[a.path]?.mode ?? "100644";
          const e = await contentEntry(deps, a.path, mode);
          entries.push(e.entry);
          written.push(e.written);
          break;
        }

        case "merge": {
          const e = await bytesEntry(deps, a.path, a.merged, a.mode);
          entries.push(e.entry);
          written.push(e.written);
          break;
        }

        case "conflict": {
          // Local wins at `path`; the remote version lives on at `conflictPath`, which
          // can reference the blob the repo already has — nothing to upload for it.
          if (!a.conflictPath) throw new Error("conflict action without a conflict path (resolve step not run)");
          const e = await contentEntry(deps, a.path, a.mode);
          entries.push(e.entry);
          written.push(e.written);
          entries.push({ path: a.conflictPath, mode: a.mode, sha: a.remoteSha });
          written.push({ path: a.conflictPath, sha: a.remoteSha, mode: a.mode });
          break;
        }
      }
    } catch (err) {
      if (err instanceof SyncError) throw err; // network/auth problems abort the push
      const msg = err instanceof Error ? err.message : String(err);
      deps.log.warn(`not pushing ${a.path}: ${msg}`);
      skipped.push({ path: a.path, reason: msg });
    }
    tick();
  }

  if (entries.length === 0) return null;

  const treeSha = await postTreeChunked(deps, entries);
  const commitSha = await deps.remote.postCommit(deps.repo, deps.branch, treeSha, deps.parentCommit, deps.message);
  await deps.remote.updateRef(deps.repo, deps.branch, commitSha); // throws Conflict422 if not fast-forward
  return { commitSha, treeSha, written, removed, skipped };
}

/** Read the file now and build its tree entry. The sha recorded is of what was actually read. */
async function contentEntry(deps: PushDeps, path: Path, mode: FileMode) {
  if (!(await deps.vault.fileExists(path))) {
    throw new Error("file disappeared before it could be pushed");
  }
  const bytes = await deps.vault.readBytes(path);
  return bytesEntry(deps, path, bytes, mode);
}

async function bytesEntry(
  deps: PushDeps,
  path: Path,
  bytes: Uint8Array,
  mode: FileMode,
): Promise<{ entry: PushTreeEntry; written: PushResult["written"][number] }> {
  const sha = await gitBlobSha(bytes);
  if (isTextFile(path, bytes)) {
    // Text goes inline in the tree request: no blob request, no secondary-limit hit.
    return { entry: { path, mode, content: decodeUtf8(bytes) }, written: { path, sha, mode } };
  }
  if (deps.throttle) await deps.throttle();
  const uploaded = await deps.remote.postBlob(deps.repo, bytes);
  if (uploaded !== sha) {
    throw new Error(`uploaded blob sha ${uploaded} does not match local ${sha}`);
  }
  return { entry: { path, mode, sha }, written: { path, sha, mode } };
}

/** POST the entries as one tree, or as a chain of trees when they exceed the size limits. */
async function postTreeChunked(deps: PushDeps, entries: PushTreeEntry[]): Promise<Sha> {
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  let base = deps.parentTree;
  let chunk: PushTreeEntry[] = [];
  let chunkBytes = 0;

  const flush = async () => {
    if (chunk.length === 0) return;
    base = await deps.remote.postTree(deps.repo, chunk, base);
    chunk = [];
    chunkBytes = 0;
  };

  for (const e of entries) {
    const size = entrySize(e);
    if (chunk.length > 0 && (chunk.length >= maxEntries || chunkBytes + size > maxBody)) await flush();
    chunk.push(e);
    chunkBytes += size;
  }
  await flush();
  return base;
}

/** Rough JSON body cost of one entry (UTF-16 length over-estimates multi-byte, which is the safe side). */
function entrySize(e: PushTreeEntry): number {
  return 64 + e.path.length + (e.content?.length ?? 0) * 1.1;
}

/** Fill the commit message template: {{device}}, {{date}}, {{count}}. */
export function renderCommitMessage(template: string, vars: { device: string; date: string; count: number }): string {
  return template
    .replace(/\{\{\s*device\s*\}\}/g, vars.device)
    .replace(/\{\{\s*date\s*\}\}/g, vars.date)
    .replace(/\{\{\s*count\s*\}\}/g, String(vars.count));
}

export const DEFAULT_COMMIT_TEMPLATE = "vault sync: {{count}} change(s) from {{device}} at {{date}}";
