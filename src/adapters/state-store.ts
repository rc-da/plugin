import type { RefPollRecord, StatePort } from "../core/ports";
import type { Baseline, ConflictRecord, LocalCache } from "../core/types";
import { SyncError } from "../core/types";

// StatePort over IndexedDB (§4): per device, per vault, never in data.json and never
// inside the vault (the vault may itself travel via iCloud/Syncthing).
//
// Robustness rules:
// - Anything unreadable or of an unknown schema loads as "absent". A missing baseline
//   means first-sync mode, which never deletes (§5.6), so corruption is always safe.
// - Values are snapshotted on save: core keeps mutating the baseline after saving it.

const SCHEMA = 1;

export interface KvBackend {
  get(key: string): Promise<unknown>;
  /** Must store a snapshot (structured clone), not a live reference. */
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Envelope { v: number; data: unknown }

export class StateStore implements StatePort {
  constructor(private readonly kv: KvBackend) {}

  async loadBaseline(_repo: string, _branch: string): Promise<Baseline | null> {
    // Return whatever is stored even for another repo/branch: core detects the
    // mismatch and starts in first-sync mode (sync.ts), which is the safe reaction.
    const b = await this.read("baseline");
    return isBaseline(b) ? b : null;
  }
  saveBaseline(baseline: Baseline): Promise<void> { return this.write("baseline", baseline); }

  async loadLocalCache(): Promise<LocalCache> {
    const c = await this.read("cache");
    return isRecord(c) ? (c as LocalCache) : {};
  }
  saveLocalCache(cache: LocalCache): Promise<void> { return this.write("cache", cache); }

  async loadConflicts(): Promise<ConflictRecord[]> {
    const c = await this.read("conflicts");
    return Array.isArray(c) ? (c as ConflictRecord[]) : [];
  }
  saveConflicts(records: ConflictRecord[]): Promise<void> { return this.write("conflicts", records); }

  async loadRefPoll(repo: string, branch: string): Promise<RefPollRecord | null> {
    const e = await this.read(`poll:${repo}#${branch}`);
    return isRecord(e) && typeof e.sha === "string" && typeof e.etag === "string" ? (e as unknown as RefPollRecord) : null;
  }
  saveRefPoll(repo: string, branch: string, record: RefPollRecord): Promise<void> {
    return this.write(`poll:${repo}#${branch}`, record);
  }

  /** Forget everything (e.g. "reset sync state" in settings). Safe: degrades to first-sync mode. */
  async clear(): Promise<void> {
    for (const k of ["baseline", "cache", "conflicts"]) await this.kv.delete(k);
  }

  private async read(key: string): Promise<unknown> {
    let raw: unknown;
    try {
      raw = await this.kv.get(key);
    } catch {
      return undefined;
    }
    if (!isRecord(raw) || raw.v !== SCHEMA) return undefined;
    return raw.data;
  }

  private async write(key: string, data: unknown): Promise<void> {
    try {
      await this.kv.set(key, { v: SCHEMA, data } satisfies Envelope);
    } catch (e) {
      throw new SyncError("Unexpected", `Could not save sync state on this device (${e instanceof Error ? e.name : "storage error"}).`);
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isBaseline(v: unknown): v is Baseline {
  if (!isRecord(v)) return false;
  return typeof v.repo === "string" && typeof v.branch === "string"
    && (v.remoteHead === null || typeof v.remoteHead === "string")
    && isRecord(v.files) && isRecord(v.dirs);
}

/** In-memory backend (tests, and a fallback if IndexedDB is unavailable). */
export class MemoryKv implements KvBackend {
  private map = new Map<string, unknown>();
  async get(key: string) { return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined; }
  async set(key: string, value: unknown) { this.map.set(key, structuredClone(value)); }
  async delete(key: string) { this.map.delete(key); }
}

/**
 * IndexedDB backend: one database per vault instance, one "kv" object store.
 * IDB's put() structured-clones the value synchronously, which gives the snapshot
 * semantics KvBackend requires. Mobile OSes may close the connection while the app
 * is suspended, so a failed transaction reopens once and retries.
 */
export class IndexedDbKv implements KvBackend {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly name: string, private readonly idb: IDBFactory = indexedDB) {}

  get(key: string): Promise<unknown> {
    return this.run("readonly", store => store.get(key));
  }
  async set(key: string, value: unknown): Promise<void> {
    await this.run("readwrite", store => store.put(value, key));
  }
  async delete(key: string): Promise<void> {
    await this.run("readwrite", store => store.delete(key));
  }

  close() {
    void this.db?.then(db => db.close()).catch(() => {});
    this.db = null;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        const req = this.idb.open(this.name, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore("kv"); };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { db.close(); this.db = null; };
          db.onclose = () => { this.db = null; };
          resolve(db);
        };
        req.onerror = () => { this.db = null; reject(req.error ?? new Error("indexedDB.open failed")); };
        req.onblocked = () => { this.db = null; reject(new Error("indexedDB.open blocked")); };
      });
    }
    return this.db;
  }

  private async run(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<unknown> {
    try {
      return await this.once(mode, op);
    } catch {
      this.close(); // stale connection after suspend: reopen once
      return this.once(mode, op);
    }
  }

  private async once(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<unknown> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", mode);
      const req = op(tx.objectStore("kv"));
      let result: unknown;
      req.onsuccess = () => { result = req.result; };
      // Resolve on commit, not on request success, so a write is durable before we move on.
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error("transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
    });
  }
}

/**
 * Stable id for this vault on this device, kept in the vault-scoped localStorage
 * (App.loadLocalStorage/saveLocalStorage). Names the IndexedDB database, so two
 * vaults with the same name never share sync state.
 */
export function vaultInstanceId(
  load: (key: string) => unknown,
  save: (key: string, value: string) => void,
  random: () => number = Math.random,
): string {
  const KEY = "vault-github-sync:instance";
  const existing = load(KEY);
  if (typeof existing === "string" && existing.length > 0) return existing;
  const id = Array.from({ length: 16 }, () => Math.floor(random() * 36).toString(36)).join("");
  save(KEY, id);
  return id;
}
