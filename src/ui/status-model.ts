import type { SyncPhase } from "../core/sync";
import type { GuardStop, SyncErrorKind } from "../core/types";
import { relativeTime, t } from "../i18n";

// Pure model behind the status bar (§10): idle ✓ / pending / syncing with progress /
// conflicts / needs review / error. No DOM here so it can be unit-tested.

export interface StatusState {
  configured: boolean;
  phase: SyncPhase | "idle";
  progress: { done: number; total: number } | null;
  paused: boolean;
  lastSyncAt: number | null;
  pending: number;
  conflicts: number;
  /** A guard stopped the last sync and is waiting for the user. */
  stopped: GuardStop | null;
  error: { kind: SyncErrorKind; message: string } | null;
  /** Auto-sync is held back until this time (rate limit). */
  blockedUntil: number | null;
}

export const INITIAL_STATUS: StatusState = {
  configured: false, phase: "idle", progress: null, paused: false, lastSyncAt: null,
  pending: 0, conflicts: 0, stopped: null, error: null, blockedUntil: null,
};

export type StatusTone = "ok" | "busy" | "warn" | "error" | "muted";

export interface StatusView {
  /** Lucide icon id (Obsidian ships Lucide). */
  icon: string;
  text: string;
  tooltip: string;
  tone: StatusTone;
  spinning: boolean;
}

export function statusView(s: StatusState, now: number): StatusView {
  const last = t("status.lastSync", { when: relativeTime(s.lastSyncAt, now) });
  const tip = (first: string) => [first, last, t("status.clickForMenu")].filter(Boolean).join("\n");

  if (!s.configured) return { icon: "settings", text: t("status.notConfigured"), tooltip: tip(""), tone: "muted", spinning: false };
  if (s.phase !== "idle") {
    const label = t(`status.${s.phase}` as const);
    const text = s.progress && s.progress.total > 0 && (s.phase === "pulling" || s.phase === "pushing" || s.phase === "scanning")
      ? `${label} ${s.progress.done}/${s.progress.total}` : label;
    return { icon: "refresh-cw", text, tooltip: tip(""), tone: "busy", spinning: true };
  }
  if (s.error && s.error.kind === "Offline") {
    return { icon: "cloud-off", text: t("status.offline"), tooltip: tip(s.error.message), tone: "muted", spinning: false };
  }
  if (s.blockedUntil !== null && s.blockedUntil > now) {
    return { icon: "hourglass", text: t("status.rateLimited"), tooltip: tip(s.error?.message ?? ""), tone: "warn", spinning: false };
  }
  if (s.error) return { icon: "alert-triangle", text: t("status.error"), tooltip: tip(s.error.message), tone: "error", spinning: false };
  if (s.stopped) return { icon: "shield-alert", text: t("status.stopped"), tooltip: tip(s.stopped.message), tone: "warn", spinning: false };
  if (s.conflicts > 0) return { icon: "git-merge", text: t("status.conflicts", { n: s.conflicts }), tooltip: tip(""), tone: "warn", spinning: false };
  if (s.paused) return { icon: "pause", text: t("status.paused"), tooltip: tip(""), tone: "muted", spinning: false };
  if (s.pending > 0) return { icon: "upload-cloud", text: t("status.pending", { n: s.pending }), tooltip: tip(""), tone: "muted", spinning: false };
  if (s.lastSyncAt === null) return { icon: "cloud", text: t("status.neverSynced"), tooltip: tip(""), tone: "muted", spinning: false };
  return { icon: "check", text: t("status.idle"), tooltip: tip(""), tone: "ok", spinning: false };
}
