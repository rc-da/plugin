import { describe, it, expect } from "vitest";
import { RingLogger, redact } from "../src/core/log";
import { relativeTime, t } from "../src/i18n";
import { DEFAULT_SETTINGS, MIGRATED_SECRET_ID, isConfigured, migrateSettings } from "../src/settings";
import { INITIAL_STATUS, statusView, type StatusState } from "../src/ui/status-model";
import { formatConnectionReport, parseGitHubDate } from "../src/ui/connection-report";
import { detectOtherSyncTools } from "../src/other-sync";
import { SyncError } from "../src/core/types";

describe("log redaction (§8)", () => {
  const classic = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const fine = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";

  it("scrubs token-shaped strings and Authorization values before storing", () => {
    expect(redact(`token ${classic} failed`)).toBe("token [redacted] failed");
    expect(redact(`used ${classic}`)).toBe("used [redacted]");
    expect(redact(`pat=${fine}`)).toBe("pat=[redacted]");
    expect(redact("Authorization: Bearer abc.def-ghi_123")).toBe("Authorization: Bearer [redacted]");
    expect(redact("nothing secret here")).toBe("nothing secret here");
  });

  it("also scrubs registered exact secrets of any shape", () => {
    const log = new RingLogger(10, () => 0);
    log.addSecret("hunter2-custom");
    log.error("request with hunter2-custom failed");
    expect(log.format()).not.toContain("hunter2");
  });

  it("keeps only the last N lines", () => {
    const log = new RingLogger(3, () => 0);
    for (let i = 0; i < 5; i++) log.info(`line ${i}`);
    expect(log.entries().map(l => l.msg)).toEqual(["line 2", "line 3", "line 4"]);
    expect(log.format()).toMatch(/^1970-01-01T00:00:00.000Z INFO  line 2/);
  });
});

describe("i18n", () => {
  it("fills placeholders and leaves unknown ones (and {{template}} text) alone", () => {
    expect(t("status.pending", { n: 3 })).toBe("3 pending");
    expect(t("set.commit.desc")).toContain("{{device}}");
  });

  it("relative times", () => {
    expect(relativeTime(null, 0)).toBe("never");
    expect(relativeTime(0, 30_000)).toBe("just now");
    expect(relativeTime(0, 5 * 60_000)).toBe("5 min ago");
    expect(relativeTime(0, 3 * 3600_000)).toBe("3 h ago");
    expect(relativeTime(0, 2 * 86400_000)).toBe("2 d ago");
  });
});

describe("settings migration (§8)", () => {
  it("defaults for empty or garbage data", () => {
    expect(migrateSettings(null, () => {}).settings).toEqual(DEFAULT_SETTINGS);
    const { settings } = migrateSettings({ repo: 5, maxFileMB: 999, excludePatterns: ["a", 3] }, () => {});
    expect(settings.repo).toBe("");
    expect(settings.maxFileMB).toBe(50);
    expect(settings.excludePatterns).toEqual(["a"]);
  });

  it("moves a plaintext token into SecretStorage and drops it from data.json", () => {
    const stored: Record<string, string> = {};
    const { settings, changed } = migrateSettings({ repo: "o/r", token: "ghp_x" }, (id, v) => { stored[id] = v; });
    expect(stored[MIGRATED_SECRET_ID]).toBe("ghp_x");
    expect(settings.tokenSecretId).toBe(MIGRATED_SECRET_ID);
    expect(changed).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("ghp_x");
  });

  it("keeps the token (as legacyToken) when SecretStorage refuses it, so the user is not locked out", () => {
    const { settings, changed } = migrateSettings({ token: "ghp_x" }, () => { throw new Error("nope"); });
    expect(settings.tokenSecretId).toBe("");
    expect(settings.legacyToken).toBe("ghp_x");
    expect(changed).toBe(true); // token → legacyToken rename only
    // Next load retries the move.
    const stored: string[] = [];
    const again = migrateSettings(settings, (_id, v) => { stored.push(v); });
    expect(stored).toEqual(["ghp_x"]);
    expect(again.settings.legacyToken).toBeUndefined();
  });

  it("a plaintext token next to an already chosen secret is just dropped", () => {
    const calls: string[] = [];
    const { settings, changed } = migrateSettings({ tokenSecretId: "mine", token: "ghp_old" }, id => { calls.push(id); });
    expect(calls).toEqual([]);
    expect(settings.tokenSecretId).toBe("mine");
    expect(changed).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("ghp_old");
  });

  it("schedule settings: defaults, and out-of-range values fall back", () => {
    const d = migrateSettings({}, () => {}).settings;
    expect([d.syncOnStartup, d.syncOnForeground, d.intervalMinutes, d.debounceSeconds]).toEqual([true, true, 5, 60]);
    const s = migrateSettings({ syncOnStartup: false, intervalMinutes: 0, debounceSeconds: -5, syncOnForeground: "yes" }, () => {}).settings;
    expect([s.syncOnStartup, s.syncOnForeground, s.intervalMinutes, s.debounceSeconds]).toEqual([false, true, 0, 60]);
    expect(migrateSettings({ intervalMinutes: 2.5 }, () => {}).settings.intervalMinutes).toBe(5);
  });

  it("isConfigured", () => {
    expect(isConfigured({ ...DEFAULT_SETTINGS, repo: "o/r" })).toBe(true);
    expect(isConfigured({ ...DEFAULT_SETTINGS, repo: "o" })).toBe(false);
  });
});

describe("status bar model (§10)", () => {
  const base: StatusState = { ...INITIAL_STATUS, configured: true, lastSyncAt: 0 };
  const view = (patch: Partial<StatusState>, now = 120_000) => statusView({ ...base, ...patch }, now);

  it("shows the most important state first", () => {
    expect(view({ configured: false }).text).toBe("Set up sync");
    expect(view({ phase: "pulling", progress: { done: 12, total: 40 }, error: { kind: "Offline", message: "x" } }).text).toBe("Pulling 12/40");
    expect(view({ error: { kind: "Offline", message: "x" } }).icon).toBe("cloud-off");
    expect(view({ blockedUntil: 999_999 }).text).toBe("Waiting for GitHub");
    expect(view({ error: { kind: "AuthInvalid", message: "bad token" } })).toMatchObject({ text: "Sync error", tone: "error" });
    expect(view({ stopped: { kind: "custom", message: "m" } }).text).toBe("Needs review");
    expect(view({ conflicts: 2 }).text).toBe("2 conflict(s)");
    expect(view({ paused: true }).text).toBe("Auto-sync paused");
    expect(view({ pending: 3 }).text).toBe("3 pending");
    expect(view({ lastSyncAt: null }).text).toBe("Not synced yet");
    expect(view({})).toMatchObject({ text: "Synced", icon: "check", tone: "ok", spinning: false });
  });

  it("tooltip carries the error and last sync time", () => {
    const v = view({ error: { kind: "AuthInvalid", message: "bad token" } });
    expect(v.tooltip).toContain("bad token");
    expect(v.tooltip).toContain("Last sync: 2 min ago");
  });

  it("an expired rate-limit block no longer shows", () => {
    expect(view({ blockedUntil: 1000 }, 5000).text).toBe("Synced");
  });
});

describe("test-connection report (§8)", () => {
  const now = Date.parse("2026-11-18T00:00:00Z");
  const fineOk = { ok: true as const, login: "me", kind: "fine-grained" as const, scopes: null, expiresAt: "2026-12-31 00:00:00 UTC" };

  it("all good", () => {
    const lines = formatConnectionReport({
      token: fineOk, repo: { ok: true, private: true, canPush: true, defaultBranch: "main", scopeMissing: false },
      branch: { exists: true }, write: "ok", rateRemaining: 4000,
    }, "o/r", "main", now);
    expect(lines.map(l => l.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(lines[0].detail).toMatch(/me .*fine-grained.*43 day/);
  });

  it("says exactly what is missing", () => {
    const lines = formatConnectionReport({
      token: { ...fineOk, kind: "classic", scopes: ["gist"], expiresAt: null },
      repo: { ok: true, private: true, canPush: true, defaultBranch: "main", scopeMissing: true },
      branch: { exists: false }, write: "denied", rateRemaining: 50,
    }, "o/r", "main", now);
    expect(lines.map(l => [l.status, l.detail])).toEqual([
      ["warn", expect.stringMatching(/classic token.*fine-grained.*No expiry/)],
      ["fail", expect.stringContaining("\"repo\" scope")],
      ["warn", expect.stringContaining("first sync will create it")],
      ["fail", expect.stringContaining("Contents: read and write")],
      ["warn", "50 requests left this hour."],
    ]);
  });

  it("stops at the first blocking failure", () => {
    expect(formatConnectionReport({ token: { ok: false, error: new SyncError("AuthInvalid", "expired") } }, "o/r", "main"))
      .toEqual([{ status: "fail", label: "Token", detail: "expired" }]);
  });

  it("parses GitHub's expiry header formats", () => {
    expect(parseGitHubDate("2026-12-01 10:00:00 UTC")).toBe(Date.parse("2026-12-01T10:00:00Z"));
    expect(parseGitHubDate("2026-12-01 10:00:00 -0800")).toBe(Date.parse("2026-12-01T18:00:00Z"));
    expect(parseGitHubDate("soon")).toBeNaN();
  });
});

describe("other sync tool detection (§9)", () => {
  const probe = (files: Record<string, string>, basePath: string | null = null) => ({
    exists: async (p: string) => p in files,
    read: async (p: string) => files[p] ?? null,
    basePath, configDir: ".obsidian",
  });

  it("finds Syncthing, iCloud, Dropbox and Obsidian Sync (both core-plugins formats)", async () => {
    expect(await detectOtherSyncTools(probe({ ".stfolder": "" }))).toEqual(["Syncthing"]);
    expect(await detectOtherSyncTools(probe({}, "/Users/me/Library/Mobile Documents/iCloud~md~obsidian/Documents/V"))).toEqual(["iCloud"]);
    expect(await detectOtherSyncTools(probe({}, "C:\\Users\\me\\Dropbox\\Vault"))).toEqual(["Dropbox"]);
    expect(await detectOtherSyncTools(probe({ ".obsidian/core-plugins.json": "[\"sync\",\"graph\"]" }))).toEqual(["Obsidian Sync"]);
    expect(await detectOtherSyncTools(probe({ ".obsidian/core-plugins.json": "{\"sync\":true}" }))).toEqual(["Obsidian Sync"]);
    expect(await detectOtherSyncTools(probe({ ".obsidian/core-plugins.json": "{\"sync\":false}" }))).toEqual([]);
    expect(await detectOtherSyncTools(probe({ ".obsidian/core-plugins.json": "garbage" }, "/home/me/notes"))).toEqual([]);
  });
});

describe("i18n: every placeholder gets a value (regression)", () => {
  it("no t(\"key\") call without vars for a string that has {placeholders}", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
    walk("src");
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bt\("([\w.]+)"\)/g)) {
        const template = t(m[1] as Parameters<typeof t>[0]);
        if (/(^|[^{])\{\w+\}(?!\})/.test(template)) missing.push(`${f}: t("${m[1]}") → ${template}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
