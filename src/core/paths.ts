import { configAllowed, type ConfigSyncOptions } from "./config-sync";
import ignore from "ignore";
import type { Path } from "./types";
import { mkPath } from "./types";

// Path normalization, exclusion rules and name validation. Pure; no I/O.

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * Canonical repo-relative path used as a key everywhere: NFC-normalized,
 * forward slashes, no leading "./" or "/", no duplicate or trailing slashes.
 * (Keep the on-disk spelling separately for I/O — iOS/macOS may hand us NFD.)
 */
export function normalizePath(raw: string): Path {
  let p = raw.normalize("NFC").replace(/\\/g, "/");
  p = p.replace(/\/{2,}/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);
  while (p.endsWith("/")) p = p.slice(0, -1);
  return mkPath(p);
}

/** Key for comparing paths on a case-insensitive filesystem. */
export function caseKey(path: string): string {
  return normalizePath(path).toLowerCase();
}

export function parentDir(path: string): Path | null {
  const i = path.lastIndexOf("/");
  return i < 0 ? null : mkPath(path.slice(0, i));
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

export function joinPath(dir: string, name: string): Path {
  return mkPath(dir === "" ? name : `${dir}/${name}`);
}

/** All ancestor directories of a path, deepest first ("a/b/c.md" → ["a/b", "a"]). */
export function ancestorDirs(path: string): Path[] {
  const out: Path[] = [];
  let dir = parentDir(path);
  while (dir !== null) {
    out.push(dir);
    dir = parentDir(dir);
  }
  return out;
}

// ── Exclusion ───────────────────────────────────────────────────────────────

export interface ExcludeOptions {
  /** Obsidian's app.vault.configDir — usually ".obsidian". Never hard-code it. */
  configDir: string;
  /** This plugin's id (its own data.json is always excluded). */
  pluginId: string;
  /** User glob patterns, gitignore syntax. */
  userPatterns?: string[];
  /** Contents of the repo's .gitignore, if any. */
  gitignoreText?: string;
  /**
   * Whether anything under configDir may be synced at all (config sync, §7).
   * When on, `configSync` is the allow-list; without it everything is allowed.
   */
  includeConfigDir?: boolean;
  configSync?: ConfigSyncOptions;
}

/**
 * Dot-paths outside the config dir that the vault adapter lists. Everything else
 * that starts with "." (any segment) is invisible to Obsidian's vault index, so it
 * must be invisible to sync too: a file the scan cannot see would look deleted and
 * its deletion would be pushed (e.g. a repo's .github/workflows). See BUG_HISTORY.
 */
export const LISTED_HIDDEN_FILES: ReadonlySet<string> = new Set([".gitignore"]);

/** Bumped whenever the built-in rules change, so core re-walks the remote (excludeKey). */
export const EXCLUDE_RULES_VERSION = 2;

const OS_JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * Rules that can never be overridden by the user (§7).
 * `path` must already be normalized.
 */
export function isAlwaysExcluded(path: string, opts: Pick<ExcludeOptions, "configDir" | "pluginId">): boolean {
  const segments = path.split("/");
  const name = segments[segments.length - 1];
  if (OS_JUNK.has(name)) return true;
  // Any .git or .trash directory, at any depth (a vault may contain nested repos).
  if (segments.some((s, i) => i < segments.length - 1 && (s === ".git" || s === ".trash"))) return true;
  if (name === ".git") return true;
  // Root .gitkeep is the placeholder we (or the user) commit to bootstrap an empty
  // repo (§6.1); it is not vault content and must not appear in the vault.
  if (path === ".gitkeep") return true;

  const cfg = normalizePath(opts.configDir);
  if (path === `${cfg}/plugins/${opts.pluginId}/data.json`) return true;
  if (path.startsWith(`${cfg}/cache/`) || path === `${cfg}/cache`) return true;
  // workspace.json, workspace-mobile.json, workspaces.json … are per-device UI state.
  if (segments.length === 2 && segments[0] === cfg && /^workspace.*\.json$/.test(name)) return true;
  return false;
}

/** `isDir` lets directory patterns like `build/` match the directory itself, so a walk can skip it whole. */
export type Excluder = (path: Path, isDir?: boolean) => boolean;

/** Build a predicate answering "should this path be left out of sync?". */
export function buildExcluder(opts: ExcludeOptions): Excluder {
  const ig = ignore();
  if (opts.gitignoreText) ig.add(opts.gitignoreText);
  if (opts.userPatterns?.length) ig.add(opts.userPatterns);
  const cfg = normalizePath(opts.configDir);
  const includeConfig = opts.includeConfigDir ?? false;

  return (path: Path, isDir = false): boolean => {
    if (path === "") return true;
    if (isAlwaysExcluded(path, opts)) return true;
    if (isDir && (path === ".git" || path === ".trash" || baseName(path) === ".git" || baseName(path) === ".trash")) return true;
    if (path === cfg || path.startsWith(`${cfg}/`)) {
      if (!includeConfig) return true;
      if (opts.configSync && !configAllowed(path === cfg ? "" : path.slice(cfg.length + 1), isDir || path === cfg, opts.configSync)) return true;
    } else if (!LISTED_HIDDEN_FILES.has(path) && path.split("/").some(s => s.startsWith("."))) {
      return true;
    }
    // `ignore` throws on absolute or "./" paths; ours are already normalized.
    // A trailing slash is how `ignore` knows the path is a directory.
    return ig.ignores(isDir ? `${path}/` : path);
  };
}

// ── Name validation ─────────────────────────────────────────────────────────

export type Platform = "windows" | "posix";

export interface NameCheck {
  ok: boolean;
  reason?: string;
}

// Obsidian refuses these in file names on every platform ("File name cannot
// contain any of the following characters: * " \ / < > : | ?"), so we treat
// them as invalid everywhere, not just on Windows.
const OBSIDIAN_FORBIDDEN = /[*"\\<>:|?]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Windows reserved device names, with or without an extension (CON.md is still reserved).
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const MAX_SEGMENT_BYTES = 255;

/** Check every segment of a (normalized) path for names this OS cannot store. */
export function validatePath(path: string, platform: Platform): NameCheck {
  if (path === "") return { ok: false, reason: "empty path" };
  const encoder = new TextEncoder();
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      return { ok: false, reason: `invalid path segment "${seg}"` };
    }
    if (encoder.encode(seg).byteLength > MAX_SEGMENT_BYTES) {
      return { ok: false, reason: `name longer than ${MAX_SEGMENT_BYTES} bytes` };
    }
    if (CONTROL_CHARS.test(seg)) return { ok: false, reason: "name contains control characters" };
    if (OBSIDIAN_FORBIDDEN.test(seg)) {
      return { ok: false, reason: `name contains a character Obsidian does not allow (* " \\ < > : | ?)` };
    }
    if (platform === "windows") {
      if (/[. ]$/.test(seg)) return { ok: false, reason: "name ends with a dot or space (not allowed on Windows)" };
      if (WINDOWS_RESERVED.test(seg)) return { ok: false, reason: `"${seg}" is a reserved name on Windows` };
    }
  }
  return { ok: true };
}

/**
 * Group paths that collide on a case-insensitive filesystem.
 * Returns, for each colliding caseKey, the paths involved in input order.
 */
export function findCaseCollisions(paths: Iterable<string>): Map<string, Path[]> {
  const groups = new Map<string, Path[]>();
  for (const p of paths) {
    const k = caseKey(p);
    const list = groups.get(k);
    if (list) list.push(mkPath(p));
    else groups.set(k, [mkPath(p)]);
  }
  for (const [k, list] of groups) if (list.length < 2) groups.delete(k);
  return groups;
}
