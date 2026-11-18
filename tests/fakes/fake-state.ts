import type { Clock, RefPollRecord, StatePort } from "../../src/core/ports";
import type { Baseline, ConflictRecord, LocalCache } from "../../src/core/types";
import type { KillSwitch } from "./kill-switch";

/** In-memory StatePort. `saves` counts baseline writes (to assert batching/persistence). */
export class FakeState implements StatePort {
  baseline: Baseline | null = null;
  cache: LocalCache = {};
  conflicts: ConflictRecord[] = [];
  polls = new Map<string, RefPollRecord>();
  saves = 0;
  killSwitch?: KillSwitch;

  private alive(what: string) { this.killSwitch?.check(what); }

  async loadBaseline(repo: string, branch: string): Promise<Baseline | null> {
    this.alive("loadBaseline");
    if (!this.baseline) return null;
    if (this.baseline.repo !== repo || this.baseline.branch !== branch) return this.baseline; // let core decide
    return structuredClone(this.baseline);
  }
  async saveBaseline(baseline: Baseline): Promise<void> {
    this.alive("saveBaseline");
    this.saves++;
    this.baseline = structuredClone(baseline);
  }
  async loadLocalCache(): Promise<LocalCache> { return structuredClone(this.cache); }
  async saveLocalCache(cache: LocalCache): Promise<void> { this.alive("saveLocalCache"); this.cache = structuredClone(cache); }
  async loadConflicts(): Promise<ConflictRecord[]> { return structuredClone(this.conflicts); }
  async saveConflicts(records: ConflictRecord[]): Promise<void> { this.alive("saveConflicts"); this.conflicts = structuredClone(records); }
  async loadRefPoll(repo: string, branch: string): Promise<RefPollRecord | null> { return this.polls.get(`${repo}#${branch}`) ?? null; }
  async saveRefPoll(repo: string, branch: string, record: RefPollRecord): Promise<void> { this.polls.set(`${repo}#${branch}`, { ...record }); }
}

export class FakeClock implements Clock {
  constructor(public time = 1_700_000_000_000) {}
  now(): number { return this.time; }
  isoDate(): string { return new Date(this.time).toISOString(); }
  advance(ms: number) { this.time += ms; }
}
