import { describe, it, expect } from "vitest";
import { configAllowed, type ConfigSyncOptions } from "../src/core/config-sync";
import { buildExcluder } from "../src/core/paths";
import { DEFAULT_SETTINGS, excludeKey, excluderOptions, migrateSettings, parseDeviceSettings, type Settings } from "../src/settings";
import { FakeGitHub } from "./fakes/fake-github";
import { FakeGitHubHttp } from "./fakes/fake-github-http";
import { FakeObsidianApp } from "./fakes/fake-obsidian-app";
import { FakeVault } from "./fakes/fake-vault";
import { FakeClock, FakeState } from "./fakes/fake-state";
import { ObsidianVault } from "../src/adapters/obsidian-vault";
import { GitHubRemote } from "../src/adapters/github";
import { MemoryKv, StateStore } from "../src/adapters/state-store";
import { runSync, type SyncDeps } from "../src/core/sync";
import { REPO, BRANCH, quietLog, P, text } from "./helpers";

const ALL: ConfigSyncOptions = { appearance: true, hotkeys: true, coreSettings: true, communityPlugins: true, pluginData: [], excludedPlugins: [] };
const NONE: ConfigSyncOptions = { appearance: false, hotkeys: false, coreSettings: false, communityPlugins: false, pluginData: [], excludedPlugins: [] };

describe("configAllowed — allow-list (§7)", () => {
  it.each([
    ["appearance.json", "appearance"], ["themes/Minimal/theme.css", "appearance"], ["themes/Minimal/manifest.json", "appearance"],
    ["snippets/wide.css", "appearance"], ["hotkeys.json", "hotkeys"], ["app.json", "coreSettings"], ["core-plugins.json", "coreSettings"],
    ["daily-notes.json", "coreSettings"], ["community-plugins.json", "communityPlugins"], ["plugins/dataview/main.js", "communityPlugins"],
    ["plugins/dataview/manifest.json", "communityPlugins"], ["plugins/dataview/styles.css", "communityPlugins"],
  ] as const)("%s needs %s", (path, cat) => {
    expect(configAllowed(path, false, ALL)).toBe(true);
    expect(configAllowed(path, false, NONE)).toBe(false);
    expect(configAllowed(path, false, { ...NONE, [cat]: true })).toBe(true);
  });

  it.each([
    "workspace.json", "workspace-mobile.json", "cache/x", "plugins/dataview/data.json", "plugins/dataview/node_modules/a.js",
    "plugins/dataview/cache.db", "themes/Minimal/extra.png", "snippets/sub/x.css", "snippets/notes.txt", "random.txt", "../escape.json",
  ])("%s is never synced with the defaults", path => {
    expect(configAllowed(path, false, ALL)).toBe(false);
  });

  it("plugin data.json only for opted-in plugins; excluded plugins disappear entirely", () => {
    const o = { ...ALL, pluginData: ["dataview"], excludedPlugins: ["desktop-only"] };
    expect(configAllowed("plugins/dataview/data.json", false, o)).toBe(true);
    expect(configAllowed("plugins/other/data.json", false, o)).toBe(false);
    expect(configAllowed("plugins/desktop-only/main.js", false, o)).toBe(false);
    expect(configAllowed("plugins/desktop-only", true, o)).toBe(false);
    expect(configAllowed("plugins/dataview", true, o)).toBe(true);
  });

  it("directories: descend only where allowed files can live", () => {
    expect(configAllowed("cache", true, ALL)).toBe(false);
    expect(configAllowed("themes", true, NONE)).toBe(false);
    expect(configAllowed("themes/Minimal", true, ALL)).toBe(true);
    expect(configAllowed("plugins", true, NONE)).toBe(false);
    expect(configAllowed("plugins", true, { ...NONE, pluginData: ["x"] })).toBe(true);
    expect(configAllowed("plugins/y", true, { ...NONE, pluginData: ["x"] })).toBe(false);
  });
});

describe("buildExcluder — hidden paths and config dir", () => {
  const base = { configDir: ".obsidian", pluginId: "vault-github-sync" };

  it("dot-paths outside the config dir are excluded except .gitignore (BUG_HISTORY)", () => {
    const ex = buildExcluder(base);
    for (const p of [".github/workflows/ci.yml", ".editorconfig", "notes/.draft.md", ".hidden/x.md"]) expect(ex(P(p)), p).toBe(true);
    expect(ex(P(".github"), true)).toBe(true);
    expect(ex(P(".gitignore"))).toBe(false);
    expect(ex(P("notes/.gitignore"))).toBe(true); // only the root one is listed by the vault
    expect(ex(P("notes/a.md"))).toBe(false);
  });

  it("config sync off: the whole config dir is excluded", () => {
    const ex = buildExcluder({ ...base, configSync: ALL });
    expect(ex(P(".obsidian/app.json"))).toBe(true);
    expect(ex(P(".obsidian"), true)).toBe(true);
  });

  it("config sync on: allow-list applies; always-excluded files stay excluded", () => {
    const ex = buildExcluder({ ...base, includeConfigDir: true, configSync: { ...ALL, pluginData: ["vault-github-sync", "dataview"] } });
    expect(ex(P(".obsidian"), true)).toBe(false);
    expect(ex(P(".obsidian/app.json"))).toBe(false);
    expect(ex(P(".obsidian/plugins/dataview/data.json"))).toBe(false);
    expect(ex(P(".obsidian/plugins/vault-github-sync/data.json"))).toBe(true); // our own settings: never
    expect(ex(P(".obsidian/workspace.json"))).toBe(true);
    expect(ex(P(".obsidian/cache"), true)).toBe(true);
  });

  it("respects a custom config dir name (never hard-coded)", () => {
    const ex = buildExcluder({ ...base, configDir: ".config-x", includeConfigDir: true, configSync: ALL });
    expect(ex(P(".config-x/app.json"))).toBe(false);
    expect(ex(P(".obsidian/app.json"))).toBe(true); // just another hidden folder now
  });
});

describe("settings: config sync and per-device excludes", () => {
  it("defaults: config sync off, every category ready", () => {
    const s = migrateSettings({}, () => {}).settings;
    expect(s.configSync).toEqual({ enabled: false, appearance: true, hotkeys: true, coreSettings: true, communityPlugins: true, pluginData: [] });
    expect(migrateSettings({ configSync: { enabled: true, hotkeys: "no", pluginData: ["a", 1] } }, () => {}).settings.configSync)
      .toMatchObject({ enabled: true, hotkeys: true, pluginData: ["a"] });
    expect(parseDeviceSettings(null)).toEqual({ excludePatterns: [], excludedPlugins: [] });
    expect(parseDeviceSettings({ excludePatterns: ["x/"], excludedPlugins: "nope" })).toEqual({ excludePatterns: ["x/"], excludedPlugins: [] });
  });

  it("device patterns and plugin excludes join the shared rules; the key changes with any of them", () => {
    const s: Settings = { ...DEFAULT_SETTINGS, excludePatterns: ["shared/"], configSync: { ...DEFAULT_SETTINGS.configSync, enabled: true } };
    const d = { excludePatterns: ["big-videos/"], excludedPlugins: ["desktop-only"] };
    const opts = excluderOptions(s, d, ".obsidian", "vault-github-sync", "*.log\n");
    const ex = buildExcluder(opts);
    expect(ex(P("shared/a.md"))).toBe(true);
    expect(ex(P("big-videos/a.mp4"))).toBe(true);
    expect(ex(P("x.log"))).toBe(true);
    expect(ex(P(".obsidian/plugins/desktop-only/main.js"))).toBe(true);
    expect(ex(P(".obsidian/plugins/other/main.js"))).toBe(false);
    const k = excludeKey(opts);
    expect(excludeKey(excluderOptions(s, { ...d, excludedPlugins: [] }, ".obsidian", "vault-github-sync", "*.log\n"))).not.toBe(k);
    expect(excludeKey(excluderOptions(s, d, ".obsidian", "vault-github-sync", ""))).not.toBe(k);
  });
});

describe("config sync end to end (two devices, real Obsidian adapter)", () => {
  function device(gh: FakeGitHub, http: FakeGitHubHttp, name: string, cs: Partial<ConfigSyncOptions>) {
    const fx = new FakeObsidianApp();
    const opts: ConfigSyncOptions = { ...ALL, ...cs };
    const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync", includeConfigDir: true, configSync: opts });
    const timers = { sleep: async () => {}, now: () => Date.now(), setTimer: (fn: () => void) => { const id = setTimeout(fn, 0); return () => clearTimeout(id); } };
    const deps: SyncDeps = {
      vault: new ObsidianVault(fx.app, { hiddenRoots: () => [".obsidian"], skipDir: p => exclude(P(p), true) }),
      remote: new GitHubRemote({ http: http.client, getToken: () => "test-token", log: quietLog, timers }),
      state: new StateStore(new MemoryKv()), clock: new FakeClock(), log: quietLog,
      config: { repo: REPO, branch: BRANCH, deviceName: name, platform: "posix", caseInsensitiveFs: false, exclude },
    };
    return { fx, sync: () => runSync(deps) };
  }

  it("syncs the allow-list, honours opt-in plugin data and per-device plugin excludes, never workspace or cache", async () => {
    const gh = new FakeGitHub();
    const http = new FakeGitHubHttp(gh, [REPO]);
    const a = device(gh, http, "Desktop", { pluginData: ["p1"] });
    const b = device(gh, http, "Phone", { pluginData: ["p1"], excludedPlugins: ["desktop-only"] });
    a.fx.seed("note.md", "n");
    a.fx.seed(".obsidian/appearance.json", "{\"theme\":\"obsidian\"}");
    a.fx.seed(".obsidian/snippets/wide.css", ".x{}");
    a.fx.seed(".obsidian/plugins/p1/main.js", "code");
    a.fx.seed(".obsidian/plugins/p1/manifest.json", "{}");
    a.fx.seed(".obsidian/plugins/p1/data.json", "{\"a\":1}");
    a.fx.seed(".obsidian/plugins/p2/data.json", "{\"secret\":\"x\"}");
    a.fx.seed(".obsidian/plugins/desktop-only/main.js", "desktop code");
    a.fx.seed(".obsidian/workspace.json", "{\"layout\":1}");
    a.fx.seed(".obsidian/cache/blob", "c");
    b.fx.seed(".obsidian/plugins/desktop-only/main.js", "phone's own copy");

    expect((await a.sync()).status).toBe("ok");
    const remote = [...(await gh.snapshotFiles(REPO, BRANCH)).keys()].sort();
    expect(remote).toEqual([
      ".gitkeep", ".obsidian/appearance.json", ".obsidian/plugins/desktop-only/main.js", ".obsidian/plugins/p1/data.json",
      ".obsidian/plugins/p1/main.js", ".obsidian/plugins/p1/manifest.json", ".obsidian/snippets/wide.css", "note.md",
    ]);

    await b.sync();
    expect(b.fx.read(".obsidian/appearance.json")).toBe("{\"theme\":\"obsidian\"}");
    expect(b.fx.read(".obsidian/plugins/p1/data.json")).toBe("{\"a\":1}");
    expect(b.fx.read(".obsidian/plugins/p2/data.json")).toBeUndefined();
    expect(b.fx.read(".obsidian/plugins/desktop-only/main.js")).toBe("phone's own copy"); // untouched here…
    expect(text((await gh.snapshotFiles(REPO, BRANCH)).get(".obsidian/plugins/desktop-only/main.js"))).toBe("desktop code"); // …and there

    // A settings change made on the phone reaches the desktop.
    b.fx.disk.get(".obsidian/appearance.json")!.data = new TextEncoder().encode("{\"theme\":\"moonstone\"}"); // seeded above
    b.fx.disk.get(".obsidian/appearance.json")!.mtime = 999_999;
    await b.sync();
    await a.sync();
    expect(a.fx.read(".obsidian/appearance.json")).toBe("{\"theme\":\"moonstone\"}");
    expect((await a.sync()).status).toBe("noop");
    expect((await b.sync()).status).toBe("noop");
  });
});

describe("switching config sync on and off is safe", () => {
  const exclude = (on: boolean) => buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync", includeConfigDir: on, configSync: ALL });
  const deps = (gh: FakeGitHub, vault: FakeVault, state: FakeState, on: boolean): SyncDeps => ({
    vault, remote: gh, state, clock: new FakeClock(), log: quietLog,
    config: { repo: REPO, branch: BRANCH, deviceName: "A", platform: "posix", caseInsensitiveFs: false, exclude: exclude(on), excludeKey: String(on) },
  });

  it("turning it on with existing settings on both sides: identical adopted, different kept as conflict copies", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "n.md": "n", ".obsidian/app.json": "{\"x\":1}", ".obsidian/hotkeys.json": "{\"remote\":true}" });
    const vault = new FakeVault();
    vault.seed("n.md", "n");
    vault.seed(".obsidian/app.json", "{\"x\":1}");
    vault.seed(".obsidian/hotkeys.json", "{\"local\":true}");
    const state = new FakeState();
    await runSync(deps(gh, vault, state, false));
    const r = await runSync(deps(gh, vault, state, true));
    expect(r.deleted).toBe(0);
    expect(r.conflicts).toBe(1);
    expect(text(vault.snapshot().get(".obsidian/hotkeys.json"))).toBe("{\"local\":true}");
    expect([...vault.snapshot().values()].map(b => text(b))).toContain("{\"remote\":true}");
  });

  it("turning it off forgets the config files without deleting them anywhere", async () => {
    const gh = new FakeGitHub();
    gh.seedRepo(REPO, BRANCH, { "n.md": "n", ".obsidian/app.json": "{}" });
    const vault = new FakeVault();
    vault.seed("n.md", "n");
    vault.seed(".obsidian/app.json", "{}");
    const state = new FakeState();
    await runSync(deps(gh, vault, state, true));
    await vault.deleteFile(P(".obsidian/app.json")); // even a local deletion is not pushed once excluded
    const r = await runSync(deps(gh, vault, state, false));
    expect(r.deleted + r.pushed).toBe(0);
    expect((await gh.snapshotFiles(REPO, BRANCH)).has(".obsidian/app.json")).toBe(true);
    expect(state.baseline!.files[P(".obsidian/app.json")]).toBeUndefined();
  });
});
