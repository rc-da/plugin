import { createHash } from "node:crypto";
import type { RemotePort, RemoteTreeEntry, RemoteTreeDir, CommitInfo, PushTreeEntry, RefPoll } from "../../src/core/ports";
import type { Sha, FileMode } from "../../src/core/types";
import { mkSha, SyncError } from "../../src/core/types";

// In-memory git object store implementing the GitHub API surface the plugin uses.
// Trees are nested per directory (like real git) and every sha is content-addressed,
// so identical content → identical blob sha and identical directories → identical tree sha.
// This is what lets tests exercise "skip unchanged subtrees" and rename detection.
//
// Test-only code: Node APIs (node:crypto) are fine here, never in src/.

interface TreeEntryObj { name: string; sha: Sha; mode: string; type: "blob" | "tree" | "commit" }
interface TreeObj { entries: TreeEntryObj[] }
interface CommitObj { treeSha: Sha; parentSha: Sha | null; message: string }

export type FaultKind =
  | "rateLimit"
  | "timeout"
  | "serverError"
  | "conflict422"
  | "offline"
  | "truncatedTree";

export type SeedValue =
  | Uint8Array
  | string
  | { content: Uint8Array | string; mode: FileMode }
  | { sha: string; mode: string; type: "blob" | "commit" };

/** Same formula as src/core/hash.ts, computed synchronously for test seeding. */
export function gitBlobShaSync(bytes: Uint8Array): Sha {
  const h = createHash("sha1");
  h.update(`blob ${bytes.byteLength}\0`);
  h.update(bytes);
  return mkSha(h.digest("hex"));
}

function treeShaOf(entries: TreeEntryObj[]): Sha {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const h = createHash("sha1");
  for (const e of sorted) h.update(`${e.mode} ${e.type} ${e.sha}\t${e.name}\n`);
  return mkSha(h.digest("hex"));
}

const toBytes = (c: Uint8Array | string): Uint8Array =>
  typeof c === "string" ? new TextEncoder().encode(c) : c;

export class FakeGitHub implements RemotePort {
  private blobs = new Map<string, Uint8Array>();
  private trees = new Map<string, TreeObj>();
  private commits = new Map<string, CommitObj>();
  private refs = new Map<string, Sha>();       // "owner/repo#branch" → commit sha
  private etags = new Map<string, string>();
  private commitCounter = 0;

  /** Fault injection — set before a call, cleared after one use. */
  nextFault: FaultKind | null = null;
  truncateTreeSha: string | null = null;
  /** Scheduled fault: fires on the Nth call from now (1 = next call), then clears. */
  private scheduled: { remaining: number; kind: FaultKind | (() => void) } | null = null;

  /** Number of calls per RemotePort method (for asserting request economy). */
  calls: Record<string, number> = {};
  totalCalls = 0;

  /** Make the Nth call from now fail with `kind`, or run a callback (e.g. kill the app) just before it. */
  faultAt(nthCall: number, kind: FaultKind | (() => void)) {
    this.scheduled = { remaining: nthCall, kind };
  }

  /** Drop any pending one-shot or scheduled fault. */
  clearFaults() {
    this.scheduled = null;
    this.nextFault = null;
  }

  private count(method: string) {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    this.totalCalls++;
    if (this.scheduled && --this.scheduled.remaining <= 0) {
      const k = this.scheduled.kind;
      this.scheduled = null;
      if (typeof k === "function") k();
      else this.nextFault = k;
    }
  }

  private mayFault() {
    const f = this.nextFault;
    this.nextFault = null;
    if (!f) return;
    switch (f) {
      case "rateLimit":    throw new SyncError("RateLimited", "rate limited", Date.now() + 60000);
      case "timeout":      throw new SyncError("Timeout", "request timed out");
      case "serverError":  throw new SyncError("ServerError", "500 internal server error");
      case "conflict422":  throw new SyncError("Conflict422", "not a fast-forward");
      case "offline":      throw new SyncError("Offline", "network offline");
      case "truncatedTree": break; // handled inside getTree
    }
  }

  // ── Object store helpers ───────────────────────────────────────────────────

  private putBlob(data: Uint8Array): Sha {
    const sha = gitBlobShaSync(data);
    this.blobs.set(sha, data);
    return sha;
  }

  private putTree(entries: TreeEntryObj[]): Sha {
    const sha = treeShaOf(entries);
    this.trees.set(sha, { entries });
    return sha;
  }

  /** Flatten a tree into full-path → entry (recursively). */
  private flatten(treeSha: Sha, prefix = ""): Map<string, TreeEntryObj> {
    const out = new Map<string, TreeEntryObj>();
    const t = this.trees.get(treeSha);
    if (!t) return out;
    for (const e of t.entries) {
      const full = prefix + e.name;
      if (e.type === "tree") {
        for (const [k, v] of this.flatten(e.sha, full + "/")) out.set(k, v);
      } else {
        out.set(full, e);
      }
    }
    return out;
  }

  /** Build nested trees from a flat full-path → entry map; returns root tree sha. */
  private nest(flat: Map<string, TreeEntryObj>): Sha {
    interface Node { blobs: TreeEntryObj[]; dirs: Map<string, Node> }
    const root: Node = { blobs: [], dirs: new Map() };
    for (const [full, e] of flat) {
      const parts = full.split("/");
      let node = root;
      for (const dir of parts.slice(0, -1)) {
        let next = node.dirs.get(dir);
        if (!next) { next = { blobs: [], dirs: new Map() }; node.dirs.set(dir, next); }
        node = next;
      }
      node.blobs.push({ ...e, name: parts[parts.length - 1] });
    }
    const build = (n: Node): Sha => {
      const entries: TreeEntryObj[] = [...n.blobs];
      for (const [name, child] of n.dirs) {
        entries.push({ name, sha: build(child), mode: "040000", type: "tree" });
      }
      return this.putTree(entries);
    };
    return build(root);
  }

  // ── Seeding helpers ────────────────────────────────────────────────────────

  /** Store a blob and return its sha. */
  seedBlob(data: Uint8Array | string): Sha {
    return this.putBlob(toBytes(data));
  }

  /**
   * Build a (nested) tree from full-path → content and return the root tree sha.
   * A value may also be `{ content, mode }` to set an executable mode, or
   * `{ sha, mode, type }` to plant a symlink/submodule entry.
   */
  seedTree(files: Record<string, SeedValue>): Sha {
    const flat = new Map<string, TreeEntryObj>();
    for (const [path, v] of Object.entries(files)) {
      const name = path.split("/").pop() ?? path;
      if (typeof v === "string" || v instanceof Uint8Array) {
        flat.set(path, { name, sha: this.putBlob(toBytes(v)), mode: "100644", type: "blob" });
      } else if ("content" in v) {
        flat.set(path, { name, sha: this.putBlob(toBytes(v.content)), mode: v.mode, type: "blob" });
      } else {
        flat.set(path, { name, sha: mkSha(v.sha), mode: v.mode, type: v.type });
      }
    }
    return this.nest(flat);
  }

  /** Create a commit on top of a tree and return commit sha. */
  seedCommit(treeSha: Sha, parentSha: Sha | null, message: string): Sha {
    const sha = mkSha(`commit-${this.commitCounter++}`);
    this.commits.set(sha, { treeSha, parentSha, message });
    return sha;
  }

  /** Point a ref at a commit. */
  seedRef(repo: string, branch: string, commitSha: Sha) {
    const key = `${repo}#${branch}`;
    this.refs.set(key, commitSha);
    this.etags.set(key, `etag-${commitSha}`);
  }

  /** Branch names of `repo`. */
  branchNames(repo: string): string[] {
    return [...this.refs.keys()].filter(k => k.startsWith(`${repo}#`)).map(k => k.slice(repo.length + 1));
  }

  /** True if any branch exists in `repo` (an empty repo has none). */
  hasAnyRef(repo: string): boolean {
    for (const k of this.refs.keys()) if (k.startsWith(`${repo}#`)) return true;
    return false;
  }

  /** Simulate someone deleting the branch on GitHub. */
  deleteRef(repo: string, branch: string) {
    const key = `${repo}#${branch}`;
    this.refs.delete(key);
    this.etags.delete(key);
  }

  /** Convenience: tree + commit + ref in one go. Returns the commit sha. */
  seedRepo(repo: string, branch: string, files: Record<string, SeedValue>): Sha {
    const parent = this.refs.get(`${repo}#${branch}`) ?? null;
    const commit = this.seedCommit(this.seedTree(files), parent, "seed");
    this.seedRef(repo, branch, commit);
    return commit;
  }

  /** Simulate another device committing: apply changes (null = delete) on top of the current head. */
  seedChange(repo: string, branch: string, changes: Record<string, Uint8Array | string | null>): Sha {
    const key = `${repo}#${branch}`;
    const head = this.refs.get(key);
    const headCommit = head ? this.commits.get(head) : undefined;
    const flat = headCommit ? this.flatten(headCommit.treeSha) : new Map<string, TreeEntryObj>();
    for (const [path, v] of Object.entries(changes)) {
      if (v === null) flat.delete(path);
      else flat.set(path, { name: path.split("/").pop() ?? path, sha: this.putBlob(toBytes(v)), mode: "100644", type: "blob" });
    }
    const commit = this.seedCommit(this.nest(flat), head ?? null, "other device");
    this.seedRef(repo, branch, commit);
    return commit;
  }

  // ── RemotePort implementation ──────────────────────────────────────────────

  async getRef(repo: string, branch: string): Promise<{ sha: Sha; etag: string } | null> {
    this.count("getRef");
    this.mayFault();
    const key = `${repo}#${branch}`;
    const sha = this.refs.get(key);
    if (!sha) return null;
    return { sha, etag: this.etags.get(key) ?? `etag-${sha}` };
  }

  async getRefIfChanged(repo: string, branch: string, etag: string): Promise<RefPoll> {
    this.count("getRefIfChanged");
    this.mayFault();
    const key = `${repo}#${branch}`;
    const sha = this.refs.get(key);
    if (!sha) return { status: "missing" };
    const currentEtag = this.etags.get(key) ?? `etag-${sha}`;
    if (etag && currentEtag === etag) return { status: "unchanged" }; // 304
    return { status: "changed", sha, etag: currentEtag };
  }

  async getCommit(_repo: string, commitSha: Sha): Promise<CommitInfo> {
    this.count("getCommit");
    this.mayFault();
    const c = this.commits.get(commitSha);
    if (!c) throw new SyncError("NotFound", `commit not found: ${commitSha}`);
    return { sha: commitSha, treeSha: c.treeSha, message: c.message };
  }

  async getTree(_repo: string, treeSha: Sha): Promise<RemoteTreeDir> {
    this.count("getTree");
    this.mayFault();
    const isTruncated = this.truncateTreeSha === treeSha;
    this.truncateTreeSha = null;
    const t = this.trees.get(treeSha);
    if (!t) throw new SyncError("NotFound", `tree not found: ${treeSha}`);
    const source = isTruncated ? t.entries.slice(0, 1) : t.entries;
    const entries: RemoteTreeEntry[] = source.map(e => {
      const blob = e.type === "blob" ? this.blobs.get(e.sha) : undefined;
      return blob ? { ...e, size: blob.byteLength } : { ...e };
    });
    return { sha: treeSha, entries };
  }

  async getBlob(_repo: string, blobSha: Sha): Promise<Uint8Array> {
    this.count("getBlob");
    this.mayFault();
    const b = this.blobs.get(blobSha);
    if (!b) throw new SyncError("NotFound", `blob not found: ${blobSha}`);
    return b;
  }

  async postBlob(_repo: string, data: Uint8Array): Promise<Sha> {
    this.count("postBlob");
    this.mayFault();
    return this.putBlob(data);
  }

  async postTree(_repo: string, entries: PushTreeEntry[], baseSha: Sha): Promise<Sha> {
    this.count("postTree");
    this.mayFault();
    const flat = this.flatten(baseSha);
    for (const e of entries) {
      const name = e.path.split("/").pop() ?? e.path;
      if (e.content !== undefined) {
        flat.set(e.path, { name, sha: this.putBlob(toBytes(e.content)), mode: e.mode, type: "blob" });
      } else if (e.sha === null) {
        flat.delete(e.path);
      } else if (e.sha !== undefined) {
        if (!this.blobs.has(e.sha)) throw new SyncError("Unexpected", `postTree: unknown blob sha ${e.sha}`);
        flat.set(e.path, { name, sha: e.sha, mode: e.mode, type: "blob" });
      }
    }
    return this.nest(flat);
  }

  async postCommit(_repo: string, _branch: string, treeSha: Sha, parentSha: Sha, message: string): Promise<Sha> {
    this.count("postCommit");
    this.mayFault();
    const sha = mkSha(`commit-${this.commitCounter++}`);
    this.commits.set(sha, { treeSha, parentSha, message });
    return sha;
  }

  async updateRef(repo: string, branch: string, commitSha: Sha): Promise<void> {
    this.count("updateRef");
    this.mayFault();
    const key = `${repo}#${branch}`;
    const current = this.refs.get(key);
    const incoming = this.commits.get(commitSha);
    if (!incoming) throw new SyncError("Unexpected", `updateRef: unknown commit ${commitSha}`);
    // Fast-forward check: the new commit's parent must be the current head.
    if (current && incoming.parentSha !== current) {
      throw new SyncError("Conflict422", "Update is not a fast forward");
    }
    this.refs.set(key, commitSha);
    this.etags.set(key, `etag-${commitSha}`);
  }

  async bootstrapRepo(repo: string, branch: string): Promise<Sha> {
    this.count("bootstrapRepo");
    this.mayFault();
    const key = `${repo}#${branch}`;
    const head = this.refs.get(key);
    if (head) {
      // Branch exists after all (another device won the race). Like the real
      // Contents API, add .gitkeep on top of the current head — never rewrite history.
      const headCommit = this.commits.get(head);
      if (!headCommit) throw new SyncError("Unexpected", "dangling ref");
      const flat = this.flatten(headCommit.treeSha);
      if (flat.has(".gitkeep")) return head;
      flat.set(".gitkeep", { name: ".gitkeep", sha: this.putBlob(new Uint8Array(0)), mode: "100644", type: "blob" });
      const commitSha = this.seedCommit(this.nest(flat), head, "add .gitkeep");
      this.seedRef(repo, branch, commitSha);
      return commitSha;
    }
    const treeSha = this.seedTree({ ".gitkeep": new Uint8Array(0) });
    const commitSha = this.seedCommit(treeSha, null, "init");
    this.seedRef(repo, branch, commitSha);
    return commitSha;
  }

  // ── Inspection helpers (for assertions) ───────────────────────────────────

  /** All blob paths + content at the current head of a ref. */
  async snapshotFiles(repo: string, branch: string): Promise<Map<string, Uint8Array>> {
    const head = this.refs.get(`${repo}#${branch}`);
    const commit = head ? this.commits.get(head) : undefined;
    const result = new Map<string, Uint8Array>();
    if (!commit) return result;
    for (const [path, e] of this.flatten(commit.treeSha)) {
      const blob = this.blobs.get(e.sha);
      if (blob) result.set(path, blob);
    }
    return result;
  }

  /** Root tree sha of the current head (test helper). */
  headTreeSha(repo: string, branch: string): Sha | null {
    const head = this.refs.get(`${repo}#${branch}`);
    const commit = head ? this.commits.get(head) : undefined;
    return commit?.treeSha ?? null;
  }
}
