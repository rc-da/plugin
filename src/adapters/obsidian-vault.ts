import type { App, TFile } from "obsidian";
import type { VaultFile, VaultPort } from "../core/ports";
import type { Path } from "../core/types";
import { mkPath } from "../core/types";
import { LISTED_HIDDEN_FILES } from "../core/paths";

// VaultPort over Obsidian (§2). Normal notes go through app.vault so open editors
// refresh and the index stays right; dot-paths (configDir, .github/…) go through
// app.vault.adapter because the vault index does not see them.
// Typings: node_modules/obsidian/obsidian.d.ts (Vault, DataAdapter, FileManager).
//
// Paths: core keys are NFC (§9). iOS/macOS may store names as NFD, so this adapter
// remembers the on-disk spelling of every listed file and maps NFC keys back to it.

export interface ObsidianVaultOptions {
  /**
   * Vault-relative folders to list through the adapter (e.g. the config dir when
   * config sync is on). Evaluated on every listing so settings changes apply.
   */
  hiddenRoots?: () => string[];
  /** Folders a hidden walk must not descend into (the sync excluder), so excluded trees cost nothing. */
  skipDir?: (path: string) => boolean;
  /** Move deleted notes to the user's trash (default) instead of deleting outright. */
  useTrash?: boolean;
}

export class ObsidianVault implements VaultPort {
  /** NFC key → on-disk path, from the last listing and our own writes. */
  private readonly onDisk = new Map<string, string>();

  constructor(private readonly app: App, private readonly opts: ObsidianVaultOptions = {}) {}

  async listFiles(): Promise<VaultFile[]> {
    this.onDisk.clear();
    const out: VaultFile[] = [];
    for (const f of this.app.vault.getFiles()) {
      this.remember(f.path);
      out.push({ path: mkPath(f.path), mtime: f.stat.mtime, size: f.stat.size });
    }
    // Dot-files the excluder admits outside the config dir: list them so the scan
    // sees them (a file the scan cannot see would look deleted, BUG_HISTORY).
    for (const f of LISTED_HIDDEN_FILES) await this.walkHidden(f, out);
    for (const root of this.opts.hiddenRoots?.() ?? []) {
      await this.walkHidden(root.replace(/\/+$/, ""), out);
    }
    return out;
  }

  async readBytes(path: Path): Promise<Uint8Array> {
    const p = this.resolve(path);
    const file = this.indexed(p);
    const buf = file ? await this.app.vault.readBinary(file) : await this.app.vault.adapter.readBinary(p);
    return new Uint8Array(buf);
  }

  async writeBytes(path: Path, data: Uint8Array): Promise<void> {
    const p = this.resolve(path);
    const buf = toArrayBuffer(data);
    const file = this.indexed(p);
    if (file) {
      await this.app.vault.modifyBinary(file, buf); // open editors pick this up
      return;
    }
    await this.ensureFolder(parentOf(p));
    if (isHiddenPath(p)) {
      await this.app.vault.adapter.writeBinary(p, buf);
    } else {
      try {
        await this.app.vault.createBinary(p, buf);
      } catch (e) {
        // The file exists on disk but the index has not caught up (created by another
        // tool a moment ago). Overwrite through the adapter rather than failing.
        if (!(await this.app.vault.adapter.exists(p))) throw e;
        await this.app.vault.adapter.writeBinary(p, buf);
      }
    }
    this.remember(p);
  }

  async deleteFile(path: Path): Promise<void> {
    const p = this.resolve(path);
    const file = this.indexed(p);
    if (file) {
      // Respects the user's "deleted files" preference (Obsidian trash, system trash or delete).
      if (this.opts.useTrash ?? true) await this.app.fileManager.trashFile(file);
      else await this.app.vault.delete(file);
    } else if (await this.app.vault.adapter.exists(p)) {
      await this.app.vault.adapter.remove(p);
    }
    this.onDisk.delete(path.normalize("NFC"));
  }

  async renameFile(oldPath: Path, newPath: Path): Promise<void> {
    const from = this.resolve(oldPath);
    const to = this.resolve(newPath);
    await this.ensureFolder(parentOf(to));
    const file = this.indexed(from);
    // vault.rename, not fileManager.renameFile: the remote side already rewrote links,
    // rewriting them again here would produce local edits nobody made.
    if (file && !isHiddenPath(to)) await this.app.vault.rename(file, to);
    else await this.app.vault.adapter.rename(from, to);
    this.onDisk.delete(oldPath.normalize("NFC"));
    this.remember(to);
  }

  async removeFolderIfEmpty(path: Path): Promise<void> {
    const p = this.resolve(path);
    let listed;
    try {
      listed = await this.app.vault.adapter.list(p);
    } catch {
      return; // already gone
    }
    // adapter.list also shows hidden children the vault index hides, so "empty" is real.
    if (listed.files.length > 0 || listed.folders.length > 0) return;
    const folder = this.app.vault.getFolderByPath(p);
    if (folder) await this.app.vault.delete(folder);
    else await this.app.vault.adapter.rmdir(p, false);
  }

  async fileExists(path: Path): Promise<boolean> {
    const st = await this.app.vault.adapter.stat(this.resolve(path));
    return st !== null && st.type === "file";
  }

  async stat(path: Path): Promise<{ mtime: number; size: number } | null> {
    // Straight from disk (not the index), so the edited-during-sync guard sees the truth.
    const st = await this.app.vault.adapter.stat(this.resolve(path));
    if (!st || st.type !== "file") return null;
    return { mtime: st.mtime, size: st.size };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private remember(diskPath: string) {
    this.onDisk.set(diskPath.normalize("NFC"), diskPath);
  }

  private resolve(path: string): string {
    const known = this.onDisk.get(path.normalize("NFC"));
    if (known !== undefined) return known;
    // Unknown file (about to be created): keep the on-disk spelling of its folder, or
    // an NFD folder would get an NFC twin on normalization-sensitive filesystems.
    const i = path.lastIndexOf("/");
    return i < 0 ? path : `${this.resolveFolder(path.slice(0, i))}/${path.slice(i + 1)}`;
  }

  private indexed(p: string): TFile | null {
    return isHiddenPath(p) ? null : this.app.vault.getFileByPath(p);
  }

  /** List a hidden file, or a hidden folder recursively (skipping excluded subfolders). */
  private async walkHidden(folder: string, out: VaultFile[]): Promise<void> {
    const st = await this.app.vault.adapter.stat(folder);
    if (!st) return;
    if (st.type === "file") {
      this.remember(folder);
      out.push({ path: mkPath(folder), mtime: st.mtime, size: st.size });
      return;
    }
    let listed;
    try {
      listed = await this.app.vault.adapter.list(folder);
    } catch {
      return;
    }
    for (const f of listed.files) {
      const st = await this.app.vault.adapter.stat(f);
      if (!st || st.type !== "file") continue;
      this.remember(f);
      out.push({ path: mkPath(f), mtime: st.mtime, size: st.size });
    }
    for (const d of listed.folders) {
      if (!this.opts.skipDir?.(d)) await this.walkHidden(d, out);
    }
  }

  /** Create every missing folder level (vault.createFolder throws if one exists). */
  private async ensureFolder(folder: string): Promise<void> {
    if (folder === "") return;
    const real = this.resolveFolder(folder);
    if (await this.app.vault.adapter.exists(real)) return;
    await this.ensureFolder(parentOf(folder));
    if (isHiddenPath(folder)) await this.app.vault.adapter.mkdir(folder);
    else await this.app.vault.createFolder(folder);
  }

  /** On-disk spelling of a folder, derived from any remembered file inside it. */
  private resolveFolder(folder: string): string {
    const key = folder.normalize("NFC") + "/";
    const depth = folder.split("/").length;
    for (const [nfc, disk] of this.onDisk) {
      // NFC and NFD spellings differ in length, but never in segment count.
      if (nfc.startsWith(key)) return disk.split("/").slice(0, depth).join("/");
    }
    return folder;
  }
}

/** Any segment starting with "." (configDir, .github, …): invisible to the vault index. */
export function isHiddenPath(p: string): boolean {
  return p.split("/").some(seg => seg.startsWith("."));
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** Exactly the bytes of the view: a subarray's .buffer would carry its neighbours too. */
export function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer) return b.buffer;
  return b.slice().buffer as ArrayBuffer;
}
