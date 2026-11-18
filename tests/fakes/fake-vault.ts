import type { VaultPort, VaultFile } from "../../src/core/ports";
import type { Path } from "../../src/core/types";
import { mkPath } from "../../src/core/types";
import type { KillSwitch } from "./kill-switch";

export interface FakeVaultOptions {
  caseInsensitive?: boolean;
  nfdNames?: boolean;
  failOn?: Set<string>;
  killSwitch?: KillSwitch;
}

export class FakeVault implements VaultPort {
  private files = new Map<string, { path: string; data: Uint8Array; mtime: number }>();
  private clock = 1000;
  private opts: FakeVaultOptions;

  constructor(opts: FakeVaultOptions = {}) {
    this.opts = opts;
  }

  private key(path: string): string {
    return this.opts.caseInsensitive ? path.toLowerCase() : path;
  }

  private mayFail(path: string) {
    this.opts.killSwitch?.check("vault op on " + path);
    if (this.opts.failOn?.has(path)) {
      throw new Error(`FakeVault: injected failure for ${path}`);
    }
  }

  /** Seed the vault with a file (for test setup). */
  seed(path: string, content: string | Uint8Array, mtime?: number): void {
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.files.set(this.key(path), { path, data, mtime: mtime ?? this.clock++ });
  }

  /** Advance the fake clock (useful for mtime-based tests). */
  tick(): number { return this.clock++; }

  async listFiles(): Promise<VaultFile[]> {
    this.opts.killSwitch?.check("listFiles");
    const result: VaultFile[] = [];
    for (const { path, data, mtime } of this.files.values()) {
      result.push({ path: mkPath(path), mtime, size: data.byteLength });
    }
    return result;
  }

  async readBytes(path: Path): Promise<Uint8Array> {
    this.mayFail(path);
    const entry = this.files.get(this.key(path));
    if (!entry) throw new Error(`FakeVault: file not found: ${path}`);
    return entry.data;
  }

  async writeBytes(path: Path, data: Uint8Array): Promise<void> {
    this.mayFail(path);
    const existing = this.files.get(this.key(path));
    // Keep the existing on-disk spelling when overwriting on a case-insensitive FS.
    this.files.set(this.key(path), { path: existing?.path ?? path, data, mtime: this.clock++ });
  }

  async deleteFile(path: Path): Promise<void> {
    this.mayFail(path);
    this.files.delete(this.key(path));
  }

  async renameFile(oldPath: Path, newPath: Path): Promise<void> {
    this.mayFail(oldPath);
    const entry = this.files.get(this.key(oldPath));
    if (!entry) throw new Error(`FakeVault: rename source not found: ${oldPath}`);
    this.files.delete(this.key(oldPath));
    this.files.set(this.key(newPath), { path: newPath, data: entry.data, mtime: this.clock++ });
  }

  async removeFolderIfEmpty(_path: Path): Promise<void> {
    // In-memory — no real folders to remove.
  }

  async fileExists(path: Path): Promise<boolean> {
    this.opts.killSwitch?.check("fileExists");
    return this.files.has(this.key(path));
  }

  async stat(path: Path): Promise<{ mtime: number; size: number } | null> {
    this.opts.killSwitch?.check("stat");
    const entry = this.files.get(this.key(path));
    if (!entry) return null;
    return { mtime: entry.mtime, size: entry.data.byteLength };
  }

  /** Dump all file contents (for assertions). */
  snapshot(): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const v of this.files.values()) out.set(v.path, v.data);
    return out;
  }
}
