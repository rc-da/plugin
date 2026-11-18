import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FakeGitHub } from "./fakes/fake-github";
import { FakeGitHubHttp } from "./fakes/fake-github-http";
import { FakeObsidianApp } from "./fakes/fake-obsidian-app";
import { FakeEl, makeObsidianRuntime, type RuntimeLog } from "./fakes/obsidian-runtime";
import { REPO, BRANCH, text } from "./helpers";

// Smoke test of the *built* plugin (main.js, or the file in $BUNDLE, e.g. a downloaded
// release asset): load it the way Obsidian does (CommonJS, `require("obsidian")`),
// run onload, render the settings tab, and sync through the plugin's own commands
// with requestUrl routed to an in-memory GitHub. This is the only test that runs
// main.ts wiring; everything else tests the modules directly.
// Run with `npm run test:bundle` after `npm run build`.

const BUNDLE = resolve(process.env.BUNDLE ?? "main.js");
const TOKEN = "test-token";

interface LoadedPlugin {
  onload(): Promise<void>;
  data: unknown;
  commands: { id: string; callback: () => void }[];
  ribbons: { icon: string; title: string }[];
  tabs: { display(): void; containerEl: FakeEl }[];
  statusItems: FakeEl[];
  unloadForTest(): void;
}

let plugin: LoadedPlugin | null = null;

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.activeWindow = { setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0) };
  g.activeDocument = Object.assign(new FakeEl(), { visibilityState: "visible" });
});

afterEach(() => { plugin?.unloadForTest(); plugin = null; });

function load(gh: FakeGitHub, data: unknown, opts: { secrets?: Record<string, string> } = {}) {
  const log: RuntimeLog = { notices: [], icons: [], tooltips: [], settings: [] };
  const http = new FakeGitHubHttp(gh, [REPO]);
  const obsidian = makeObsidianRuntime(http.client, log);
  const code = readFileSync(BUNDLE, "utf8");
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const req = (id: string) => {
    if (id === "obsidian") return obsidian;
    throw new Error(`bundle required "${id}": only "obsidian" is available inside Obsidian (and nothing on mobile)`);
  };
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  const PluginClass = (mod.exports.default ?? mod.exports) as new (app: unknown, manifest: unknown) => LoadedPlugin;

  const fx = new FakeObsidianApp();
  const secrets = new Map(Object.entries(opts.secrets ?? { "gh-token": TOKEN }));
  const local = new Map<string, unknown>();
  const vault = fx.vault as Record<string, unknown>;
  vault.configDir = ".obsidian";
  vault.on = () => ({});
  (fx.vault.adapter as Record<string, unknown>).read = async (p: string) => fx.read(p) ?? "";
  Object.assign(fx, {
    workspace: { onLayoutReady: (cb: () => void) => cb(), getLeaf: () => ({ openFile: async () => {} }) },
    secretStorage: { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, v: string) => { secrets.set(id, v); }, listSecrets: () => [...secrets.keys()] },
    loadLocalStorage: (k: string) => local.get(k) ?? null,
    saveLocalStorage: (k: string, v: unknown) => { local.set(k, v); },
  });
  const p = new PluginClass(fx.app, { id: "vault-github-sync", version: "0.0.0-test" });
  p.data = data;
  plugin = p;
  return { p, fx, log, secrets };
}

async function until(cond: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

const settings = { repo: REPO, branch: BRANCH, tokenSecretId: "gh-token", syncOnStartup: false, syncOnForeground: false, intervalMinutes: 0, debounceSeconds: 0 };

describe.skipIf(!existsSync(BUNDLE))(`built plugin bundle (${BUNDLE})`, () => {
  it("loads like Obsidian loads it, registers its UI, renders settings", async () => {
    const { p, log } = load(new FakeGitHub(), settings);
    await p.onload();
    expect(p.commands.map(c => c.id).sort()).toEqual([
      "copy-log", "resolve-conflicts", "review-changes", "show-log", "sync-now", "test-connection", "toggle-auto-sync",
    ]);
    expect(p.ribbons).toHaveLength(1);
    expect(p.statusItems).toHaveLength(1);
    expect(p.tabs).toHaveLength(1);
    p.tabs[0].display();
    const names = log.settings.map(s => s.name);
    for (const n of ["Access token", "Repository", "Branch", "Test connection", "Sync the .obsidian folder", "Device name"]) expect(names).toContain(n);
  });

  it("syncs through its own commands: push, pull, status bar, notices", async () => {
    const gh = new FakeGitHub();
    const { p, fx, log } = load(gh, settings);
    fx.seed("note.md", "hello");
    fx.seed("img.bin", new Uint8Array([0, 1, 2, 255]));
    await p.onload();
    const cmd = (id: string) => p.commands.find(c => c.id === id)?.callback();

    cmd("sync-now");
    await until(() => log.notices.some(n => n.startsWith("Synced")), "first sync");
    const remote = await gh.snapshotFiles(REPO, BRANCH);
    expect(text(remote.get("note.md"))).toBe("hello");
    expect(remote.get("img.bin")).toEqual(new Uint8Array([0, 1, 2, 255]));
    await until(() => p.statusItems[0].allText().includes("Synced"), "status bar");

    gh.seedChange(REPO, BRANCH, { "from-phone.md": "written elsewhere" });
    log.notices.length = 0;
    cmd("sync-now");
    await until(() => log.notices.some(n => n.startsWith("Synced")), "second sync");
    expect(fx.read("from-phone.md")).toBe("written elsewhere");

    log.notices.length = 0;
    cmd("test-connection");
    await until(() => log.notices.length > 0, "test connection");
    expect(log.notices[0]).toMatch(/✓ Token: Signed in as tester/);
    expect(log.notices[0]).toMatch(/✓ Write access/);
  });

  it("never stores the token in data.json; migrates an old plaintext token into secret storage", async () => {
    const { p, secrets } = load(new FakeGitHub(), { ...settings, tokenSecretId: "", token: "ghp_plaintextOldToken123456" }, { secrets: {} });
    await p.onload();
    expect(secrets.get("vault-github-sync-token")).toBe("ghp_plaintextOldToken123456");
    expect(JSON.stringify(p.data)).not.toContain("ghp_plaintext");
    expect(p.data).toMatchObject({ tokenSecretId: "vault-github-sync-token" });
  });

  it("without settings it tells the user what to do instead of failing", async () => {
    const { p, log } = load(new FakeGitHub(), null);
    await p.onload();
    expect(p.statusItems[0].allText()).toContain("Set up sync");
    p.commands.find(c => c.id === "sync-now")?.callback();
    await until(() => log.notices.length > 0, "notice");
    expect(log.notices[0]).toMatch(/not set up yet/);
  });
});
