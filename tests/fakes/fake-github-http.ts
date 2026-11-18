import type { HttpClient, HttpRequest, HttpResponse } from "../../src/adapters/http";
import type { PushTreeEntry } from "../../src/core/ports";
import type { FileMode, Path, Sha } from "../../src/core/types";
import { SyncError } from "../../src/core/types";
import type { FakeGitHub } from "./fake-github";

// GitHub's HTTP wire format over FakeGitHub's object store, so the real GitHubRemote
// adapter (URL building, headers, JSON parsing, status handling) runs against the same
// in-memory repo the core tests use. Shapes follow docs.github.com/en/rest/git and
// /rest/repos/contents (API 2022-11-28).
//
// FakeGitHub's own faults surface as the HTTP responses GitHub would send for them.
// `script` injects raw responses ahead of the router, for adapter-level tests.

export type Scripted = Partial<HttpResponse> & { status: number; json?: unknown } | "network" | "hang";

export class FakeGitHubHttp {
  /** Responses served (in order) before routing to the fake. */
  script: Scripted[] = [];
  requests: HttpRequest[] = [];
  validToken = "test-token";
  /** Repos that exist (404 for anything else). */
  repos: Set<string>;
  rateRemaining = 4999;
  /** X-OAuth-Scopes for GET /user (classic tokens); undefined = fine-grained (header absent). */
  scopes: string | undefined = undefined;
  tokenExpiry: string | undefined = "2026-12-31 00:00:00 UTC";
  login = "tester";
  /** Repo permissions for the authenticated user. */
  canPush = true;
  rateReset = 1_700_003_600;

  constructor(private readonly gh: FakeGitHub, repos: string[] = ["owner/repo"]) {
    this.repos = new Set(repos);
  }

  readonly client: HttpClient = async req => {
    this.requests.push(req);
    const next = this.script.shift();
    if (next === "network") throw new Error("net::ERR_INTERNET_DISCONNECTED");
    if (next === "hang") return new Promise<HttpResponse>(() => {});
    if (next) {
      return {
        status: next.status,
        headers: next.headers ?? (next.json !== undefined ? { "content-type": "application/json; charset=utf-8" } : {}),
        body: next.body ?? (next.json !== undefined ? jsonBody(next.json) : new ArrayBuffer(0)),
      };
    }
    if (req.headers["Authorization"] !== `Bearer ${this.validToken}`) return this.json(401, { message: "Bad credentials" });
    if (!req.headers["User-Agent"]) return this.json(403, { message: "Request forbidden by administrative rules. Please make sure your request has a User-Agent header" });
    try {
      return await this.route(req);
    } catch (e) {
      if (!(e instanceof SyncError)) throw e;
      switch (e.kind) {
        case "Offline": throw new Error("net::ERR_INTERNET_DISCONNECTED");
        case "Timeout": return new Promise<HttpResponse>(() => {});
        case "RateLimited": return this.json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" });
        case "ServerError": return this.json(502, { message: "Server Error" });
        case "Conflict422": return this.json(422, { message: "Update is not a fast forward" });
        case "NotFound": return this.json(404, { message: "Not Found" });
        default: return this.json(422, { message: e.message });
      }
    }
  };

  private json(status: number, body: unknown, extra: Record<string, string> = {}): HttpResponse {
    return {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-ratelimit-remaining": String(this.rateRemaining),
        "x-ratelimit-reset": String(this.rateReset),
        ...extra,
      },
      body: jsonBody(body),
    };
  }

  private async route(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    if (url.origin !== "https://api.github.com") return this.json(404, { message: "Not Found" });
    if (url.pathname === "/user" && req.method === "GET") {
      const extra: Record<string, string> = {};
      if (this.scopes !== undefined) extra["x-oauth-scopes"] = this.scopes;
      if (this.tokenExpiry !== undefined) extra["github-authentication-token-expiration"] = this.tokenExpiry;
      return this.json(200, { login: this.login }, extra);
    }
    if (url.pathname === "/user/repos" && req.method === "GET") {
      return this.json(200, [...this.repos].map(r => ({ full_name: r, default_branch: "main", private: true })));
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return this.json(404, { message: "Not Found" });
    const repo = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
    if (!this.repos.has(repo)) return this.json(404, { message: "Not Found" });
    const rest = m[3] ?? "";
    const body = typeof req.body === "string" ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    const gh = this.gh;
    let r: RegExpExecArray | null;

    if (rest === "" && req.method === "GET") {
      return this.json(200, { full_name: repo, private: true, default_branch: "main", permissions: { pull: true, push: this.canPush } });
    }
    if (rest === "/branches" && req.method === "GET") return this.json(200, gh.branchNames(repo).map(name => ({ name })));

    if ((r = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && req.method === "GET") {
      const branch = r[1].split("/").map(decodeURIComponent).join("/");
      const ref = await gh.getRef(repo, branch);
      if (!ref) return gh.hasAnyRef(repo) ? this.json(404, { message: "Not Found" }) : this.json(409, { message: "Git Repository is empty." });
      if (req.headers["If-None-Match"] === ref.etag) return { status: 304, headers: { etag: ref.etag }, body: new ArrayBuffer(0) };
      return this.json(200, { ref: `refs/heads/${branch}`, object: { sha: ref.sha, type: "commit" } }, { etag: ref.etag });
    }
    if ((r = /^\/git\/commits\/([^/]+)$/.exec(rest)) && req.method === "GET") {
      const c = await gh.getCommit(repo, r[1] as Sha);
      return this.json(200, { sha: c.sha, tree: { sha: c.treeSha }, message: c.message });
    }
    if ((r = /^\/git\/trees\/([^/]+)$/.exec(rest)) && req.method === "GET") {
      const t = await gh.getTree(repo, r[1] as Sha);
      return this.json(200, {
        sha: t.sha, truncated: false,
        tree: t.entries.map(e => ({ path: e.name, mode: e.mode, type: e.type, sha: e.sha, ...(e.size !== undefined ? { size: e.size } : {}) })),
      });
    }
    if ((r = /^\/git\/blobs\/([^/]+)$/.exec(rest)) && req.method === "GET") {
      if (req.headers["Accept"] !== "application/vnd.github.raw+json") throw new Error("fake only serves raw blobs");
      const bytes = await gh.getBlob(repo, r[1] as Sha);
      return { status: 200, headers: { "content-type": "application/vnd.github.raw" }, body: toArrayBuffer(bytes) };
    }
    if (rest === "/git/blobs" && req.method === "POST") {
      if (!gh.hasAnyRef(repo)) return this.json(409, { message: "Git Repository is empty." });
      if (!this.canPush) return this.json(403, { message: "Resource not accessible by personal access token" });
      if ((body.encoding !== "base64" && body.encoding !== "utf-8") || typeof body.content !== "string") return this.json(422, { message: "Invalid request" });
      const bytes = body.encoding === "base64" ? new Uint8Array(Buffer.from(body.content, "base64")) : new TextEncoder().encode(body.content);
      const sha = await gh.postBlob(repo, bytes);
      return this.json(201, { sha });
    }
    if (rest === "/git/trees" && req.method === "POST") {
      if (!gh.hasAnyRef(repo)) return this.json(409, { message: "Git Repository is empty." });
      const tree = body.tree as { path: string; mode: FileMode; type: string; sha?: string | null; content?: string }[];
      const entries: PushTreeEntry[] = tree.map(e => e.content !== undefined
        ? { path: e.path as Path, mode: e.mode, content: e.content }
        : { path: e.path as Path, mode: e.mode, sha: (e.sha ?? null) as Sha | null });
      const sha = await gh.postTree(repo, entries, (body.base_tree ?? "") as Sha);
      return this.json(201, { sha });
    }
    if (rest === "/git/commits" && req.method === "POST") {
      const parents = body.parents as string[];
      const sha = parents.length === 1
        ? await gh.postCommit(repo, "", body.tree as Sha, parents[0] as Sha, String(body.message))
        : gh.seedCommit(body.tree as Sha, null, String(body.message));
      return this.json(201, { sha });
    }
    if ((r = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && req.method === "PATCH") {
      const branch = r[1].split("/").map(decodeURIComponent).join("/");
      if (!(await gh.getRef(repo, branch))) return this.json(422, { message: "Reference does not exist" });
      await gh.updateRef(repo, branch, body.sha as Sha);
      return this.json(200, { ref: `refs/heads/${branch}`, object: { sha: body.sha, type: "commit" } });
    }
    if (rest === "/git/refs" && req.method === "POST") {
      const branch = String(body.ref).replace(/^refs\/heads\//, "");
      if (await gh.getRef(repo, branch)) return this.json(422, { message: "Reference already exists" });
      gh.seedRef(repo, branch, body.sha as Sha);
      return this.json(201, { ref: body.ref, object: { sha: body.sha, type: "commit" } });
    }
    if (rest === "/contents/.gitkeep" && req.method === "PUT") {
      const branch = String(body.branch);
      if (await gh.getRef(repo, branch)) return this.json(422, { message: "Invalid request.\n\n\"sha\" wasn't supplied." });
      const sha = await gh.bootstrapRepo(repo, branch);
      return this.json(201, { content: { path: ".gitkeep" }, commit: { sha } });
    }
    return this.json(404, { message: `fake: no route for ${req.method} ${rest}` });
  }
}

function jsonBody(v: unknown): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(JSON.stringify(v)));
}

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
