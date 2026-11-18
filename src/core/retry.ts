import type { Logger } from "./ports";
import { SyncError } from "./types";

// Retry policy (§6.4). Pure: timers and randomness are injected so tests run instantly.
//
// - Every request gets a timeout (requestUrl has none of its own, §2).
// - Offline / Timeout / ServerError: exponential backoff with jitter, max 4 tries.
// - RateLimited: wait for the reset when it is close (≤ 60 s), else give up and let
//   the caller report when sync will resume.
// - Everything else (auth, permission, not found, too large, conflicts…) is final.

export interface Timers {
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Start a timer; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
}

export const realTimers: Timers = {
  sleep: ms => new Promise(res => setTimeout(res, ms)),
  now: () => Date.now(),
  setTimer: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); },
};

export interface RetryOptions {
  /** Total attempts including the first. Default 4. */
  maxTries?: number;
  /** First backoff delay; doubles each retry (1 s, 2 s, 4 s, 8 s). */
  baseDelayMs?: number;
  /** Longest rate-limit wait we sit out inside one sync. Default 60 s. */
  maxRateLimitWaitMs?: number;
  /** 0..1, injectable for tests. */
  random?: () => number;
  log?: Logger;
  /** For log lines only; must never contain secrets. */
  label?: string;
}

export function isRetryable(e: unknown): boolean {
  return e instanceof SyncError && (e.kind === "Offline" || e.kind === "Timeout" || e.kind === "ServerError");
}

/** Backoff for retry number `n` (1-based): base·2^(n-1), with "equal jitter" (half fixed, half random). */
export function backoffDelay(n: number, baseMs: number, random: () => number): number {
  const d = baseMs * 2 ** (n - 1);
  return d / 2 + random() * (d / 2);
}

export async function withRetry<T>(fn: () => Promise<T>, timers: Timers, opts: RetryOptions = {}): Promise<T> {
  const maxTries = opts.maxTries ?? 4;
  const base = opts.baseDelayMs ?? 1000;
  const maxWait = opts.maxRateLimitWaitMs ?? 60_000;
  const random = opts.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= maxTries) throw e;
      if (e instanceof SyncError && e.kind === "RateLimited") {
        const wait = Math.max(0, (e.resetAt ?? timers.now() + maxWait + 1) - timers.now());
        if (wait > maxWait) throw e;
        opts.log?.warn(`${opts.label ?? "request"}: rate limited, waiting ${Math.ceil(wait / 1000)} s`);
        await timers.sleep(wait + 250);
        continue;
      }
      if (!isRetryable(e)) throw e;
      const delay = backoffDelay(attempt, base, random);
      opts.log?.info(`${opts.label ?? "request"}: ${(e as SyncError).kind}, retry ${attempt}/${maxTries - 1} in ${Math.round(delay)} ms`);
      await timers.sleep(delay);
    }
  }
}

/**
 * Race `work` against a timer. The underlying request cannot be aborted
 * (requestUrl has no abort), so its eventual result is ignored.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, timers: Timers, label = "request"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cancel = timers.setTimer(() => {
      if (settled) return;
      settled = true;
      reject(new SyncError("Timeout", `${label} timed out after ${Math.round(ms / 1000)} s`));
    }, ms);
    work.then(
      v => { if (!settled) { settled = true; cancel(); resolve(v); } },
      e => { if (!settled) { settled = true; cancel(); reject(e); } },
    );
  });
}
