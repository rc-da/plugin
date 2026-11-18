import { AbstractInputSuggest, type App, Notice, type Plugin, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type { GitHubRemote } from "../adapters/github";
import { t } from "../i18n";
import type { DeviceSettings, Settings } from "../settings";
import { formatConnectionReport } from "./connection-report";

// Settings tab (§7, §8, §10). No modals are opened from here (modal rule): test
// results render inline and "reset" uses a click-twice confirmation.

export interface SettingsHost {
  app: App;
  plugin: Plugin;
  settings: Settings;
  saveSettings(): Promise<void>;
  remote: GitHubRemote;
  deviceName(): string;
  setDeviceName(name: string): void;
  resetSyncState(): Promise<void>;
  otherSyncTools(): Promise<string[]>;
  deviceSettings(): DeviceSettings;
  saveDeviceSettings(d: DeviceSettings): void;
  installedPlugins(): Promise<string[]>;
}

export class SyncSettingTab extends PluginSettingTab {
  constructor(private readonly host: SettingsHost) {
    super(host.app, host.plugin);
  }

  display(): void {
    const { containerEl } = this;
    const h = this.host;
    const s = h.settings;
    containerEl.empty();
    containerEl.addClass("vgs-settings");

    const warning = containerEl.createDiv({ cls: "vgs-warning" });
    warning.hide();
    void h.otherSyncTools().then(tools => {
      if (tools.length === 0) return;
      warning.setText(t("set.otherSync", { tools: tools.join(", ") }));
      warning.show();
    });

    new Setting(containerEl).setName(t("set.github")).setHeading();

    const tokenSetting = new Setting(containerEl)
      .setName(t("set.token.name"))
      .setDesc(t("set.token.desc"))
      .addComponent(el => new SecretComponent(this.app, el)
        .setValue(s.tokenSecretId)
        .onChange(async id => {
          s.tokenSecretId = id ?? "";
          if (s.tokenSecretId) delete s.legacyToken; // picked a real secret: drop the plaintext copy
          await h.saveSettings();
        }));
    if (s.legacyToken) tokenSetting.descEl.createDiv({ cls: "vgs-warning", text: t("set.token.legacy") });

    new Setting(containerEl)
      .setName(t("set.repo.name"))
      .setDesc(t("set.repo.desc"))
      .addText(text => {
        text.setPlaceholder("owner/notes").setValue(s.repo).onChange(async v => { s.repo = v.trim(); await h.saveSettings(); });
        new ListSuggest(this.app, text.inputEl, () => h.remote.listRepos().then(rs => rs.map(r => r.fullName)), async v => {
          s.repo = v;
          await h.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(t("set.branch.name"))
      .setDesc(t("set.branch.desc"))
      .addText(text => {
        text.setPlaceholder("main").setValue(s.branch).onChange(async v => { s.branch = v.trim() || "main"; await h.saveSettings(); });
        new ListSuggest(this.app, text.inputEl, () => (s.repo ? h.remote.listBranches(s.repo) : Promise.resolve([])), async v => {
          s.branch = v;
          await h.saveSettings();
        });
      });

    const testSetting = new Setting(containerEl).setName(t("set.test.name")).setDesc(t("set.test.desc"));
    const results = containerEl.createDiv({ cls: "vgs-test-results" });
    testSetting.addButton(btn => btn.setButtonText(t("set.test.button")).onClick(async () => {
      btn.setDisabled(true).setButtonText(t("set.test.running"));
      results.empty();
      try {
        const report = await h.remote.testConnection(s.repo, s.branch);
        for (const line of formatConnectionReport(report, s.repo, s.branch)) {
          const row = results.createDiv({ cls: `vgs-test-line vgs-test-${line.status}` });
          row.createSpan({ cls: "vgs-test-label", text: line.label });
          row.createSpan({ cls: "vgs-test-detail", text: line.detail });
        }
      } catch (e) {
        results.createDiv({ cls: "vgs-test-line vgs-test-fail", text: e instanceof Error ? e.message : String(e) });
      } finally {
        btn.setDisabled(false).setButtonText(t("set.test.button"));
      }
    }));

    new Setting(containerEl).setName(t("set.auto")).setHeading();

    new Setting(containerEl)
      .setName(t("set.paused.name"))
      .setDesc(t("set.paused.desc"))
      .addToggle(tg => tg.setValue(s.autoSyncPaused).onChange(async v => { s.autoSyncPaused = v; await h.saveSettings(); }));
    new Setting(containerEl)
      .setName(t("set.startup.name"))
      .addToggle(tg => tg.setValue(s.syncOnStartup).onChange(async v => { s.syncOnStartup = v; await h.saveSettings(); }));
    new Setting(containerEl)
      .setName(t("set.foreground.name"))
      .setDesc(t("set.foreground.desc"))
      .addToggle(tg => tg.setValue(s.syncOnForeground).onChange(async v => { s.syncOnForeground = v; await h.saveSettings(); }));
    numberSetting(containerEl, t("set.interval.name"), t("set.interval.desc"), s.intervalMinutes, 0, 1440, async n => { s.intervalMinutes = n; await h.saveSettings(); });
    numberSetting(containerEl, t("set.debounce.name"), t("set.debounce.desc"), s.debounceSeconds, 0, 3600, async n => { s.debounceSeconds = n; await h.saveSettings(); });

    new Setting(containerEl).setName(t("set.sync")).setHeading();

    new Setting(containerEl)
      .setName(t("set.commit.name"))
      .setDesc(t("set.commit.desc"))
      .addText(text => text.setValue(s.commitTemplate).onChange(async v => { s.commitTemplate = v || s.commitTemplate; await h.saveSettings(); }));

    new Setting(containerEl)
      .setName(t("set.maxSize.name"))
      .setDesc(t("set.maxSize.desc"))
      .addText(text => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "100";
        text.setValue(String(s.maxFileMB)).onChange(async v => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0 && n <= 100) { s.maxFileMB = n; await h.saveSettings(); }
        });
      });

    new Setting(containerEl)
      .setName(t("set.exclude.name"))
      .setDesc(t("set.exclude.desc"))
      .addTextArea(area => {
        area.inputEl.rows = 4;
        area.setValue(s.excludePatterns.join("\n")).onChange(async v => {
          s.excludePatterns = v.split("\n").map(l => l.trim()).filter(Boolean);
          await h.saveSettings();
        });
      });

    this.configSection(containerEl);

    let armed = false;
    new Setting(containerEl)
      .setName(t("set.reset.name"))
      .setDesc(t("set.reset.desc"))
      .addButton(btn => btn.setButtonText(t("set.reset.button")).setWarning().onClick(async () => {
        if (!armed) {
          armed = true;
          btn.setButtonText(t("set.reset.confirm"));
          activeWindow.setTimeout(() => { armed = false; btn.setButtonText(t("set.reset.button")); }, 4000);
          return;
        }
        armed = false;
        await h.resetSyncState();
        btn.setButtonText(t("set.reset.button"));
        new Notice(t("set.reset.done"));
      }));

    new Setting(containerEl).setName(t("set.device")).setHeading();

    new Setting(containerEl)
      .setName(t("set.device.name"))
      .setDesc(t("set.device.desc"))
      .addText(text => text.setValue(h.deviceName()).onChange(v => { if (v.trim()) h.setDeviceName(v.trim()); }));

    const dev = h.deviceSettings();
    new Setting(containerEl)
      .setName(t("set.devExclude.name"))
      .setDesc(t("set.devExclude.desc"))
      .addTextArea(area => {
        area.inputEl.rows = 3;
        area.setValue(dev.excludePatterns.join("\n")).onChange(v => {
          h.saveDeviceSettings({ ...h.deviceSettings(), excludePatterns: v.split("\n").map(l => l.trim()).filter(Boolean) });
        });
      });
    if (s.configSync.enabled && s.configSync.communityPlugins) {
      const box = containerEl.createDiv();
      void h.installedPlugins().then(ids => {
        if (ids.length === 0) return;
        new Setting(box).setName(t("set.devPlugins.name")).setDesc(t("set.devPlugins.desc"));
        for (const id of ids) {
          new Setting(box).setName(id).setClass("vgs-sub").addToggle(tg => tg
            .setValue(h.deviceSettings().excludedPlugins.includes(id))
            .onChange(v => {
              const cur = h.deviceSettings();
              const set = new Set(cur.excludedPlugins);
              if (v) set.add(id); else set.delete(id);
              h.saveDeviceSettings({ ...cur, excludedPlugins: [...set].sort() });
            }));
        }
      });
    }
  }

  /** Opt-in config-dir sync with its allow-list categories (§7). */
  private configSection(containerEl: HTMLElement) {
    const h = this.host;
    const cs = h.settings.configSync;
    new Setting(containerEl).setName(t("set.config")).setHeading();
    new Setting(containerEl)
      .setName(t("set.config.enabled.name", { dir: this.app.vault.configDir }))
      .setDesc(t("set.config.enabled.desc"))
      .addToggle(tg => tg.setValue(cs.enabled).onChange(async v => {
        cs.enabled = v;
        await h.saveSettings();
        this.display(); // show or hide the categories (re-render, not a modal)
      }));
    if (!cs.enabled) return;
    const toggle = (name: string, desc: string, key: "appearance" | "hotkeys" | "coreSettings" | "communityPlugins") => {
      new Setting(containerEl).setName(name).setDesc(desc).setClass("vgs-sub")
        .addToggle(tg => tg.setValue(cs[key]).onChange(async v => { cs[key] = v; await h.saveSettings(); this.display(); }));
    };
    toggle(t("set.config.appearance.name"), t("set.config.appearance.desc"), "appearance");
    toggle(t("set.config.hotkeys.name"), t("set.config.hotkeys.desc"), "hotkeys");
    toggle(t("set.config.core.name"), t("set.config.core.desc"), "coreSettings");
    toggle(t("set.config.plugins.name"), t("set.config.plugins.desc"), "communityPlugins");

    const box = containerEl.createDiv();
    void h.installedPlugins().then(ids => {
      if (ids.length === 0) return;
      new Setting(box).setName(t("set.config.data.name")).setDesc(t("set.config.data.desc")).setClass("vgs-sub");
      for (const id of ids) {
        new Setting(box).setName(id).setClass("vgs-sub2").addToggle(tg => tg
          .setValue(cs.pluginData.includes(id))
          .onChange(async v => {
            const set = new Set(cs.pluginData);
            if (v) set.add(id); else set.delete(id);
            cs.pluginData = [...set].sort();
            await h.saveSettings();
          }));
      }
    });
  }
}

function numberSetting(el: HTMLElement, name: string, desc: string, value: number, min: number, max: number, save: (n: number) => Promise<void>) {
  new Setting(el).setName(name).setDesc(desc).addText(text => {
    text.inputEl.type = "number";
    text.inputEl.min = String(min);
    text.inputEl.max = String(max);
    text.setValue(String(value)).onChange(async v => {
      const n = Number(v);
      if (Number.isInteger(n) && n >= min && n <= max) await save(n);
    });
  });
}

/** Text-input suggestions from a lazily fetched list (repos, branches). Fetch errors just mean no suggestions. */
class ListSuggest extends AbstractInputSuggest<string> {
  private cache: Promise<string[]> | null = null;

  constructor(
    app: App,
    private readonly input: HTMLInputElement,
    private readonly fetch: () => Promise<string[]>,
    private readonly onPick: (value: string) => Promise<void>,
  ) {
    super(app, input);
    // Branch list depends on the repo: refetch whenever the field gains focus.
    input.addEventListener("focus", () => { this.cache = null; });
  }

  async getSuggestions(query: string): Promise<string[]> {
    this.cache ??= this.fetch().catch(() => []);
    const q = query.toLowerCase();
    return (await this.cache).filter(v => v.toLowerCase().includes(q)).slice(0, 50);
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }

  selectSuggestion(value: string): void {
    this.setValue(value);
    this.input.dispatchEvent(new Event("input"));
    void this.onPick(value);
    this.close();
  }
}
