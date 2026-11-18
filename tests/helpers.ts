import type { Logger } from "../src/core/ports";
import type { Baseline, FileMode, Path, Sha } from "../src/core/types";
import { mkPath, mkSha } from "../src/core/types";

export const REPO = "owner/repo";
export const BRANCH = "main";

export const quietLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Logger that records messages for assertions. */
export function recordingLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    debug: m => lines.push(`debug ${m}`),
    info: m => lines.push(`info ${m}`),
    warn: m => lines.push(`warn ${m}`),
    error: m => lines.push(`error ${m}`),
  };
}

export function emptyBaseline(remoteHead: Sha | null = null): Baseline {
  return { repo: REPO, branch: BRANCH, remoteHead, files: {}, dirs: {} };
}

export function baselineWith(
  files: Record<string, string | { sha: string; mode?: FileMode }>,
  remoteHead: Sha | null = null,
): Baseline {
  const b = emptyBaseline(remoteHead);
  for (const [p, v] of Object.entries(files)) {
    const entry = typeof v === "string" ? { sha: v } : v;
    b.files[mkPath(p)] = { sha: mkSha(entry.sha), mode: entry.mode ?? "100644" };
  }
  return b;
}

export const P = (s: string): Path => mkPath(s);
export const S = (s: string): Sha => mkSha(s);

export const text = (b: Uint8Array | undefined): string | undefined =>
  b === undefined ? undefined : new TextDecoder().decode(b);
