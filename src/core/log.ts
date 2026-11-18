import type { Logger } from "./ports";

// Ring-buffer logger (§8): the last N lines, viewable and copyable for bug reports.
// Every line is redacted *before* it is stored, so a token can never reach the
// buffer, the console or a pasted bug report.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogLine {
  at: number;
  level: LogLevel;
  msg: string;
}

const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,          // classic + OAuth/app/refresh tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,        // fine-grained tokens
  /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, // Authorization header values
];

export function redact(msg: string, secrets: Iterable<string> = []): string {
  let out = msg;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join("[redacted]");
  }
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, m => (/^(bearer|token)\s/i.test(m) ? `${m.split(/\s+/)[0]} [redacted]` : "[redacted]"));
  }
  return out;
}

export class RingLogger implements Logger {
  private readonly lines: LogLine[] = [];
  private readonly secrets = new Set<string>();

  constructor(
    private readonly capacity = 500,
    private readonly now: () => number = () => Date.now(),
    /** Also echo to the dev console (debug builds only). */
    private readonly echo?: (line: LogLine) => void,
  ) {}

  /** Register an exact secret value (the current token) for redaction. */
  addSecret(secret: string | null | undefined) {
    if (secret) this.secrets.add(secret);
  }

  debug(msg: string) { this.push("debug", msg); }
  info(msg: string) { this.push("info", msg); }
  warn(msg: string) { this.push("warn", msg); }
  error(msg: string) { this.push("error", msg); }

  entries(): readonly LogLine[] { return this.lines; }

  /** Plain text for "Copy log". */
  format(): string {
    return this.lines.map(l => `${new Date(l.at).toISOString()} ${l.level.toUpperCase().padEnd(5)} ${l.msg}`).join("\n");
  }

  private push(level: LogLevel, msg: string) {
    const line = { at: this.now(), level, msg: redact(msg, this.secrets) };
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    this.echo?.(line);
  }
}
