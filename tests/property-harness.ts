import { expect } from "vitest";
import fc from "fast-check";
import { FakeGitHub, type FaultKind } from "./fakes/fake-github";
import { FakeVault } from "./fakes/fake-vault";
import { FakeState, FakeClock } from "./fakes/fake-state";
import { KillSwitch } from "./fakes/kill-switch";
import { runSync, type SyncDeps } from "../src/core/sync";
import type { GuardApprovals } from "../src/core/guards";
import type { SyncResult } from "../src/core/types";
import { buildExcluder } from "../src/core/paths";
import type { RemotePort } from "../src/core/ports";
import type { RenameRecord } from "../src/core/scan";
import { mkPath } from "../src/core/types";
import { REPO, BRANCH, quietLog, text } from "./helpers";
import { GitHubRemote } from "../src/adapters/github";
import { FakeGitHubHttp } from "./fakes/fake-github-http";

// §11 property test: two devices, random edits (text + binary, overlapping and not),
// random syncs with injected network faults and "app killed here" points. After the
// storm, sync until quiet and check:
//   1. both devices and the remote hold identical content;
//   2. no edit is lost: every token a user typed and never removed is somewhere in the vault;
//   3. every binary file is byte-identical to a version a user wrote;
//   4. nothing is gone that a user did not delete or rename away.

const enc = (s: string) => new TextEncoder().encode(s);
const exclude = buildExcluder({ configDir: ".obsidian", pluginId: "vault-github-sync" });
export const TEXT_FILES = ["n0.md", "n1.md", "dir/n2.md", "dir/n3.md"];
export const BIN_FILES = ["b0.bin", "dir/b1.bin"];

export type Dev = 0 | 1;
export type Step =
  | { t: "create"; dev: Dev; file: number }
  | { t: "append"; dev: Dev; file: number }
  | { t: "prepend"; dev: Dev; file: number }
  | { t: "replace"; dev: Dev; file: number; line: number }
  | { t: "delete"; dev: Dev; file: number }
  | { t: "rename"; dev: Dev; file: number; to: number }
  | { t: "binary"; dev: Dev; file: number; seed: number }
  | { t: "binaryDelete"; dev: Dev; file: number }
  | { t: "sync"; dev: Dev; fault: null | { at: number; kind: FaultKind | "kill" | "race" } };

const dev = fc.constantFrom<Dev>(0, 1);
const tf = fc.integer({ min: 0, max: TEXT_FILES.length - 1 });
const bf = fc.integer({ min: 0, max: BIN_FILES.length - 1 });
// "race": the other device syncs in the middle of this one's request sequence (→ 422 retry).
const fault = fc.oneof(
  { weight: 7, arbitrary: fc.constant(null) },
  {
    weight: 3,
    arbitrary: fc.record({
      at: fc.integer({ min: 1, max: 12 }),
      kind: fc.constantFrom<FaultKind | "kill" | "race">("offline", "timeout", "serverError", "rateLimit", "kill", "kill", "race", "race"),
    }),
  },
);
export const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant("create" as const), dev, file: tf }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("append" as const), dev, file: tf }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("prepend" as const), dev, file: tf }) },
  { weight: 6, arbitrary: fc.record({ t: fc.constant("replace" as const), dev, file: tf, line: fc.nat(20) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("delete" as const), dev, file: tf }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("rename" as const), dev, file: tf, to: tf }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("binary" as const), dev, file: bf, seed: fc.nat(1000) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("binaryDelete" as const), dev, file: bf }) },
  { weight: 7, arbitrary: fc.record({ t: fc.constant("sync" as const), dev, fault }) },
);

/**
 * RemotePort view of the shared fake that dies with its device, and that can run
 * an "interleaved" action (the other device's sync) right before a request.
 */
/**
 * The remote a device talks to: FakeGitHub directly, or (viaAdapter) the real
 * GitHubRemote over FakeGitHubHttp, so faults travel as HTTP responses through
 * the adapter's error mapping and retry policy.
 */
function remoteFor(gh: FakeGitHub, sw: KillSwitch, interleave: { run: (() => Promise<void>) | null }, viaAdapter: boolean): RemotePort {
  const target: RemotePort = viaAdapter
    ? new GitHubRemote({
      http: new FakeGitHubHttp(gh, [REPO]).client, getToken: () => "test-token", log: quietLog,
      timers: {
        sleep: async () => {}, now: () => Date.now(),
        setTimer: (fn, _ms) => { const id = setTimeout(fn, 0); return () => clearTimeout(id); },
      },
    })
    : gh;
  return new Proxy(target, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        if (interleave.run) {
          const run = interleave.run;
          interleave.run = null;
          await run();
        }
        sw.check(String(prop));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as RemotePort;
}

export class Device {
  sw = new KillSwitch();
  vault = new FakeVault({ killSwitch: this.sw });
  state = new FakeState();
  clock = new FakeClock();
  remote: RemotePort;
  renames: RenameRecord[] = [];
  interleave: { run: (() => Promise<void>) | null } = { run: null };
  /** Content of each path as last written by the user on this device (text), or bytes (binary). */
  lastWritten = new Map<string, string | Uint8Array>();

  constructor(public gh: FakeGitHub, public name: string, viaAdapter = false) {
    this.state.killSwitch = this.sw;
    this.remote = remoteFor(gh, this.sw, this.interleave, viaAdapter);
  }

  deps(extra: Partial<SyncDeps> = {}): SyncDeps {
    return {
      ...extra,
      vault: this.vault, remote: this.remote, state: this.state, clock: this.clock, log: quietLog,
      config: { repo: REPO, branch: BRANCH, deviceName: this.name, platform: "posix", caseInsensitiveFs: false, exclude },
      pendingRenames: this.renames,
    };
  }

  snapshot(): Map<string, Uint8Array> { return this.vault.snapshot(); }
  has(p: string) { return this.vault.snapshot().has(p); }
  read(p: string): string { return text(this.vault.snapshot().get(p))!; }
}

export interface World {
  gh: FakeGitHub;
  devs: [Device, Device];
  tokenCounter: number;
  /** Tokens removed by a user action (replace/delete) while visible to that user. */
  removedByUser: Set<string>;
  /** Paths a user deleted or renamed away, with the content they saw at the time (for #4 and #2). */
  userRemovedPaths: Set<string>;
  /** Paths a user created (directly or as a rename target). */
  userCreatedPaths: Set<string>;
  /** Every binary payload any user ever wrote. */
  binaryVersions: string[];
  /** Binary payloads a user overwrote while seeing them. */
  supersededBinary: Set<string>;
  /**
   * Binary content a user deleted, per path. A later write of the *same bytes* at that
   * path does not cancel the deletion: content-based 3-way sync (like git) sees the
   * remote equal to the deleter's base and rightly applies the delete (A→B→A).
   */
  binaryDeletedAt: Map<string, Set<string>>;
  renameLog: string[];
  log: string[];
}

const key = (b: Uint8Array) => Array.from(b).join(",");

/** What the storm actually exercised, across all runs — asserted at the end so the generator stays meaningful. */
export const coverage = { merged: 0, conflicts: 0, failedSyncs: 0, retriedPushes: 0, kills: 0, races: 0, renames: 0, guardStops: 0 };

/**
 * A manual sync by a user who confirms whatever a guard asks: in this harness
 * every deletion is a real user action, so confirming is the right answer.
 * (Storm syncs are silent auto-syncs: a guard stop just leaves things as they are.)
 */
async function manualSync(d: Device): Promise<SyncResult> {
  let approvals: GuardApprovals = {};
  for (let i = 0; ; i++) {
    const r = await runSync(d.deps({ approvals }));
    if (r.status !== "stopped" || !r.stop || i >= 3) return r;
    coverage.guardStops++;
    if (r.stop.kind === "emptyRemote") approvals = { ...approvals, emptyRemote: { head: r.stop.head, resolution: "applyDeletions" } };
    else if (r.stop.kind === "massDelete") approvals = { ...approvals, deletions: { local: r.stop.local, remote: r.stop.remote } };
    else return r;
  }
}

export async function applyStep(w: World, s: Step): Promise<void> {
  const d = w.devs[s.dev];
  if (s.t === "sync") {
    w.log.push(`sync ${d.name}${s.fault ? ` fault@${s.fault.at}:${s.fault.kind}` : ""}`);
    if (s.fault) {
      if (s.fault.kind === "kill") w.gh.faultAt(s.fault.at, () => { coverage.kills++; d.sw.kill(); });
      else if (s.fault.kind === "race") {
        const other = w.devs[s.dev === 0 ? 1 : 0];
        w.gh.faultAt(s.fault.at, () => {
          d.interleave.run = async () => {
            coverage.races++;
            try { await runSync(other.deps()); other.renames = []; } catch { /* the other device may fail too */ }
          };
        });
      } else w.gh.faultAt(s.fault.at, s.fault.kind);
    }
    try {
      const r = await runSync(d.deps());
      d.renames = [];
      coverage.merged += r.merged;
      coverage.conflicts += r.conflicts;
      if (r.attempts > 1) coverage.retriedPushes++;
    } catch (e) {
      coverage.failedSyncs++;
      w.log.push(`  → failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      d.sw.revive();
      d.interleave.run = null;
      w.gh.clearFaults();
    }
    return;
  }

  const path = s.t === "binary" || s.t === "binaryDelete" ? BIN_FILES[s.file] : TEXT_FILES[s.file];
  const exists = d.has(path);
  const newToken = () => `tok${w.tokenCounter++}-${d.name}`;

  switch (s.t) {
    case "create": {
      if (exists) return;
      // Several lines so later edits on different lines have unchanged context between them.
      const content = [newToken(), newToken(), newToken(), newToken(), newToken(), newToken()].join("\n") + "\n";
      await d.vault.writeBytes(mkPath(path), enc(content));
      d.lastWritten.set(path, content);
      w.userCreatedPaths.add(path);
      w.userRemovedPaths.delete(path);
      w.log.push(`${d.name} create ${path}`);
      break;
    }
    case "append": {
      if (!exists) return;
      const content = d.read(path) + newToken() + "\n";
      await d.vault.writeBytes(mkPath(path), enc(content));
      d.lastWritten.set(path, content);
      w.log.push(`${d.name} append ${path}`);
      break;
    }
    case "prepend": {
      if (!exists) return;
      const content = newToken() + "\n" + d.read(path);
      await d.vault.writeBytes(mkPath(path), enc(content));
      d.lastWritten.set(path, content);
      w.log.push(`${d.name} prepend ${path}`);
      break;
    }
    case "replace": {
      if (!exists) return;
      const lines = d.read(path).split("\n");
      const candidates = lines.filter(l => l !== "");
      if (candidates.length === 0) return;
      const idx = s.line % candidates.length;
      const old = candidates[idx];
      const replacement = newToken();
      const content = lines.map(l => (l === old ? replacement : l)).join("\n");
      await d.vault.writeBytes(mkPath(path), enc(content));
      d.lastWritten.set(path, content);
      w.removedByUser.add(old);
      w.log.push(`${d.name} replace ${path} line ${idx}`);
      break;
    }
    case "delete": {
      if (!exists) return;
      for (const l of d.read(path).split("\n")) if (l) w.removedByUser.add(l);
      await d.vault.deleteFile(mkPath(path));
      d.lastWritten.delete(path);
      w.userRemovedPaths.add(path);
      w.log.push(`${d.name} delete ${path}`);
      break;
    }
    case "rename": {
      const to = TEXT_FILES[s.to];
      if (!exists || to === path || d.has(to)) return;
      await d.vault.renameFile(mkPath(path), mkPath(to));
      d.renames.push({ from: mkPath(path), to: mkPath(to) });
      const content = d.lastWritten.get(path);
      d.lastWritten.delete(path);
      if (content !== undefined) d.lastWritten.set(to, content);
      w.userRemovedPaths.add(path);
      w.userCreatedPaths.add(to);
      w.userRemovedPaths.delete(to);
      coverage.renames++;
      w.log.push(`${d.name} rename ${path} → ${to}`);
      break;
    }
    case "binary": {
      const bytes = new Uint8Array(8);
      for (let i = 0; i < 8; i++) bytes[i] = (s.seed * 31 + i * 17 + w.tokenCounter) & 0xff;
      bytes[0] = 0; // keep it unmistakably binary
      w.tokenCounter++;
      if (exists) w.supersededBinary.add(key(d.vault.snapshot().get(path)!));
      await d.vault.writeBytes(mkPath(path), bytes);
      d.lastWritten.set(path, bytes);
      w.binaryVersions.push(key(bytes));
      w.userCreatedPaths.add(path);
      if (!w.binaryDeletedAt.get(path)?.has(key(bytes))) w.userRemovedPaths.delete(path);
      w.log.push(`${d.name} binary ${path}`);
      break;
    }
    case "binaryDelete": {
      if (!exists) return;
      const seen = key(d.vault.snapshot().get(path)!);
      w.supersededBinary.add(seen);
      w.binaryDeletedAt.set(path, (w.binaryDeletedAt.get(path) ?? new Set()).add(seen));
      await d.vault.deleteFile(mkPath(path));
      d.lastWritten.delete(path);
      w.userRemovedPaths.add(path);
      w.log.push(`${d.name} delete ${path}`);
      break;
    }
  }
}

export async function settle(w: World): Promise<void> {
  for (let round = 0; round < 8; round++) {
    let quiet = true;
    for (const d of w.devs) {
      const r = await manualSync(d);
      d.renames = [];
      coverage.merged += r.merged;
      coverage.conflicts += r.conflicts;
      if (r.attempts > 1) coverage.retriedPushes++;
      if (r.status !== "noop") quiet = false;
      if (r.errors.length) throw new Error(`errors after storm: ${JSON.stringify(r.errors)}\n${w.log.join("\n")}`);
    }
    if (quiet) return;
  }
  throw new Error(`did not converge\n${w.log.join("\n")}`);
}

export function checkInvariants(w: World, remote: Map<string, Uint8Array>): void {
  const [a, b] = w.devs;
  const sa = a.snapshot();
  const sb = b.snapshot();
  remote.delete(".gitkeep");
  const ctx = () => "\n" + w.log.join("\n");

  // 1. Convergence.
  expect([...sa.keys()].sort(), "A vs B paths" + ctx()).toEqual([...sb.keys()].sort());
  expect([...sa.keys()].sort(), "A vs remote paths" + ctx()).toEqual([...remote.keys()].sort());
  for (const [p, bytes] of sa) {
    expect(sb.get(p), `A vs B content of ${p}` + ctx()).toEqual(bytes);
    expect(remote.get(p), `A vs remote content of ${p}` + ctx()).toEqual(bytes);
  }

  const everything = [...sa.values()].filter(bts => bts.byteLength === 0 || bts[0] !== 0).map(bts => text(bts)!).join("\n");
  const binaryKeys = new Set([...sa.values()].filter(bts => bts.byteLength > 0 && bts[0] === 0).map(key));

  // 2. No edit lost.
  for (const d of w.devs) {
    for (const [path, content] of d.lastWritten) {
      if (typeof content !== "string") {
        const k = key(content);
        if (!w.supersededBinary.has(k) && !w.userRemovedPaths.has(path)) {
          expect(binaryKeys.has(k), `${d.name}'s binary write to ${path} vanished` + ctx()).toBe(true);
        }
        continue;
      }
      for (const line of content.split("\n")) {
        if (!line || w.removedByUser.has(line)) continue;
        expect(everything.includes(line), `${d.name}'s token "${line}" (in ${path}) was lost` + ctx()).toBe(true);
      }
    }
  }

  // 3. Binary integrity.
  for (const k of binaryKeys) {
    expect(w.binaryVersions.includes(k), `binary content ${k} was never written by a user` + ctx()).toBe(true);
  }

  // 4. Nothing deleted without a user deletion.
  for (const p of w.userCreatedPaths) {
    if (w.userRemovedPaths.has(p)) continue;
    expect(sa.has(p), `${p} disappeared although no user deleted it` + ctx()).toBe(true);
  }
}


export function newWorld(viaAdapter = false): World {
  const gh = new FakeGitHub();
  return {
    gh, devs: [new Device(gh, "A", viaAdapter), new Device(gh, "B", viaAdapter)], tokenCounter: 0,
    removedByUser: new Set(), userRemovedPaths: new Set(), userCreatedPaths: new Set(),
    binaryVersions: [], supersededBinary: new Set(), binaryDeletedAt: new Map(), renameLog: [], log: [],
  };
}

/** Run a whole scenario: steps, settle, invariants. */
export async function runScenario(steps: Step[], opts: { viaAdapter?: boolean } = {}): Promise<World> {
  const w = newWorld(opts.viaAdapter);
  for (const s of steps) await applyStep(w, s);
  await settle(w);
  checkInvariants(w, await w.gh.snapshotFiles(REPO, BRANCH));
  return w;
}
