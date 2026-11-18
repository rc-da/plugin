import { diff3Merge } from "node-diff3";
import type { Logger, RemotePort, VaultPort } from "./ports";
import type { Clock } from "./ports";
import type { Path, Sha, SyncAction, SyncPlan } from "./types";
import { SyncError } from "./types";
import { gitBlobSha } from "./hash";
import { baseName, parentDir, joinPath } from "./paths";

// Text/binary classification, the 3-way text merge (§5.4) and the resolve step
// that turns "bothChanged" plan entries into "merge" or "conflict" (§5.5).

// ── Classification ──────────────────────────────────────────────────────────

/** Extensions we are willing to treat as text (merge, inline upload). */
export const TEXT_EXTENSIONS = new Set(["md", "txt", "canvas", "json", "css", "js", "csv", "yaml", "yml", "base"]);

/** Formats that must still parse after a merge; otherwise the merge is a conflict. */
export const JSON_EXTENSIONS = new Set(["canvas", "json"]);

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

const SNIFF_BYTES = 8 * 1024;

/**
 * True when the bytes are valid UTF-8 end to end. Uses a fatal decoder with
 * `ignoreBOM` so a leading BOM counts as content (and survives round-trips).
 */
export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function hasNulInPrefix(bytes: Uint8Array, limit = SNIFF_BYTES): boolean {
  const n = Math.min(bytes.byteLength, limit);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * A file is text when its extension is on the allow-list AND its bytes are
 * valid UTF-8 with no NUL in the first 8 KB. Everything else is binary and is
 * never decoded. Text files may be uploaded inline and merged line-wise.
 */
export function isTextFile(path: string, bytes: Uint8Array): boolean {
  if (!TEXT_EXTENSIONS.has(extensionOf(path))) return false;
  if (hasNulInPrefix(bytes)) return false;
  return isValidUtf8(bytes);
}

/** Decode bytes already known to be valid UTF-8, keeping any BOM. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ── 3-way merge ─────────────────────────────────────────────────────────────

export type MergeOutcome = { ok: true; merged: string } | { ok: false; reason: string };

/**
 * Line-based diff3. Lines are split on "\n" only, so a "\r" stays part of its
 * line and CRLF files round-trip unchanged. A missing trailing newline is kept.
 */
export function mergeText(base: string, local: string, remote: string): MergeOutcome {
  if (local === remote) return { ok: true, merged: local };
  if (local === base) return { ok: true, merged: remote };
  if (remote === base) return { ok: true, merged: local };

  const regions = diff3Merge(local.split("\n"), base.split("\n"), remote.split("\n"), { excludeFalseConflicts: true });
  const out: string[] = [];
  for (const r of regions) {
    if (r.ok) out.push(...r.ok);
    else if (r.conflict) return { ok: false, reason: "overlapping edits" };
  }
  return { ok: true, merged: out.join("\n") };
}

/**
 * Merge three versions of a file. Any side that is not text (by extension and
 * content) makes this a conflict. JSON-like formats are re-parsed after merging.
 */
export function mergeBytes(path: string, base: Uint8Array, local: Uint8Array, remote: Uint8Array): MergeOutcome & { bytes?: Uint8Array } {
  if (!isTextFile(path, base) || !isTextFile(path, local) || !isTextFile(path, remote)) {
    return { ok: false, reason: "binary file" };
  }
  const r = mergeText(decodeUtf8(base), decodeUtf8(local), decodeUtf8(remote));
  if (!r.ok) return r;
  if (JSON_EXTENSIONS.has(extensionOf(path))) {
    try {
      JSON.parse(r.merged);
    } catch {
      return { ok: false, reason: "merged result is not valid JSON" };
    }
  }
  return { ok: true, merged: r.merged, bytes: encodeUtf8(r.merged) };
}

// ── Conflict copy naming ────────────────────────────────────────────────────

/** `YYYY-MM-DD HHmm` in local time. */
export function conflictStamp(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Make a device name safe inside a file name. */
export function safeDeviceName(device: string): string {
  const cleaned = device.replace(/[*"\\/<>:|?\u0000-\u001f]/g, "-").trim();
  return cleaned === "" ? "device" : cleaned;
}

/** `notes/a.md` → `notes/a (conflict phone 2026-11-14 0932).md`, with " 2", " 3"… if taken. */
export async function conflictCopyPath(
  path: Path,
  device: string,
  epochMs: number,
  taken: (candidate: Path) => Promise<boolean>,
): Promise<Path> {
  const dir = parentDir(path);
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? "" : name.slice(dot);
  const tag = `(conflict ${safeDeviceName(device)} ${conflictStamp(epochMs)})`;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : ` ${n}`;
    const candidate = joinPath(dir ?? "", `${stem} ${tag}${suffix}${ext}`);
    if (!(await taken(candidate))) return candidate;
  }
}

// ── Resolve step ────────────────────────────────────────────────────────────

export interface ResolveDeps {
  vault: VaultPort;
  remote: RemotePort;
  repo: string;
  clock: Clock;
  deviceName: string;
  log: Logger;
}

export interface ResolveStats {
  merged: number;
  conflicts: number;
}

/**
 * Turn every "bothChanged" into "merge" (clean 3-way merge) or "conflict", and
 * give every "conflict" its conflict-copy path. Network errors propagate; a
 * problem with a single file degrades that file to a conflict or skip, never
 * aborting the sync (§5.5).
 */
export async function resolvePlan(plan: SyncPlan, deps: ResolveDeps): Promise<{ plan: SyncPlan; stats: ResolveStats }> {
  const stats: ResolveStats = { merged: 0, conflicts: 0 };
  const assigned = new Set<Path>();
  const taken = async (p: Path) => assigned.has(p) || (await deps.vault.fileExists(p));
  const now = deps.clock.now();
  const actions: SyncAction[] = [];

  for (const a of plan.actions) {
    if (a.kind === "bothChanged") {
      const resolved = await resolveBothChanged(a, deps);
      if (resolved.kind === "merge") stats.merged++;
      if (resolved.kind === "conflict") {
        stats.conflicts++;
        resolved.conflictPath = await conflictCopyPath(a.path, deps.deviceName, now, taken);
        assigned.add(resolved.conflictPath);
      }
      actions.push(resolved);
    } else if (a.kind === "conflict") {
      stats.conflicts++;
      const conflictPath = a.conflictPath ?? (await conflictCopyPath(a.path, deps.deviceName, now, taken));
      assigned.add(conflictPath);
      actions.push({ ...a, conflictPath });
    } else {
      actions.push(a);
    }
  }
  return { plan: { actions, remoteHead: plan.remoteHead }, stats };
}

type BothChanged = Extract<SyncAction, { kind: "bothChanged" }>;

async function resolveBothChanged(a: BothChanged, deps: ResolveDeps): Promise<SyncAction> {
  const conflict = (why: string): SyncAction => {
    deps.log.info(`${a.path}: conflict (${why})`);
    return { kind: "conflict", path: a.path, localSha: a.localSha, remoteSha: a.remoteSha, mode: a.mode };
  };
  if (a.baseSha === null) return conflict("no common base version");

  let local: Uint8Array;
  try {
    local = await deps.vault.readBytes(a.path);
  } catch (e) {
    return { kind: "skip", path: a.path, reason: `cannot read local file: ${e instanceof Error ? e.message : String(e)}` };
  }
  // The local file may have changed since the scan; merge what is on disk now.
  const localSha = await gitBlobSha(local);
  if (localSha === a.remoteSha) return { kind: "baselineSet", path: a.path, sha: localSha, mode: a.mode };

  // Only text can merge; check local first to avoid fetching blobs for binaries.
  if (!isTextFile(a.path, local)) return conflict("binary file");

  const [base, remote] = await Promise.all([fetchBlob(deps, a.baseSha), fetchBlob(deps, a.remoteSha)]);
  const m = mergeBytes(a.path, base, local, remote);
  if (!m.ok || !m.bytes) return conflict(m.ok ? "empty merge" : m.reason);
  deps.log.debug(`${a.path}: merged cleanly`);
  return { kind: "merge", path: a.path, merged: m.bytes, localSha, remoteSha: a.remoteSha, mode: a.mode };
}

async function fetchBlob(deps: ResolveDeps, sha: Sha): Promise<Uint8Array> {
  const bytes = await deps.remote.getBlob(deps.repo, sha);
  const actual = await gitBlobSha(bytes);
  if (actual !== sha) throw new SyncError("Unexpected", `blob ${sha} downloaded with sha ${actual}`);
  return bytes;
}
