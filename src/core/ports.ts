import type { Path, Sha, FileMode, Baseline, LocalCache, ConflictRecord } from "./types";

// All interfaces live here. core/ code depends only on these — never on Obsidian or Node.

export interface VaultFile {
  path: Path;
  mtime: number;
  size: number;
}

export interface VaultPort {
  /** List all files in the vault (and any included dotfolders). */
  listFiles(): Promise<VaultFile[]>;
  /** Read a file as raw bytes. */
  readBytes(path: Path): Promise<Uint8Array>;
  /** Write raw bytes, creating parent folders as needed. Triggers editor refresh for open files. */
  writeBytes(path: Path, data: Uint8Array): Promise<void>;
  /** Delete a file. */
  deleteFile(path: Path): Promise<void>;
  /** Rename/move a file. */
  renameFile(oldPath: Path, newPath: Path): Promise<void>;
  /** Remove a folder only if it is empty. */
  removeFolderIfEmpty(path: Path): Promise<void>;
  /** True if a file exists at path. */
  fileExists(path: Path): Promise<boolean>;
  /** Current mtime + size without reading content (for the edited-during-sync guard). */
  stat(path: Path): Promise<{ mtime: number; size: number } | null>;
}

/**
 * One entry of a non-recursive git tree, as returned by GET /git/trees/{sha}.
 * `name` is the entry name inside this tree (the API calls it "path"), not the full path.
 * `mode` is the raw git mode string: 100644, 100755, 040000 (tree), 120000 (symlink), 160000 (submodule).
 */
export interface RemoteTreeEntry {
  name: string;
  sha: Sha;
  mode: string;
  type: "blob" | "tree" | "commit";
  /** Blob size in bytes when the API reports it (trees and submodules have none). */
  size?: number;
}

export interface RemoteTreeDir {
  sha: Sha;
  entries: RemoteTreeEntry[];
}

export interface CommitInfo {
  sha: Sha;
  treeSha: Sha;
  message: string;
}

export interface PushTreeEntry {
  path: Path;
  mode: FileMode;
  /** Provide content (text inline) or sha (binary already uploaded) or null (deletion). */
  content?: string;
  sha?: Sha | null;
}

export interface RemotePort {
  /** GET ref → head commit sha. Returns null if branch doesn't exist yet. */
  getRef(repo: string, branch: string): Promise<{ sha: Sha; etag: string } | null>;
  /**
   * Conditional GET of the ref (`If-None-Match: etag`; pass "" for none). A 304 costs
   * no rate limit (§5.1). "missing" = no such branch / empty repo, distinct from "unchanged".
   */
  getRefIfChanged(repo: string, branch: string, etag: string): Promise<RefPoll>;
  /** GET commit → { sha, treeSha }. */
  getCommit(repo: string, commitSha: Sha): Promise<CommitInfo>;
  /** GET a single tree level (non-recursive). */
  getTree(repo: string, treeSha: Sha): Promise<RemoteTreeDir>;
  /** GET raw blob bytes. */
  getBlob(repo: string, blobSha: Sha): Promise<Uint8Array>;
  /** POST blob (binary). Returns blob sha. */
  postBlob(repo: string, data: Uint8Array): Promise<Sha>;
  /** POST tree. Returns new tree sha. */
  postTree(repo: string, entries: PushTreeEntry[], baseSha: Sha): Promise<Sha>;
  /** POST commit. Returns commit sha. */
  postCommit(repo: string, branch: string, treeSha: Sha, parentSha: Sha, message: string): Promise<Sha>;
  /** PATCH ref (fast-forward only). Throws Conflict422 if not fast-forward. */
  updateRef(repo: string, branch: string, commitSha: Sha): Promise<void>;
  /**
   * Make sure the branch exists, creating it with a `.gitkeep` via the Contents API
   * when the repo is empty (Git Data endpoints return 409 there, §6.1).
   * MUST be harmless if the branch appeared in the meantime (another device won the
   * race): either add `.gitkeep` on top of the current head or do nothing. Never
   * replace the branch's history. Returns the resulting head commit sha.
   */
  bootstrapRepo(repo: string, branch: string): Promise<Sha>;
}

export type RefPoll =
  | { status: "unchanged" }
  | { status: "changed"; sha: Sha; etag: string }
  | { status: "missing" };

/** Last polled head together with the ETag GitHub sent for it. */
export interface RefPollRecord {
  sha: Sha;
  etag: string;
}

export interface StatePort {
  loadBaseline(repo: string, branch: string): Promise<Baseline | null>;
  saveBaseline(baseline: Baseline): Promise<void>;
  loadLocalCache(): Promise<LocalCache>;
  saveLocalCache(cache: LocalCache): Promise<void>;
  loadConflicts(): Promise<ConflictRecord[]>;
  saveConflicts(records: ConflictRecord[]): Promise<void>;
  loadRefPoll(repo: string, branch: string): Promise<RefPollRecord | null>;
  saveRefPoll(repo: string, branch: string, record: RefPollRecord): Promise<void>;
}

export interface Clock {
  now(): number;
  isoDate(): string;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
