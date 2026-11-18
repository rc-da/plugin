import { FileSystemAdapter, Menu, Notice, Platform, Plugin, type TAbstractFile } from "obsidian";
import { GitHubRemote } from "./adapters/github";
import { obsidianHttp } from "./adapters/obsidian-http";
import { ObsidianVault } from "./adapters/obsidian-vault";
import { IndexedDbKv, MemoryKv, StateStore, vaultInstanceId, type KvBackend } from "./adapters/state-store";
import { RingLogger } from "./core/log";
import { buildExcluder, normalizePath as normalizeCorePath, type Excluder } from "./core/paths";
import type { Clock } from "./core/ports";
import { t } from "./i18n";
import { detectOtherSyncTools } from "./other-sync";
import {
  DEFAULT_SETTINGS, excludeKey, excluderOptions, isConfigured, migrateSettings, parseDeviceSettings,
  type DeviceSettings, type Settings,
} from "./settings";
import { SyncController } from "./sync-controller";
import { Scheduler } from "./scheduler";
import { checkRemote } from "./core/poll";
import { SyncSettingTab } from "./ui/settings-tab";
import { formatConnectionReport } from "./ui/connection-report";
import { ModalCoordinator } from "./ui/modal-coordinator";
import { GuardModal } from "./ui/mass-delete-modal";
import { ReviewModal } from "./ui/review-modal";
import { ConflictModal } from "./ui/conflict-modal";
import { LogModal } from "./ui/log-view";
import { resolveConflict, sameConflict, staleConflicts, type ConflictChoice } from "./core/conflicts";
import { previewLocalChanges } from "./core/preview";
import { TEXT_EXTENSIONS, extensionOf } from "./core/merge";
import type { ConflictRecord, GuardStop } from "./core/types";
import { StatusBar } from "./ui/status-bar";
import { statusView, type StatusState } from "./ui/status-model";

const PLUGIN_ID = "vault-github-sync";
const DEVICE_KEY = `${PLUGIN_ID}:device-name`;
const DEVICE_SETTINGS_KEY = `${PLUGIN_ID}:device-settings`;

const clock: Clock = { now: () => Date.now(), isoDate: () => new Date().toISOString() };

export default class VaultGitHubSyncPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  readonly logger = new RingLogger(500);
  remote!: GitHubRemote; // assigned first thing in onload
  private kv: KvBackend = new MemoryKv();
  private state!: StateStore; // assigned in onload
  private controller!: SyncController; // assigned in onload
  private scheduler!: Scheduler; // assigned in onload
  private vaultPort!: ObsidianVault; // assigned in onload
  private readonly modals = new ModalCoordinator(() => new Promise<void>(res => activeWindow.requestAnimationFrame(() => res())));
  private statusBar: StatusBar | null = null;
  private excluder: { key: string; fn: Excluder } | null = null;
  /** Contents of the vault's root .gitignore (re-read before every sync). */
  private gitignoreText = "";

  async onload() {
    this.remote = new GitHubRemote({
      http: obsidianHttp,
      getToken: () => this.token(),
      log: this.logger,
      userAgent: `${PLUGIN_ID}/${this.manifest.version}`,
    });
    await this.loadSettings();

    const id = vaultInstanceId(k => this.app.loadLocalStorage(k), (k, v) => this.app.saveLocalStorage(k, v));
    if (typeof indexedDB !== "undefined") this.kv = new IndexedDbKv(`${PLUGIN_ID}-${id}`);
    else this.logger.warn("IndexedDB unavailable: sync state will not survive a restart");
    this.state = new StateStore(this.kv);

    await this.readGitignore();
    const cfgDir = this.app.vault.configDir;
    const vault = new ObsidianVault(this.app, {
      hiddenRoots: () => (this.settings.configSync.enabled ? [cfgDir] : []),
      skipDir: p => this.exclude()(normalizeCorePath(p), true),
    });
    this.vaultPort = vault;
    this.controller = new SyncController({
      prepare: async () => {
        await this.readGitignore();
        if (!isConfigured(this.settings)) return { ok: false, reason: "notConfigured" };
        if (!this.token()) return { ok: false, reason: "noToken" };
        const s = this.settings;
        return {
          ok: true,
          deps: {
            vault, remote: this.remote, state: this.state, clock, log: this.logger,
            yieldToHost: () => new Promise(res => activeWindow.setTimeout(res, 0)),
            config: {
              repo: s.repo, branch: s.branch, deviceName: this.deviceName(), commitTemplate: s.commitTemplate,
              maxFileBytes: s.maxFileMB * 1024 * 1024,
              platform: Platform.isWin ? "windows" : "posix",
              // Windows, macOS, iOS and Android shared storage are case-insensitive (§9).
              caseInsensitiveFs: !Platform.isLinux,
              exclude: this.exclude(), excludeKey: excludeKey(this.excludeOptions()),
            },
          },
        };
      },
      notify: msg => new Notice(msg),
      onState: s => this.renderStatus(s),
      loadConflictCount: async () => (await this.state.loadConflicts()).length,
      rateLimit: () => this.remote.rateLimit,
      now: () => Date.now(),
      formatTime: ms => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      onLocalChange: () => this.scheduler.localChange(),
      onGuardStop: stop => this.showGuard(stop),
      log: this.logger,
    });
    this.scheduler = new Scheduler({
      timers: {
        // activeWindow: popout windows (§12). Handles are also cleared in onunload via stop().
        setTimeout: (fn, ms) => activeWindow.setTimeout(fn, ms),
        clearTimeout: id => activeWindow.clearTimeout(id),
        setInterval: (fn, ms) => this.registerInterval(activeWindow.setInterval(fn, ms)),
        clearInterval: id => activeWindow.clearInterval(id),
      },
      now: () => Date.now(),
      log: this.logger,
      sync: () => this.controller.sync("auto"),
      canAutoSync: () => this.controller.canAutoSync() && this.token() !== null,
      hasLocalChanges: () => this.controller.hasLocalChanges,
      checkRemote: () => checkRemote(this.remote, this.state, this.settings.repo, this.settings.branch),
    });
    this.scheduler.configure(this.scheduleOptions());
    this.controller.setConfigured(isConfigured(this.settings));
    this.controller.setPaused(this.settings.autoSyncPaused);

    const bar = new StatusBar(this.addStatusBarItem());
    this.statusBar = bar;
    this.registerDomEvent(bar.el, "click", evt => this.statusMenu(evt));
    this.registerInterval(activeWindow.setInterval(() => this.renderStatus(this.controller.status), 60_000));

    this.addRibbonIcon("refresh-cw", t("ribbon.sync"), () => { void this.controller.sync("manual"); });
    this.addCommand({ id: "sync-now", name: t("cmd.syncNow"), callback: () => { void this.controller.sync("manual"); } });
    this.addCommand({ id: "test-connection", name: t("cmd.testConnection"), callback: () => { void this.testConnectionNotice(); } });
    this.addCommand({ id: "toggle-auto-sync", name: `${t("cmd.pause")} / ${t("cmd.resume")}`, callback: () => { void this.togglePaused(); } });
    this.addCommand({ id: "copy-log", name: t("cmd.copyLog"), callback: () => { void this.copyLog(); } });
    this.addCommand({ id: "review-changes", name: t("cmd.review"), callback: () => this.showReview() });
    this.addCommand({ id: "resolve-conflicts", name: t("cmd.conflicts"), callback: () => this.showConflicts() });
    this.addCommand({ id: "show-log", name: t("cmd.log"), callback: () => this.showLog() });

    this.addSettingTab(new SyncSettingTab({
      app: this.app, plugin: this, settings: this.settings,
      saveSettings: () => this.saveSettings(),
      remote: this.remote,
      deviceName: () => this.deviceName(),
      setDeviceName: name => this.app.saveLocalStorage(DEVICE_KEY, name),
      deviceSettings: () => this.deviceSettings(),
      saveDeviceSettings: d => { this.app.saveLocalStorage(DEVICE_SETTINGS_KEY, d); this.excluder = null; },
      installedPlugins: () => this.installedPlugins(),
      resetSyncState: () => this.state.clear(),
      otherSyncTools: () => this.otherSyncTools(),
    }));

    this.app.workspace.onLayoutReady(() => {
      // Registered only now: while the vault loads, Obsidian fires "create" for every
      // existing file, which would count the whole vault as pending.
      // Local change tracking: renames are pushed as renames (§5.2); the rest feeds the pending count.
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
        if (!this.excludedFile(file)) this.controller.recordRename(oldPath, file.path);
      }));
      for (const ev of ["create", "modify", "delete"] as const) {
        this.registerEvent(this.app.vault.on(ev as "modify", (file: TAbstractFile) => {
          if (!this.excludedFile(file)) this.controller.noteLocalChange(file.path);
        }));
      }
      void this.controller.refreshConflicts();
      this.scheduler.start();
    });
    this.registerDomEvent(activeDocument, "visibilitychange", () => {
      this.scheduler.visibilityChanged(activeDocument.visibilityState === "visible");
    });
  }

  onunload() {
    this.scheduler.stop();
    this.modals.closeAll();
    if (this.kv instanceof IndexedDbKv) this.kv.close();
  }

  // ── settings ───────────────────────────────────────────────────────────────

  private async loadSettings() {
    const { settings, changed } = migrateSettings(await this.loadData(), (id, value) => this.app.secretStorage.setSecret(id, value));
    this.settings = settings;
    // Only rewrite data.json after the secret was stored; migrateSettings keeps the
    // plaintext copy (as legacyToken) when that failed.
    if (changed) await this.saveData(this.settings);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.excluder = null;
    this.controller.setConfigured(isConfigured(this.settings));
    this.controller.setPaused(this.settings.autoSyncPaused);
    this.scheduler.configure(this.scheduleOptions());
  }

  private scheduleOptions() {
    const s = this.settings;
    return { onStartup: s.syncOnStartup, onForeground: s.syncOnForeground, intervalMinutes: s.intervalMinutes, debounceSeconds: s.debounceSeconds };
  }

  private token(): string | null {
    const s = this.settings;
    const tok = s.tokenSecretId ? this.app.secretStorage.getSecret(s.tokenSecretId) : (s.legacyToken ?? null);
    this.logger.addSecret(tok);
    return tok;
  }

  deviceName(): string {
    const stored: unknown = this.app.loadLocalStorage(DEVICE_KEY);
    if (typeof stored === "string" && stored.trim()) return stored;
    const kind = Platform.isIosApp ? "iPhone" : Platform.isAndroidApp ? "Android" : Platform.isMacOS ? "Mac" : Platform.isWin ? "Windows" : "Linux";
    const name = `${kind}-${Math.random().toString(36).slice(2, 6)}`;
    this.app.saveLocalStorage(DEVICE_KEY, name);
    return name;
  }

  private deviceSettings(): DeviceSettings {
    return parseDeviceSettings(this.app.loadLocalStorage(DEVICE_SETTINGS_KEY));
  }

  private excludeOptions() {
    return excluderOptions(this.settings, this.deviceSettings(), this.app.vault.configDir, PLUGIN_ID, this.gitignoreText);
  }

  private exclude(): Excluder {
    const opts = this.excludeOptions();
    const key = excludeKey(opts);
    if (!this.excluder || this.excluder.key !== key) this.excluder = { key, fn: buildExcluder(opts) };
    return this.excluder.fn;
  }

  private async readGitignore() {
    const adapter = this.app.vault.adapter;
    try {
      this.gitignoreText = (await adapter.exists(".gitignore")) ? await adapter.read(".gitignore") : "";
    } catch (e) {
      this.logger.warn(`could not read .gitignore: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Community plugin folders under the config dir (no private API: just the folder listing). */
  private async installedPlugins(): Promise<string[]> {
    const dir = `${this.app.vault.configDir}/plugins`;
    try {
      const listed = await this.app.vault.adapter.list(dir);
      return listed.folders.map(f => f.slice(dir.length + 1)).filter(id => id && id !== PLUGIN_ID).sort();
    } catch {
      return [];
    }
  }

  private excludedFile(file: TAbstractFile): boolean {
    return this.exclude()(normalizeCorePath(file.path));
  }

  private async otherSyncTools(): Promise<string[]> {
    const adapter = this.app.vault.adapter;
    return detectOtherSyncTools({
      exists: p => adapter.exists(p),
      read: async p => ((await adapter.exists(p)) ? adapter.read(p) : null),
      basePath: adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null,
      configDir: this.app.vault.configDir,
    });
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  private renderStatus(s: StatusState) {
    this.statusBar?.render(statusView(s, Date.now()));
  }

  private statusMenu(evt: MouseEvent) {
    const s = this.controller.status;
    const menu = new Menu();
    menu.addItem(i => i.setTitle(t("cmd.syncNow")).setIcon("refresh-cw").onClick(() => { void this.controller.sync("manual"); }));
    const stopped = s.stopped;
    if (stopped) menu.addItem(i => i.setTitle(t("menu.review")).setIcon("shield-alert").onClick(() => this.showGuard(stopped)));
    if (s.conflicts > 0) menu.addItem(i => i.setTitle(t("menu.conflicts", { n: s.conflicts })).setIcon("git-merge").onClick(() => this.showConflicts()));
    const problem = s.error?.message;
    if (problem) menu.addItem(i => i.setTitle(problem.length > 80 ? `${problem.slice(0, 77)}…` : problem).setIcon("info").onClick(() => new Notice(problem)));
    menu.addItem(i => i.setTitle(t("cmd.review")).setIcon("list-checks").onClick(() => this.showReview()));
    menu.addItem(i => i.setTitle(t("cmd.log")).setIcon("scroll-text").onClick(() => this.showLog()));
    menu.addItem(i => i.setTitle(s.paused ? t("cmd.resume") : t("cmd.pause")).setIcon(s.paused ? "play" : "pause").onClick(() => { void this.togglePaused(); }));
    menu.addItem(i => i.setTitle(t("cmd.copyLog")).setIcon("clipboard-copy").onClick(() => { void this.copyLog(); }));
    menu.showAtMouseEvent(evt);
  }

  // ── modals (all through ModalCoordinator, §10) ─────────────────────────────

  private showGuard(stop: GuardStop) {
    if (stop.kind === "custom") { new Notice(t("notice.stopped", { message: stop.message })); return; }
    void this.modals.open(() => new GuardModal(this.app, stop, approvals => { void this.controller.sync("manual", { approvals }); }));
  }

  private showReview() {
    const s = this.settings;
    if (!isConfigured(s)) { new Notice(t("notice.notConfigured")); return; }
    void this.modals.open(() => new ReviewModal(
      this.app,
      () => previewLocalChanges({
        vault: this.vaultPort, state: this.state, repo: s.repo, branch: s.branch, exclude: this.exclude(),
        pendingRenames: [...this.controller.pendingRenames], maxFileBytes: s.maxFileMB * 1024 * 1024,
        yieldToHost: () => new Promise(res => activeWindow.setTimeout(res, 0)),
      }),
      () => this.controller.isSyncing,
      holdBack => { void this.controller.sync("manual", { holdBack }); },
    ));
  }

  private showConflicts() {
    void this.modals.open(() => new ConflictModal(this.app, {
      list: async () => {
        const all = await this.state.loadConflicts();
        const stale = await staleConflicts(this.vaultPort, all);
        if (stale.length > 0) await this.dropConflicts(stale);
        return all.filter(r => !stale.some(x => sameConflict(x, r)));
      },
      resolve: async (rec: ConflictRecord, choice: ConflictChoice) => {
        const out = await resolveConflict(this.vaultPort, rec, choice);
        if (out.status !== "refused") await this.dropConflicts([rec]);
        return out;
      },
      compare: rec => { void this.openSideBySide(rec.path, rec.conflictPath); },
      isText: path => TEXT_EXTENSIONS.has(extensionOf(path)),
      isBusy: () => this.controller.isSyncing,
      done: n => { new Notice(t("conflicts.resolved", { n })); void this.controller.refreshConflicts(); },
    }));
  }

  private showLog() {
    void this.modals.open(() => new LogModal(this.app, this.logger));
  }

  /** Remove records from the persisted list (re-read first: a sync may have added some). */
  private async dropConflicts(done: ConflictRecord[]) {
    const all = await this.state.loadConflicts();
    await this.state.saveConflicts(all.filter(r => !done.some(d => sameConflict(d, r))));
    await this.controller.refreshConflicts();
  }

  private async openSideBySide(a: string, b: string) {
    const fa = this.app.vault.getFileByPath(a);
    const fb = this.app.vault.getFileByPath(b);
    if (fa) await this.app.workspace.getLeaf("tab").openFile(fa);
    if (fb) await this.app.workspace.getLeaf("split", "vertical").openFile(fb);
  }

  private async togglePaused() {
    this.settings.autoSyncPaused = !this.settings.autoSyncPaused;
    await this.saveSettings();
    new Notice(this.settings.autoSyncPaused ? t("notice.paused") : t("notice.resumed"));
  }

  private async copyLog() {
    await navigator.clipboard.writeText(this.logger.format());
    new Notice(t("notice.logCopied"));
  }

  private async testConnectionNotice() {
    const report = await this.remote.testConnection(this.settings.repo, this.settings.branch);
    const lines = formatConnectionReport(report, this.settings.repo, this.settings.branch);
    new Notice(lines.map(l => `${l.status === "ok" ? "✓" : l.status === "warn" ? "!" : "✗"} ${l.label}: ${l.detail}`).join("\n"), 15_000);
  }
}
