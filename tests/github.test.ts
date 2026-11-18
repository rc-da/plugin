import { describe, it, expect } from "vitest";
import { FakeGitHub } from "./fakes/fake-github";
import { CachingHttp, FakeGitHubHttp, type Scripted } from "./fakes/fake-github-http";
import { FakeVault } from "./fakes/fake-vault";
import { FakeState, FakeClock } from "./fakes/fake-state";
import { GitHubRemote, bytesToBase64, classifyError, headsPath, repoPath } from "../src/adapters/github";
import type { Timers } from "../src/core/retry";
import { runSync, type SyncDeps } from "../src/core/sync";
import { buildExcluder } from "../src/core/paths";
import { SyncError, type Sha, type SyncErrorKind } from "../src/core/types";
import { REPO, BRANCH, quietLog, P, S, text } from "./helpers";

const NOW = 1_700_000_000_000;
const TOKEN = "test-token";
const enc = (s: string) => new TextEncoder().encode(s);

function testTimers(): Timers & { slept: number[] } {
  const slept: number[] = [];
  return {
    slept,
    sleep: async ms => { slept.push(ms); },
    now: () => NOW,
    // Fires on the next macrotask: any in-memory response (microtasks only) wins the race.
    setTimer: fn => { const id = setTimeout(fn, 0); return () => clearTimeout(id); },
  };
}

function make(opts: { maxTries?: number; token?: string | null } = {}) {
  const gh = new FakeGitHub();
  const http = new FakeGitHubHttp(gh, [REPO]);
  const timers = testTimers();
  const remote = new GitHubRemote({
    http: http.client, getToken: () => (opts.token === undefined ? TOKEN : opts.token), log: quietLog, timers,
    retry: { random: () => 0, maxTries: opts.maxTries },
  });
  return { gh, http, timers, remote };
}

async function errorOf(p: Promise<unknown>): Promise<SyncError> {
  try { await p; } catch (e) { if (e instanceof SyncError) return e; throw e; }
  throw new Error("expected a SyncError");
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Scripted =>
  ({ status, json: body, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

describe("GitHubRemote — request hygiene (§6.2)", () => {
  it("sends auth, accept, API version and user-agent; encodes repo and branch", async () => {
    const { gh, http, remote } = make();
    gh.seedRepo(REPO, "feature/x y", { "a.md": "a" });
    const ref = await remote.getRef(REPO, "feature/x y");
    expect(ref?.sha).toBeTruthy();
    const req = http.requests[0];
    expect(req.url).toMatch(/^https:\/\/api\.github\.com\/repos\/owner\/repo\/git\/ref\/heads\/feature\/x%20y\?_=[0-9a-z]+$/);
    expect(req.headers["Cache-Control"]).toBe("no-cache"); // mutable: never from a cache
    expect(req.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(req.headers["User-Agent"]).toBeTruthy();
  });

  it("rejects malformed repo names before any request", () => {
    expect(() => repoPath("owner")).toThrow(SyncError);
    expect(() => repoPath("a/b/c")).toThrow(SyncError);
    expect(repoPath("o.w-n_er/re.po")).toBe("/repos/o.w-n_er/re.po");
    expect(headsPath("a/b")).toBe("heads/a/b");
  });

  it("no token → AuthInvalid without sending anything", async () => {
    const { http, remote } = make({ token: null });
    expect((await errorOf(remote.getRef(REPO, BRANCH))).kind).toBe("AuthInvalid");
    expect(http.requests).toHaveLength(0);
  });

  it("downloads blobs raw, byte for byte", async () => {
    const { gh, http, remote } = make();
    const bin = new Uint8Array(256).map((_, i) => i);
    const sha = gh.seedBlob(bin);
    expect(await remote.getBlob(REPO, sha)).toEqual(bin);
    expect(http.requests[0].url).not.toContain("?_="); // immutable by sha: cacheable
    expect(http.requests[0].headers["Cache-Control"]).toBeUndefined();
    expect(http.requests[0].headers.Accept).toBe("application/vnd.github.raw+json");
  });

  it("uploads binary as base64 that round-trips across chunk boundaries", async () => {
    const { gh, remote } = make();
    gh.seedRepo(REPO, BRANCH, {});
    const big = new Uint8Array(3 * 16384 * 2 + 7).map((_, i) => (i * 31) & 0xff);
    const sha = await remote.postBlob(REPO, big);
    expect(await gh.getBlob(REPO, sha)).toEqual(big);
    expect(bytesToBase64(enc("hello"))).toBe("aGVsbG8=");
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });

  it("caches immutable trees and commits by sha", async () => {
    const { gh, http, remote } = make();
    gh.seedRepo(REPO, BRANCH, { "a.md": "a", "d/b.md": "b" });
    const head = (await gh.getRef(REPO, BRANCH))!.sha;
    const c1 = await remote.getCommit(REPO, head);
    await remote.getCommit(REPO, head);
    const t = await remote.getTree(REPO, c1.treeSha);
    await remote.getTree(REPO, c1.treeSha);
    expect(http.requests).toHaveLength(2);
    expect(t.entries.map(e => [e.name, e.type]).sort()).toEqual([["a.md", "blob"], ["d", "tree"]]);
    expect(t.entries.find(e => e.name === "a.md")?.size).toBe(1);
  });

  it("a truncated tree listing is never treated as complete", async () => {
    const { http, remote } = make();
    http.script.push(json(200, { sha: "t", truncated: true, tree: [] }));
    expect((await errorOf(remote.getTree(REPO, S("t")))).kind).toBe("TooLarge");
  });

  it("tracks X-RateLimit-Remaining", async () => {
    const { gh, http, remote } = make();
    gh.seedRepo(REPO, BRANCH, {});
    http.rateRemaining = 42;
    await remote.getRef(REPO, BRANCH);
    expect(remote.rateLimit).toEqual({ remaining: 42, resetAt: http.rateReset * 1000 });
  });
});

describe("GitHubRemote — refs", () => {
  it("missing branch in a visible repo → null; empty repo → null; invisible repo → NotFound", async () => {
    const { gh, http, remote } = make();
    expect(await remote.getRef(REPO, BRANCH)).toBeNull(); // empty repo (409)
    gh.seedRepo(REPO, "other", { "a.md": "a" });
    expect(await remote.getRef(REPO, BRANCH)).toBeNull(); // 404 + repo visible
    http.repos.clear();
    const e = await errorOf(remote.getRef(REPO, BRANCH));
    expect(e.kind).toBe("NotFound");
    expect(e.message).toMatch(/private/);
  });

  it("ETag poll: 304 → null, change → new head", async () => {
    const { gh, remote } = make();
    gh.seedRepo(REPO, BRANCH, { "a.md": "a" });
    const ref = (await remote.getRef(REPO, BRANCH))!;
    expect(await remote.getRefIfChanged(REPO, BRANCH, ref.etag)).toEqual({ status: "unchanged" });
    gh.seedChange(REPO, BRANCH, { "a.md": "b" });
    const changed = await remote.getRefIfChanged(REPO, BRANCH, ref.etag);
    expect(changed.status === "changed" && changed.sha).not.toBe(ref.sha);
    expect((await remote.getRefIfChanged(REPO, "nope", "")).status).toBe("missing");
  });

  it.each([
    [json(422, { message: "Update is not a fast forward" }), "Conflict422"],
    [json(409, { message: "Conflict" }), "Conflict422"],
    [json(422, { message: "Protected branch update failed for refs/heads/main." }), "BranchProtected"],
    [json(422, { message: "Repository rule violations found" }), "BranchProtected"],
    [json(422, { message: "Object does not exist" }), "Unexpected"],
  ] as [Scripted, SyncErrorKind][])("update ref %# → %s", async (resp, kind) => {
    const { http, remote } = make();
    http.script.push(resp);
    expect((await errorOf(remote.updateRef(REPO, BRANCH, S("c")))).kind).toBe(kind);
  });
});

describe("GitHubRemote — bootstrap (§6.1)", () => {
  it("empty repo: creates the branch with .gitkeep via the Contents API", async () => {
    const { gh, http, remote } = make();
    const head = await remote.bootstrapRepo(REPO, BRANCH);
    expect((await gh.getRef(REPO, BRANCH))?.sha).toBe(head);
    expect([...(await gh.snapshotFiles(REPO, BRANCH)).keys()]).toEqual([".gitkeep"]);
    expect(http.requests.some(r => r.method === "PUT" && r.url.endsWith("/contents/.gitkeep"))).toBe(true);
  });

  it("non-empty repo, missing branch: creates an orphan branch and leaves other branches alone", async () => {
    const { gh, remote } = make();
    const otherHead = gh.seedRepo(REPO, "other", { "keep.md": "k" });
    await remote.bootstrapRepo(REPO, BRANCH);
    expect([...(await gh.snapshotFiles(REPO, BRANCH)).keys()]).toEqual([".gitkeep"]);
    expect((await gh.getRef(REPO, "other"))?.sha).toBe(otherHead);
  });

  it("existing branch: writes nothing and returns the head", async () => {
    const { gh, http, remote } = make();
    const head = gh.seedRepo(REPO, BRANCH, { "a.md": "a" });
    expect(await remote.bootstrapRepo(REPO, BRANCH)).toBe(head);
    expect(http.requests.every(r => r.method === "GET")).toBe(true);
  });

  it("lost race (another device created the branch first): keeps their history", async () => {
    const { gh, http, remote } = make();
    const head = gh.seedRepo(REPO, BRANCH, { "theirs.md": "t" });
    // We saw an empty repo, then the branch appeared before our first write landed.
    http.script.push(
      json(409, { message: "Git Repository is empty." }),          // GET ref
      json(409, { message: "Git Repository is empty." }),          // POST tree
      json(422, { message: "Invalid request.\n\n\"sha\" wasn't supplied." }), // PUT contents
    );
    expect(await remote.bootstrapRepo(REPO, BRANCH)).toBe(head);
    expect((await gh.getRef(REPO, BRANCH))?.sha).toBe(head);
  });
});

describe("GitHubRemote — typed errors (§6.3)", () => {
  const cases: [string, Scripted, SyncErrorKind][] = [
    ["401", json(401, { message: "Bad credentials" }), "AuthInvalid"],
    ["403 primary rate limit", json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700003600" }), "RateLimited"],
    ["403 retry-after", json(403, { message: "slow down" }, { "retry-after": "120" }), "RateLimited"],
    ["403 secondary without headers", json(403, { message: "You have exceeded a secondary rate limit" }), "RateLimited"],
    ["429", json(429, { message: "Too many" }), "RateLimited"],
    ["403 no access", json(403, { message: "Resource not accessible by personal access token" }, { "x-ratelimit-remaining": "4000" }), "PermissionDenied"],
    ["403 SSO", json(403, { message: "SSO" }, { "x-github-sso": "required; url=https://github.com/orgs/x/sso" }), "PermissionDenied"],
    ["404", json(404, { message: "Not Found" }), "NotFound"],
    ["409", json(409, { message: "Git Repository is empty." }), "EmptyRepo"],
    ["413", { status: 413 }, "TooLarge"],
    ["500", json(500, { message: "oops" }), "ServerError"],
    ["captive portal", { status: 200, headers: { "content-type": "text/html" }, body: enc("<html>login</html>").buffer as ArrayBuffer }, "Offline"],
    ["network", "network", "Offline"],
    ["hang", "hang", "Timeout"],
  ];

  it.each(cases)("%s", async (_name, resp, kind) => {
    const { http, remote } = make({ maxTries: 1 });
    http.script.push(resp);
    const e = await errorOf(remote.getCommit(REPO, S("c")));
    expect(e.kind).toBe(kind);
    expect(e.message).not.toContain(TOKEN);
  });

  it("rate-limit reset times come from the headers", () => {
    const res = (h: Record<string, string>) => ({ status: 403, headers: h, body: new ArrayBuffer(0) });
    expect(classifyError(res({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700003600" }), NOW, "x").resetAt).toBe(1_700_003_600_000);
    expect(classifyError(res({ "retry-after": "30" }), NOW, "x").resetAt).toBe(NOW + 30_000);
  });

  it("403 with only User-Agent missing is reported as permission, not auth", () => {
    expect(classifyError({ status: 403, headers: {}, body: new ArrayBuffer(0) }, NOW, "x").kind).toBe("PermissionDenied");
  });
});

describe("GitHubRemote — retry policy (§6.4)", () => {
  it("retries server errors with backoff, then succeeds", async () => {
    const { gh, http, timers, remote } = make();
    gh.seedRepo(REPO, BRANCH, { "a.md": "a" });
    http.script.push(json(502, {}), json(503, {}));
    expect(await remote.getRef(REPO, BRANCH)).not.toBeNull();
    expect(timers.slept).toEqual([500, 1000]); // equal jitter with random()=0: half of 1 s, 2 s
  });

  it("gives up after 4 tries", async () => {
    const { http, remote } = make();
    http.script.push(json(500, {}), json(500, {}), json(500, {}), json(500, {}), json(500, {}));
    expect((await errorOf(remote.getCommit(REPO, S("c")))).kind).toBe("ServerError");
    expect(http.requests).toHaveLength(4);
  });

  it("retries offline and timeouts", async () => {
    const { gh, http, remote } = make();
    gh.seedRepo(REPO, BRANCH, {});
    http.script.push("network", "hang");
    expect(await remote.getRef(REPO, BRANCH)).not.toBeNull();
    expect(http.requests).toHaveLength(3);
  });

  it.each(["AuthInvalid", "PermissionDenied", "NotFound", "TooLarge"] as SyncErrorKind[])("never retries %s", async kind => {
    const { http, remote } = make();
    const resp: Record<string, Scripted> = {
      AuthInvalid: json(401, {}), PermissionDenied: json(403, {}), NotFound: json(404, {}), TooLarge: { status: 413 },
    };
    http.script.push(resp[kind], resp[kind]);
    expect((await errorOf(remote.getCommit(REPO, S("c")))).kind).toBe(kind);
    expect(http.requests).toHaveLength(1);
  });

  it("waits out a short rate limit, stops on a long one", async () => {
    const short = make();
    short.gh.seedRepo(REPO, BRANCH, {});
    short.http.script.push(json(403, {}, { "retry-after": "20" }));
    expect(await short.remote.getRef(REPO, BRANCH)).not.toBeNull();
    expect(short.timers.slept[0]).toBeGreaterThanOrEqual(20_000);

    const long = make();
    long.http.script.push(json(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 1800) }));
    const e = await errorOf(long.remote.getRef(REPO, BRANCH));
    expect(e.kind).toBe("RateLimited");
    expect(e.resetAt).toBe(NOW + 1_800_000);
    expect(long.http.requests).toHaveLength(1);
  });
});

describe("runSync through the real GitHub adapter", () => {
  const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync" });
  class Device {
    vault = new FakeVault();
    state = new FakeState();
    clock = new FakeClock();
    constructor(public remote: GitHubRemote, public name: string) {}
    sync(extra: Partial<SyncDeps> = {}) {
      return runSync({
        vault: this.vault, remote: this.remote, state: this.state, clock: this.clock, log: quietLog,
        config: { repo: REPO, branch: BRANCH, deviceName: this.name, platform: "posix", caseInsensitiveFs: false, exclude },
        ...extra,
      });
    }
  }

  it("bootstraps an empty repo, pushes text and binary, pulls, merges, deletes and renames", async () => {
    const { gh, http, timers } = make();
    const mk = () => new GitHubRemote({ http: http.client, getToken: () => TOKEN, log: quietLog, timers, retry: { random: () => 0 } });
    const a = new Device(mk(), "A");
    const b = new Device(mk(), "B");
    const bin = new Uint8Array([0, 1, 2, 255, 0, 13, 10]);
    a.vault.seed("note.md", "one\ntwo\nthree\n");
    a.vault.seed("img.png", bin);
    a.vault.seed("old/name.md", "rename me");

    expect((await a.sync()).status).toBe("ok");
    expect((await b.sync()).pulled).toBe(3);
    expect(await b.vault.readBytes(P("img.png"))).toEqual(bin);

    await a.vault.writeBytes(P("note.md"), enc("ONE\ntwo\nthree\n"));
    await b.vault.writeBytes(P("note.md"), enc("one\ntwo\nTHREE\n"));
    await b.vault.deleteFile(P("img.png"));
    await b.vault.renameFile(P("old/name.md"), P("new/name.md"));
    await a.sync();
    gh.faultAt(2, "serverError"); // retried inside the adapter, invisible to the sync
    const rb = await b.sync();
    expect(rb.merged).toBe(1);
    await a.sync();

    const remote = await gh.snapshotFiles(REPO, BRANCH);
    expect(text(remote.get("note.md"))).toBe("ONE\ntwo\nTHREE\n");
    expect(remote.has("img.png")).toBe(false);
    expect(text(remote.get("new/name.md"))).toBe("rename me");
    expect(text(await a.vault.readBytes(P("note.md")))).toBe("ONE\ntwo\nTHREE\n");
    expect(await a.vault.fileExists(P("img.png"))).toBe(false);
    expect((await a.sync()).status).toBe("noop");
    expect((await b.sync()).status).toBe("noop");
    // Text went inline in tree requests; only the binary needed a blob upload.
    expect(http.requests.filter(r => r.method === "POST" && r.url.endsWith("/git/blobs"))).toHaveLength(1);
  });

  it("a push race (422) is re-planned and retried", async () => {
    const { gh, http, timers } = make();
    const remote = new GitHubRemote({ http: http.client, getToken: () => TOKEN, log: quietLog, timers });
    gh.seedRepo(REPO, BRANCH, { "a.md": "a" });
    const a = new Device(remote, "A");
    a.vault.seed("a.md", "a");
    await a.sync();
    a.vault.seed("b.md", "b");
    const orig = gh.updateRef.bind(gh);
    let raced = false;
    gh.updateRef = async (repo: string, branch: string, sha: Sha) => {
      if (!raced) { raced = true; gh.seedChange(REPO, BRANCH, { "c.md": "c" }); }
      return orig(repo, branch, sha);
    };
    const r = await a.sync();
    expect(r.attempts).toBe(2);
    expect([...(await gh.snapshotFiles(REPO, BRANCH)).keys()].sort()).toEqual(["a.md", "b.md", "c.md"]);
  });
});

describe("GitHubRemote — settings helpers", () => {
  it("lists repos and branches for the pickers", async () => {
    const { gh, http, remote } = make();
    http.repos.add("owner/other");
    gh.seedRepo(REPO, "main", {});
    gh.seedRepo(REPO, "feature/x", {});
    expect((await remote.listRepos()).map(r => r.fullName).sort()).toEqual(["owner/other", "owner/repo"]);
    expect((await remote.listBranches(REPO)).sort()).toEqual(["feature/x", "main"]);
  });

  it("test connection: healthy fine-grained setup", async () => {
    const { gh, remote } = make();
    gh.seedRepo(REPO, BRANCH, {});
    const r = await remote.testConnection(REPO, BRANCH);
    expect(r.token).toMatchObject({ ok: true, login: "tester", scopes: null, expiresAt: "2026-12-31 00:00:00 UTC" });
    expect(r.repo).toMatchObject({ ok: true, canPush: true, scopeMissing: false });
    expect(r.branch).toEqual({ exists: true });
    expect(r.write).toBe("ok");
    expect(r.rateRemaining).toBe(4999);
  });

  it("test connection: classic token without repo scope, read-only, empty repo", async () => {
    const { http, remote } = make();
    http.scopes = "gist, read:user";
    http.canPush = false;
    const r = await remote.testConnection(REPO, BRANCH);
    expect(r.token).toMatchObject({ ok: true, scopes: ["gist", "read:user"] });
    expect(r.repo).toMatchObject({ ok: true, scopeMissing: true, canPush: false });
    expect(r.branch).toEqual({ exists: false });
    expect(r.write).toBe("unknown-empty-repo");
  });

  it("test connection: classic token with the repo scope is accepted", async () => {
    const { gh, http, remote } = make();
    gh.seedRepo(REPO, BRANCH, {});
    http.scopes = "repo, workflow";
    expect((await remote.testConnection(REPO, BRANCH)).repo).toMatchObject({ ok: true, scopeMissing: false });
  });

  it("test connection: write denied on a non-empty repo", async () => {
    const { gh, http, remote } = make();
    gh.seedRepo(REPO, BRANCH, {});
    http.canPush = false;
    expect((await remote.testConnection(REPO, BRANCH)).write).toBe("denied");
  });

  it("test connection: bad token stops early, invisible repo is reported", async () => {
    const bad = make({ token: "wrong" });
    const r1 = await bad.remote.testConnection(REPO, BRANCH);
    expect(r1.token.ok).toBe(false);
    expect(r1.repo).toBeUndefined();
    const { http, remote } = make();
    http.repos.clear();
    const r2 = await remote.testConnection(REPO, BRANCH);
    expect(r2.repo).toMatchObject({ ok: false });
  });
});

describe("GitHubRemote — 'repository not found' diagnosis", () => {
  it("on a 404 it lists what the token can see, so the user learns why", async () => {
    const { http, remote } = make();
    http.repos = new Set(["owner/test_vault"]);          // the repo GitHub knows
    const r = await remote.testConnection("owner/test-vault", BRANCH); // what the user typed
    expect(r.repo).toMatchObject({ ok: false, visible: [{ fullName: "owner/test_vault", private: true }] });
  });

  it("a token limited to public repositories sees no private repo", async () => {
    const { http, remote } = make();
    http.repos.clear();
    http.userRepos = [{ full_name: "owner/website", private: false }];
    const r = await remote.testConnection(REPO, BRANCH);
    expect(r.repo).toMatchObject({ ok: false, visible: [{ fullName: "owner/website", private: false }] });
  });
});

describe("client-side HTTP caching (regression: pushes rejected 3x in a row)", () => {
  // api.github.com sends Cache-Control: max-age=60 on the ref endpoint. A cache under
  // requestUrl served the pre-push head, every push was built on it and rejected as
  // not a fast-forward, and every re-plan read the same cached head.
  it("a second push within 60 s of the first is not built on a cached branch head", async () => {
    const gh = new FakeGitHub();
    const cached = new CachingHttp(new FakeGitHubHttp(gh, [REPO]).client);
    const remote = new GitHubRemote({ http: cached.client, getToken: () => TOKEN, log: quietLog, timers: testTimers() });
    const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync" });
    const vault = new FakeVault();
    const deps: SyncDeps = { vault, remote, state: new FakeState(), clock: new FakeClock(), log: quietLog,
      config: { repo: REPO, branch: BRANCH, deviceName: "A", platform: "posix", caseInsensitiveFs: false, exclude } };
    vault.seed("a.md", "one");
    await runSync(deps);                        // bootstrap + first push
    await vault.writeBytes(P("a.md"), enc("two"));
    cached.advance(10_000);                     // "sync after editing", well inside max-age
    const r = await runSync(deps);
    expect(r.status).toBe("ok");
    expect(r.attempts).toBe(1);
    expect(text((await gh.snapshotFiles(REPO, BRANCH)).get("a.md"))).toBe("two");
  });

  it("an edit made on github.com is seen right away, not after the cache expires", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "a.md": "one" });
    const cached = new CachingHttp(new FakeGitHubHttp(gh, [REPO]).client);
    const remote = new GitHubRemote({ http: cached.client, getToken: () => TOKEN, log: quietLog, timers: testTimers() });
    const first = (await remote.getRef(REPO, BRANCH))!.sha;
    gh.seedChange(REPO, BRANCH, { "a.md": "edited on the website" });
    cached.advance(5_000);
    expect((await remote.getRef(REPO, BRANCH))!.sha).not.toBe(first);
    const poll = await remote.getRefIfChanged(REPO, BRANCH, "");
    expect(poll.status === "changed" && poll.sha).not.toBe(first);
  });
});
