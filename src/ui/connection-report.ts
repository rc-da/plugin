import type { ConnectionReport } from "../adapters/github";
import { t } from "../i18n";

export interface ReportLine {
  status: "ok" | "warn" | "fail";
  label: string;
  detail: string;
}

/** Turn a test-connection report into lines that say exactly what is missing (§8). */
export function formatConnectionReport(r: ConnectionReport, repo: string, branch: string, now = Date.now()): ReportLine[] {
  const lines: ReportLine[] = [];
  if (!r.token.ok) {
    lines.push({ status: "fail", label: t("test.token"), detail: r.token.error.message });
    return lines;
  }
  const tok = r.token;
  const expiry = tok.expiresAt ? parseGitHubDate(tok.expiresAt) : NaN;
  const parts = [t("rep.signedIn", { login: tok.login, kind: t(tok.kind === "fine-grained" ? "rep.kind.fine" : tok.kind === "classic" ? "rep.kind.classic" : "rep.kind.unknown") })];
  let tokenStatus: ReportLine["status"] = "ok";
  if (tok.kind === "classic") { parts.push(t("rep.preferFine")); tokenStatus = "warn"; }
  if (!Number.isNaN(expiry)) {
    const days = Math.floor((expiry - now) / 86_400_000);
    parts.push(t("rep.expires", { days }));
    if (days < 14) tokenStatus = "warn";
  } else if (tok.kind !== "unknown") {
    parts.push(t("rep.noExpiry"));
    tokenStatus = "warn";
  }
  lines.push({ status: tokenStatus, label: t("test.token"), detail: parts.join(". ") + "." });

  if (!r.repo) return lines;
  if (!r.repo.ok) {
    lines.push({ status: "fail", label: t("test.repo"), detail: repoNotFoundDetail(r.repo.error.message, r.repo.visible, repo) });
    return lines;
  }
  if (r.repo.scopeMissing) {
    lines.push({ status: "fail", label: t("test.repo"), detail: t("rep.scopeMissing", { repo }) });
  } else if (!r.repo.canPush) {
    lines.push({ status: "fail", label: t("test.repo"), detail: t("rep.readOnly", { repo }) });
  } else {
    lines.push({ status: "ok", label: t("test.repo"), detail: t("rep.repoOk", { repo, visibility: t(r.repo.private ? "rep.private" : "rep.public") }) });
  }

  if (r.branch) {
    if (r.branch.error) lines.push({ status: "fail", label: t("test.branch"), detail: r.branch.error.message });
    else if (r.branch.exists) lines.push({ status: "ok", label: t("test.branch"), detail: t("rep.branchOk", { branch }) });
    else lines.push({ status: "warn", label: t("test.branch"), detail: t("rep.branchMissing", { branch }) });
  }

  if (r.write !== undefined) {
    if (r.write === "ok") lines.push({ status: "ok", label: t("test.write"), detail: t("rep.writeOk") });
    else if (r.write === "denied") lines.push({ status: "fail", label: t("test.write"), detail: t("rep.writeDenied") });
    else if (r.write === "unknown-empty-repo") lines.push({ status: "warn", label: t("test.write"), detail: t("rep.writeUnknown") });
    else lines.push({ status: "fail", label: t("test.write"), detail: r.write.message });
  }

  if (typeof r.rateRemaining === "number") {
    lines.push({ status: r.rateRemaining < 100 ? "warn" : "ok", label: t("test.rate"), detail: t("rep.rate", { n: r.rateRemaining }) });
  }
  return lines;
}

/**
 * GitHub's token-expiration header looks like "2026-12-01 10:00:00 UTC" or
 * "2026-12-01 10:00:00 -0800". NaN when unparseable.
 */
export function parseGitHubDate(v: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/.exec(v.trim());
  if (!m) return NaN;
  const zone = !m[3] || m[3] === "UTC" || m[3] === "Z" ? "Z" : m[3].length === 5 ? `${m[3].slice(0, 3)}:${m[3].slice(3)}` : m[3];
  return Date.parse(`${m[1]}T${m[2]}${zone}`);
}

/**
 * Why a repo was "not found", using the list of repositories the token can see.
 * GitHub returns 404 both for a wrong name and for "this token may not see it".
 */
export function repoNotFoundDetail(
  fallback: string,
  visible: { fullName: string; private: boolean }[] | null | undefined,
  repo: string,
): string {
  if (!visible) return fallback;
  const want = repo.toLowerCase();
  const name = want.split("/")[1] ?? want;
  if (visible.length === 0 || visible.every(v => !v.private)) {
    return t("rep.noPrivateAccess", { repo });
  }
  const exact = visible.find(v => v.fullName.toLowerCase() === want);
  if (exact) return fallback; // visible in the list but not by name: rare, keep GitHub's answer
  const close = visible.find(v => {
    const n = (v.fullName.split("/")[1] ?? "").toLowerCase();
    return n === name || n.replace(/[-_.]/g, "") === name.replace(/[-_.]/g, "");
  });
  if (close) return t("rep.didYouMean", { repo, other: close.fullName });
  const shown = visible.slice(0, 5).map(v => v.fullName).join(", ") + (visible.length > 5 ? ", …" : "");
  return t("rep.notInToken", { repo, list: shown });
}
