import type { CommitInfo, Logger, PushTreeEntry, RefPoll, RemotePort, RemoteTreeDir, RemoteTreeEntry } from "../core/ports";
import type { Sha } from "../core/types";
import { mkSha, SyncError } from "../core/types";
import { realTimers, withRetry, withTimeout, type RetryOptions, type Timers } from "../core/retry";
import type { HttpClient, HttpResponse } from "./http";

// RemotePort over the GitHub REST / Git Data API (§6).
// Endpoint shapes and status codes: https://docs.github.com/en/rest/git (refs, commits,
// trees, blobs) and https://docs.github.com/en/rest/repos/contents, API version 2022-11-28.
// Notably "Update a reference" documents both 409 and 422 for a rejected update.

export const API_VERSION = "2022-11-28";
const JSON_ACCEPT = "application/vnd.github+json";
/** Raw media type: the blob body comes back as bytes, no JSON + base64 (§6.2, the ObsSync OOM). */
const RAW_ACCEPT = "application/vnd.github.raw+json";

export interface GitHubOptions {
  http: HttpClient;
  /** Read from SecretStorage on every request so a changed token takes effect immediately. */
  getToken: () => Promise<string | null> | string | null;
  log: Logger;
  timers?: Timers;
  retry?: RetryOptions;
  apiBase?: string;
  /** §6.4: 30 s for metadata… */
  metadataTimeoutMs?: number;
  /** …and 120 s for blob transfers and large tree posts. */
  transferTimeoutMs?: number;
  userAgent?: string;
}

interface CallSpec {
  method: "GET" | "POST" | "PATCH" | "PUT";
  path: string;
  json?: unknown;
  accept?: string;
  etag?: string;
  /** Statuses handed back to the caller instead of being turned into errors. */
  ok: number[];
  transfer?: boolean;
  label: string;
}

export interface RateLimitInfo {
  remaining: number;
  resetAt: number;
}

export type TokenKind = "classic" | "fine-grained" | "unknown";

export interface ConnectionReport {
  token:
    | { ok: true; login: string; kind: TokenKind; scopes: string[] | null; expiresAt: string | null }
    | { ok: false; error: SyncError };
  repo?:
    | { ok: true; private: boolean; canPush: boolean; defaultBranch: string; scopeMissing: boolean }
    /** `visible`: repos the token can see, fetched when the repo was not found (null if that failed too). */
    | { ok: false; error: SyncError; visible?: { fullName: string; private: boolean }[] | null };
  branch?: { exists: boolean; error?: SyncError };
  /** "unknown-empty-repo": the repo has no commits yet, so the Git Data API cannot be probed. */
  write?: "ok" | "denied" | "unknown-empty-repo" | SyncError;
  rateRemaining?: number | null;
}

function asSyncError(e: unknown): SyncError {
  return e instanceof SyncError ? e : new SyncError("Unexpected", e instanceof Error ? e.message : String(e));
}

export class GitHubRemote implements RemotePort {
  private readonly timers: Timers;
  private readonly apiBase: string;
  private readonly commitCache = new BoundedCache<Sha, CommitInfo>(256);
  private readonly treeCache = new BoundedCache<Sha, RemoteTreeDir>(256);
  /** Last X-RateLimit-* seen (§6.2: pause non-urgent syncs when under 100). */
  rateLimit: RateLimitInfo | null = null;

  constructor(private readonly opts: GitHubOptions) {
    this.timers = opts.timers ?? realTimers;
    this.apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  }

  // ── RemotePort ─────────────────────────────────────────────────────────────

  async getRef(repo: string, branch: string): Promise<{ sha: Sha; etag: string } | null> {
    const res = await this.call({
      method: "GET", path: `${repoPath(repo)}/git/ref/${headsPath(branch)}`, ok: [200, 404, 409], label: "get branch",
    });
    if (res.status === 409) return null; // empty repository
    if (res.status === 404) {
      // 404 means "no such branch" only if the repo itself is visible; otherwise this
      // throws NotFound (repo missing, or the token cannot see it).
      await this.call({ method: "GET", path: repoPath(repo), ok: [200], label: "get repository" });
      return null;
    }
    const body = parseJson(res, "get branch");
    return { sha: shaAt(body, ["object", "sha"], "get branch"), etag: res.headers["etag"] ?? "" };
  }

  async getRefIfChanged(repo: string, branch: string, etag: string): Promise<RefPoll> {
    // A 304 does not count against the primary rate limit (GitHub docs, "conditional requests").
    const res = await this.call({
      method: "GET", path: `${repoPath(repo)}/git/ref/${headsPath(branch)}`, etag: etag || undefined,
      ok: [200, 304, 404, 409], label: "poll branch",
    });
    if (res.status === 304) return { status: "unchanged" };
    if (res.status !== 200) return { status: "missing" };
    const body = parseJson(res, "poll branch");
    return { status: "changed", sha: shaAt(body, ["object", "sha"], "poll branch"), etag: res.headers["etag"] ?? "" };
  }

  async getCommit(repo: string, commitSha: Sha): Promise<CommitInfo> {
    const cached = this.commitCache.get(commitSha);
    if (cached) return cached;
    const res = await this.call({ method: "GET", path: `${repoPath(repo)}/git/commits/${enc(commitSha)}`, ok: [200], label: "get commit" });
    const body = parseJson(res, "get commit");
    const info: CommitInfo = {
      sha: shaAt(body, ["sha"], "get commit"),
      treeSha: shaAt(body, ["tree", "sha"], "get commit"),
      message: typeof field(body, ["message"]) === "string" ? (field(body, ["message"]) as string) : "",
    };
    this.commitCache.set(commitSha, info);
    return info;
  }

  async getTree(repo: string, treeSha: Sha): Promise<RemoteTreeDir> {
    const cached = this.treeCache.get(treeSha);
    if (cached) return cached;
    const res = await this.call({ method: "GET", path: `${repoPath(repo)}/git/trees/${enc(treeSha)}`, ok: [200], label: "get tree" });
    const body = parseJson(res, "get tree");
    // Non-recursive listings are not expected to truncate, but never treat a truncated one as complete (§5.3).
    if (field(body, ["truncated"]) === true) throw new SyncError("TooLarge", `folder listing for tree ${treeSha} was truncated by GitHub`);
    const raw = field(body, ["tree"]);
    if (!Array.isArray(raw)) throw unexpected("get tree", "no tree array");
    const entries: RemoteTreeEntry[] = raw.map((e: unknown) => {
      const name = field(e, ["path"]);
      const mode = field(e, ["mode"]);
      const type = field(e, ["type"]);
      const size = field(e, ["size"]);
      if (typeof name !== "string" || typeof mode !== "string" || (type !== "blob" && type !== "tree" && type !== "commit")) {
        throw unexpected("get tree", "malformed entry");
      }
      const entry: RemoteTreeEntry = { name, mode, type, sha: shaAt(e, ["sha"], "get tree") };
      if (typeof size === "number") entry.size = size;
      return entry;
    });
    const dir: RemoteTreeDir = { sha: shaAt(body, ["sha"], "get tree"), entries };
    this.treeCache.set(treeSha, dir);
    return dir;
  }

  async getBlob(repo: string, blobSha: Sha): Promise<Uint8Array> {
    const res = await this.call({
      method: "GET", path: `${repoPath(repo)}/git/blobs/${enc(blobSha)}`, accept: RAW_ACCEPT, transfer: true, ok: [200], label: "download file",
    });
    // A captive portal answers 200 with an HTML page. (The caller also verifies the
    // blob sha before writing, which catches any other substitution.)
    if ((res.headers["content-type"] ?? "").startsWith("text/html")) throw captivePortal("download file");
    return new Uint8Array(res.body);
  }

  async postBlob(repo: string, data: Uint8Array): Promise<Sha> {
    const res = await this.call({
      method: "POST", path: `${repoPath(repo)}/git/blobs`, json: { content: bytesToBase64(data), encoding: "base64" },
      transfer: true, ok: [201], label: "upload file",
    });
    return shaAt(parseJson(res, "upload file"), ["sha"], "upload file");
  }

  async postTree(repo: string, entries: PushTreeEntry[], baseSha: Sha): Promise<Sha> {
    return this.createTree(repo, entries, baseSha);
  }

  async postCommit(repo: string, _branch: string, treeSha: Sha, parentSha: Sha, message: string): Promise<Sha> {
    return this.createCommit(repo, treeSha, [parentSha], message);
  }

  async updateRef(repo: string, branch: string, commitSha: Sha): Promise<void> {
    const res = await this.call({
      method: "PATCH", path: `${repoPath(repo)}/git/refs/${headsPath(branch)}`, json: { sha: commitSha, force: false },
      ok: [200, 409, 422], label: "update branch",
    });
    if (res.status === 200) return;
    const msg = githubMessage(res);
    if (/protected branch|rule violation|ruleset/i.test(msg)) {
      throw new SyncError("BranchProtected", `GitHub refused the push: branch "${branch}" is protected. Use an unprotected branch or relax the rule.`);
    }
    if (res.status === 409 || /fast.?forward/i.test(msg)) {
      throw new SyncError("Conflict422", "another device pushed first (not a fast-forward)");
    }
    throw new SyncError("Unexpected", `GitHub refused the branch update (${res.status}): ${msg}`);
  }

  async bootstrapRepo(repo: string, branch: string): Promise<Sha> {
    const existing = await this.getRef(repo, branch);
    if (existing) return existing.sha; // another device won the race: leave history alone
    const message = "Initialize vault sync";
    try {
      // Non-empty repo, missing branch: create an orphan branch holding only .gitkeep.
      const tree = await this.createTree(repo, [{ path: ".gitkeep" as PushTreeEntry["path"], mode: "100644", content: "" }], null);
      const commit = await this.createCommit(repo, tree, [], message);
      const res = await this.call({
        method: "POST", path: `${repoPath(repo)}/git/refs`, json: { ref: `refs/heads/${branch}`, sha: commit },
        ok: [201, 422], label: "create branch",
      });
      if (res.status === 201) return commit;
      return await this.headAfterRace(repo, branch);
    } catch (e) {
      if (!(e instanceof SyncError && e.kind === "EmptyRepo")) throw e;
    }
    // Empty repo: Git Data endpoints answer 409 until the first commit exists; the
    // Contents API can make that commit (§6.1).
    const res = await this.call({
      method: "PUT", path: `${repoPath(repo)}/contents/.gitkeep`, json: { message, content: "", branch },
      ok: [200, 201, 409, 422], label: "initialize repository",
    });
    if (res.status === 200 || res.status === 201) {
      return shaAt(parseJson(res, "initialize repository"), ["commit", "sha"], "initialize repository");
    }
    return this.headAfterRace(repo, branch);
  }

  // ── settings helpers (not part of RemotePort) ──────────────────────────────

  /** Up to 100 most recently pushed repos the token can see, for the repo picker. */
  async listRepos(): Promise<{ fullName: string; defaultBranch: string; private: boolean }[]> {
    const res = await this.call({ method: "GET", path: "/user/repos?per_page=100&sort=pushed", ok: [200], label: "list repositories" });
    const body = parseJson(res, "list repositories");
    if (!Array.isArray(body)) return [];
    return body.flatMap((r: unknown) => {
      const fullName = field(r, ["full_name"]);
      if (typeof fullName !== "string") return [];
      const def = field(r, ["default_branch"]);
      return [{ fullName, defaultBranch: typeof def === "string" ? def : "main", private: field(r, ["private"]) === true }];
    });
  }

  /** Up to 100 branch names, for the branch picker. */
  async listBranches(repo: string): Promise<string[]> {
    const res = await this.call({ method: "GET", path: `${repoPath(repo)}/branches?per_page=100`, ok: [200], label: "list branches" });
    const body = parseJson(res, "list branches");
    if (!Array.isArray(body)) return [];
    return body.map((b: unknown) => field(b, ["name"])).filter((n): n is string => typeof n === "string");
  }

  /**
   * "Test connection" (§8): token validity and kind, repo visibility, branch,
   * an actual write check, rate limit. Every step reports separately so the user
   * sees exactly what is missing. Never throws for API errors.
   */
  async testConnection(repo: string, branch: string): Promise<ConnectionReport> {
    const report: ConnectionReport = { token: { ok: false, error: new SyncError("Unexpected", "not checked") } };
    const token = await this.opts.getToken();
    const kind: TokenKind = !token ? "unknown" : token.startsWith("github_pat_") ? "fine-grained" : token.startsWith("ghp_") ? "classic" : "unknown";
    try {
      const res = await this.call({ method: "GET", path: "/user", ok: [200], label: "check token" });
      const login = field(parseJson(res, "check token"), ["login"]);
      const scopes = res.headers["x-oauth-scopes"];
      report.token = {
        ok: true,
        login: typeof login === "string" ? login : "?",
        kind,
        scopes: scopes === undefined ? null : scopes.split(",").map(s => s.trim()).filter(Boolean),
        expiresAt: res.headers["github-authentication-token-expiration"] ?? null,
      };
    } catch (e) {
      report.token = { ok: false, error: asSyncError(e) };
      return report;
    }
    try {
      const res = await this.call({ method: "GET", path: repoPath(repo), ok: [200], label: "check repository" });
      const body = parseJson(res, "check repository");
      const isPrivate = field(body, ["private"]) === true;
      const scopes = report.token.ok ? report.token.scopes : null;
      // Classic tokens: the scope must cover the repo. Fine-grained tokens report no scopes.
      const scopeMissing = scopes !== null && !(scopes.includes("repo") || (!isPrivate && scopes.includes("public_repo")));
      report.repo = {
        ok: true, private: isPrivate, canPush: field(body, ["permissions", "push"]) !== false,
        defaultBranch: String(field(body, ["default_branch"]) ?? "main"), scopeMissing,
      };
    } catch (e) {
      const error = asSyncError(e);
      report.repo = { ok: false, error };
      if (error.kind === "NotFound") {
        // GitHub answers 404 for "exists but this token may not see it", so look at
        // what the token *can* see: that tells the user exactly what to fix.
        try {
          report.repo.visible = (await this.listRepos()).map(r => ({ fullName: r.fullName, private: r.private }));
        } catch {
          report.repo.visible = null;
        }
      }
      return report;
    }
    try {
      report.branch = { exists: (await this.getRef(repo, branch)) !== null };
    } catch (e) {
      report.branch = { exists: false, error: asSyncError(e) };
    }
    try {
      // Content-creating but harmless: an empty blob no commit refers to.
      const res = await this.call({
        method: "POST", path: `${repoPath(repo)}/git/blobs`, json: { content: "", encoding: "utf-8" }, ok: [201, 409], label: "check write access",
      });
      report.write = res.status === 201 ? "ok" : "unknown-empty-repo";
    } catch (e) {
      const err = asSyncError(e);
      report.write = err.kind === "PermissionDenied" || err.kind === "NotFound" ? "denied" : err;
    }
    report.rateRemaining = this.rateLimit?.remaining ?? null;
    return report;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async headAfterRace(repo: string, branch: string): Promise<Sha> {
    const ref = await this.getRef(repo, branch);
    if (!ref) throw new SyncError("EmptyRepo", `could not create branch "${branch}" in ${repo}`);
    return ref.sha;
  }

  private async createTree(repo: string, entries: PushTreeEntry[], baseSha: Sha | null): Promise<Sha> {
    const tree = entries.map(e => e.content !== undefined
      ? { path: e.path, mode: e.mode, type: "blob", content: e.content }
      : { path: e.path, mode: e.mode, type: "blob", sha: e.sha ?? null });
    const res = await this.call({
      method: "POST", path: `${repoPath(repo)}/git/trees`, json: baseSha ? { base_tree: baseSha, tree } : { tree },
      transfer: true, ok: [201], label: "create tree",
    });
    return shaAt(parseJson(res, "create tree"), ["sha"], "create tree");
  }

  private async createCommit(repo: string, treeSha: Sha, parents: Sha[], message: string): Promise<Sha> {
    const res = await this.call({
      method: "POST", path: `${repoPath(repo)}/git/commits`, json: { message, tree: treeSha, parents }, ok: [201], label: "create commit",
    });
    return shaAt(parseJson(res, "create commit"), ["sha"], "create commit");
  }

  private call(spec: CallSpec): Promise<HttpResponse> {
    const timeout = spec.transfer ? (this.opts.transferTimeoutMs ?? 120_000) : (this.opts.metadataTimeoutMs ?? 30_000);
    return withRetry(
      () => withTimeout(this.once(spec), timeout, this.timers, spec.label),
      this.timers,
      { ...this.opts.retry, log: this.opts.log, label: spec.label },
    );
  }

  private async once(spec: CallSpec): Promise<HttpResponse> {
    const token = await this.opts.getToken();
    if (!token) throw new SyncError("AuthInvalid", "No GitHub token is set on this device.");
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${token}`,
      "Accept": spec.accept ?? JSON_ACCEPT,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": this.opts.userAgent ?? "vault-github-sync",
    };
    if (spec.etag) headers["If-None-Match"] = spec.etag;
    let body: string | undefined;
    if (spec.json !== undefined) {
      body = JSON.stringify(spec.json);
      headers["Content-Type"] = "application/json";
    }
    let res: HttpResponse;
    try {
      res = await this.opts.http({ url: this.apiBase + spec.path, method: spec.method, headers, body });
    } catch (e) {
      if (e instanceof SyncError) throw e;
      // No response at all. Deliberately not echoing the error: it can include request details.
      throw new SyncError("Offline", "Can't reach GitHub. Check your internet connection.");
    }
    this.trackRateLimit(res);
    if (spec.ok.includes(res.status)) return res;
    throw classifyError(res, this.timers.now(), spec.label);
  }

  private trackRateLimit(res: HttpResponse) {
    const remaining = Number(res.headers["x-ratelimit-remaining"]);
    const reset = Number(res.headers["x-ratelimit-reset"]);
    if (Number.isFinite(remaining) && Number.isFinite(reset) && res.headers["x-ratelimit-remaining"] !== undefined) {
      this.rateLimit = { remaining, resetAt: reset * 1000 };
    }
  }
}

// ── error classification (§6.3) ──────────────────────────────────────────────

/** Turn a non-OK response into a typed error. Never maps one kind to another, never includes the token. */
export function classifyError(res: HttpResponse, now: number, label: string): SyncError {
  const s = res.status;
  const h = res.headers;
  const msg = githubMessage(res);
  if (s === 0) return new SyncError("Offline", "Can't reach GitHub. Check your internet connection.");
  if (s === 401) return new SyncError("AuthInvalid", "GitHub rejected the token: it is wrong, expired or revoked.");
  if (s === 403 || s === 429) {
    if (h["x-ratelimit-remaining"] === "0") {
      const reset = Number(h["x-ratelimit-reset"]);
      const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + 60_000;
      return new SyncError("RateLimited", "GitHub API rate limit reached.", resetAt);
    }
    const retryAfter = Number(h["retry-after"]);
    if (h["retry-after"] !== undefined && Number.isFinite(retryAfter)) {
      return new SyncError("RateLimited", "GitHub asked us to slow down.", now + retryAfter * 1000);
    }
    // Secondary limits without Retry-After: GitHub says wait at least a minute.
    if (s === 429 || /secondary rate limit|abuse/i.test(msg)) {
      return new SyncError("RateLimited", "GitHub asked us to slow down.", now + 60_000);
    }
    if (h["x-github-sso"] !== undefined) {
      return new SyncError("PermissionDenied", "This token must be authorized for your organization's SSO.");
    }
    return new SyncError("PermissionDenied", "The token lacks access to this repository. It needs Contents read and write.");
  }
  if (s === 404) {
    return new SyncError("NotFound", "Repository or branch not found, or the token cannot see this private repository.");
  }
  if (s === 409) return new SyncError("EmptyRepo", "The repository is empty.");
  if (s === 413) return new SyncError("TooLarge", `${label}: request too large for GitHub.`);
  if (s === 422 && /too large|too big/i.test(msg)) return new SyncError("TooLarge", `${label}: file too large for GitHub.`);
  if (s >= 500) return new SyncError("ServerError", `GitHub had a problem (${s}). Will retry.`);
  return new SyncError("Unexpected", `${label}: unexpected response ${s}${msg ? `: ${msg}` : ""}`);
}

function githubMessage(res: HttpResponse): string {
  if (!(res.headers["content-type"] ?? "").includes("json")) return "";
  try {
    const m = field(JSON.parse(new TextDecoder().decode(res.body)), ["message"]);
    return typeof m === "string" ? m.slice(0, 200) : "";
  } catch {
    return "";
  }
}

// ── parsing helpers ──────────────────────────────────────────────────────────

function parseJson(res: HttpResponse, label: string): unknown {
  if (!(res.headers["content-type"] ?? "").includes("json")) throw captivePortal(label);
  try {
    return JSON.parse(new TextDecoder().decode(res.body));
  } catch {
    throw captivePortal(label);
  }
}

function captivePortal(label: string): SyncError {
  return new SyncError("Offline", `${label}: got a non-GitHub response (captive portal or proxy?).`);
}

function unexpected(label: string, what: string): SyncError {
  return new SyncError("Unexpected", `${label}: malformed GitHub response (${what})`);
}

function field(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function shaAt(obj: unknown, path: string[], label: string): Sha {
  const v = field(obj, path);
  if (typeof v !== "string" || v.length === 0) throw unexpected(label, `missing ${path.join(".")}`);
  return mkSha(v);
}

const enc = encodeURIComponent;

export function repoPath(repo: string): string {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo.trim());
  if (!m) throw new SyncError("NotFound", `"${repo}" is not a repository name of the form owner/name.`);
  return `/repos/${enc(m[1])}/${enc(m[2])}`;
}

/** `heads/<branch>`, each segment encoded (branch names may contain "/"). */
export function headsPath(branch: string): string {
  return "heads/" + branch.split("/").map(enc).join("/");
}

/**
 * Base64 without Buffer (§2). Encodes in chunks whose size is a multiple of 3 so the
 * pieces concatenate into valid base64 and no full-size binary string is ever built.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 3 * 16384;
  const parts: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    let bin = "";
    for (let j = 0; j < slice.length; j += 4096) {
      bin += String.fromCharCode.apply(null, Array.from(slice.subarray(j, j + 4096)));
    }
    parts.push(btoa(bin));
  }
  return parts.join("");
}

class BoundedCache<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(k: K): V | undefined { return this.map.get(k); }
  set(k: K, v: V) {
    if (this.map.size >= this.max) {
      const first = this.map.keys().next();
      if (!first.done) this.map.delete(first.value);
    }
    this.map.set(k, v);
  }
}
