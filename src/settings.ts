import { DEFAULT_COMMIT_TEMPLATE } from "./core/push";
import { EXCLUDE_RULES_VERSION, type ExcludeOptions } from "./core/paths";

// Settings stored in data.json (synced with the vault's config, so: nothing secret,
// nothing device-specific). The token lives in SecretStorage (§8); data.json only
// stores the secret's id. Device name lives in vault-scoped localStorage (§4).

export interface Settings {
  version: 1;
  repo: string;
  branch: string;
  /** Id of the token in app.secretStorage (picked with SecretComponent). */
  tokenSecretId: string;
  commitTemplate: string;
  maxFileMB: number;
  excludePatterns: string[];
  autoSyncPaused: boolean;
  syncOnStartup: boolean;
  syncOnForeground: boolean;
  /** Minutes between interval checks; 0 = off. */
  intervalMinutes: number;
  /** Seconds after the last edit; 0 = off. */
  debounceSeconds: number;
  /** Opt-in sync of the config dir (§7), by category. */
  configSync: ConfigSyncSettings;
  /**
   * A plaintext token from an older data.json that could not be moved to
   * SecretStorage. Kept (so the user is not locked out) until they pick a secret.
   */
  legacyToken?: string;
}

export interface ConfigSyncSettings {
  enabled: boolean;
  appearance: boolean;
  hotkeys: boolean;
  coreSettings: boolean;
  communityPlugins: boolean;
  /** Plugin ids whose data.json is synced (opt-in per plugin: they often hold secrets). */
  pluginData: string[];
}

/** Per-device settings, kept in vault-scoped localStorage (never synced). */
export interface DeviceSettings {
  excludePatterns: string[];
  /** Community plugins not synced on this device (e.g. desktop-only ones). */
  excludedPlugins: string[];
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = { excludePatterns: [], excludedPlugins: [] };

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  repo: "",
  branch: "main",
  tokenSecretId: "",
  commitTemplate: DEFAULT_COMMIT_TEMPLATE,
  maxFileMB: 50,
  excludePatterns: [],
  autoSyncPaused: false,
  syncOnStartup: true,
  syncOnForeground: true,
  intervalMinutes: 5,
  debounceSeconds: 60,
  configSync: { enabled: false, appearance: true, hotkeys: true, coreSettings: true, communityPlugins: true, pluginData: [] },
};

export const MIGRATED_SECRET_ID = "vault-github-sync-token";

export interface MigrationResult {
  settings: Settings;
  /** True when data.json must be rewritten (e.g. a plaintext token was removed). */
  changed: boolean;
}

/**
 * Normalize whatever loadData() returned into valid Settings. Unknown or wrongly
 * typed fields fall back to defaults. A plaintext token (`token`, or `legacyToken`
 * from an earlier failed attempt) is moved into SecretStorage via `storeSecret`;
 * it is dropped from the settings only if that call succeeded (§8).
 */
export function migrateSettings(raw: unknown, storeSecret: (id: string, value: string) => void): MigrationResult {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
  const settings: Settings = {
    version: 1,
    repo: str(r.repo, DEFAULT_SETTINGS.repo).trim(),
    branch: str(r.branch, DEFAULT_SETTINGS.branch).trim() || DEFAULT_SETTINGS.branch,
    tokenSecretId: str(r.tokenSecretId, ""),
    commitTemplate: str(r.commitTemplate, DEFAULT_SETTINGS.commitTemplate) || DEFAULT_SETTINGS.commitTemplate,
    maxFileMB: typeof r.maxFileMB === "number" && r.maxFileMB > 0 && r.maxFileMB <= 100 ? r.maxFileMB : DEFAULT_SETTINGS.maxFileMB,
    excludePatterns: Array.isArray(r.excludePatterns) ? r.excludePatterns.filter((p): p is string => typeof p === "string") : [],
    autoSyncPaused: r.autoSyncPaused === true,
    syncOnStartup: typeof r.syncOnStartup === "boolean" ? r.syncOnStartup : DEFAULT_SETTINGS.syncOnStartup,
    syncOnForeground: typeof r.syncOnForeground === "boolean" ? r.syncOnForeground : DEFAULT_SETTINGS.syncOnForeground,
    intervalMinutes: intIn(r.intervalMinutes, 0, 1440, DEFAULT_SETTINGS.intervalMinutes),
    debounceSeconds: intIn(r.debounceSeconds, 0, 3600, DEFAULT_SETTINGS.debounceSeconds),
    configSync: parseConfigSync(r.configSync),
  };
  let changed = false;

  const plaintext = typeof r.token === "string" && r.token ? r.token
    : typeof r.legacyToken === "string" && r.legacyToken ? r.legacyToken : null;
  if (plaintext !== null) {
    if (settings.tokenSecretId) {
      // A secret is already chosen; the plaintext copy is redundant. Drop it.
      changed = true;
    } else {
      try {
        storeSecret(MIGRATED_SECRET_ID, plaintext);
        settings.tokenSecretId = MIGRATED_SECRET_ID;
        changed = true;
      } catch {
        settings.legacyToken = plaintext;
        changed = typeof r.token === "string"; // rename token → legacyToken, nothing else
      }
    }
  }
  return { settings, changed };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function parseConfigSync(v: unknown): ConfigSyncSettings {
  const d = DEFAULT_SETTINGS.configSync;
  const r = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const bool = (x: unknown, def: boolean) => (typeof x === "boolean" ? x : def);
  return {
    enabled: bool(r.enabled, d.enabled),
    appearance: bool(r.appearance, d.appearance),
    hotkeys: bool(r.hotkeys, d.hotkeys),
    coreSettings: bool(r.coreSettings, d.coreSettings),
    communityPlugins: bool(r.communityPlugins, d.communityPlugins),
    pluginData: strings(r.pluginData),
  };
}

export function parseDeviceSettings(raw: unknown): DeviceSettings {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return { excludePatterns: strings(r.excludePatterns), excludedPlugins: strings(r.excludedPlugins) };
}

/**
 * Everything that decides what is synced (§7): built-in rules, the repo's .gitignore,
 * shared patterns, this device's patterns and plugin excludes, the config allow-list.
 */
export function excluderOptions(s: Settings, d: DeviceSettings, configDir: string, pluginId: string, gitignoreText: string): ExcludeOptions {
  const cs = s.configSync;
  return {
    configDir, pluginId, gitignoreText,
    userPatterns: [...s.excludePatterns, ...d.excludePatterns],
    includeConfigDir: cs.enabled,
    configSync: {
      appearance: cs.appearance, hotkeys: cs.hotkeys, coreSettings: cs.coreSettings, communityPlugins: cs.communityPlugins,
      pluginData: cs.pluginData, excludedPlugins: d.excludedPlugins,
    },
  };
}

function intIn(v: unknown, min: number, max: number, d: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : d;
}

/** Fingerprint of everything that changes what is excluded (core re-walks the remote when it changes). */
export function excludeKey(opts: ExcludeOptions): string {
  return JSON.stringify({ v: EXCLUDE_RULES_VERSION, ...opts });
}

/** True when repo and branch look usable. */
export function isConfigured(s: Settings): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.repo) && s.branch.length > 0;
}
