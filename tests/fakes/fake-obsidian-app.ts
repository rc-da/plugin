import type { App } from "obsidian";

// In-memory stand-in for the slice of Obsidian's App the vault adapter uses
// (Vault, DataAdapter, FileManager), following the semantics documented in
// obsidian.d.ts: createBinary/createFolder throw if the target exists, the vault
// index hides dot-paths, trashFile moves to .trash/.
//
// `nfd: true` stores names the way iOS/macOS may report them (NFD).

interface Entry { data: Uint8Array; mtime: number }

export class FakeObsidianApp {
  readonly disk = new Map<string, Entry>();
  readonly folders = new Set<string>();
  readonly calls: string[] = [];
  private clock = 1000;

  constructor(private readonly opts: { nfd?: boolean } = {}) {}

  /** Seed a file on disk (folders created implicitly). */
  seed(path: string, content: string | Uint8Array) {
    const p = this.opts.nfd ? path.normalize("NFD") : path;
    this.mkdirs(parent(p));
    this.disk.set(p, { data: typeof content === "string" ? new TextEncoder().encode(content) : content, mtime: this.clock++ });
  }

  read(path: string): string | undefined {
    const e = this.disk.get(path) ?? this.disk.get(path.normalize("NFD"));
    return e ? new TextDecoder().decode(e.data) : undefined;
  }

  get app(): App {
    return this as unknown as App;
  }

  private mkdirs(p: string) {
    while (p) { this.folders.add(p); p = parent(p); }
  }

  private tfile(path: string) {
    const e = this.disk.get(path);
    return e ? { path, name: path.split("/").pop(), stat: { mtime: e.mtime, size: e.data.byteLength, ctime: 0 } } : null;
  }

  private hidden(p: string) { return p.split("/").some(s => s.startsWith(".")); }

  private write(p: string, data: ArrayBuffer) {
    this.mkdirs(parent(p));
    this.disk.set(p, { data: new Uint8Array(data.slice(0)), mtime: this.clock++ });
  }

  vault = {
    getFiles: () => [...this.disk.keys()].filter(p => !this.hidden(p)).map(p => this.tfile(p)!),
    getFileByPath: (p: string) => (this.hidden(p) ? null : this.tfile(p)),
    getFolderByPath: (p: string) => (this.folders.has(p) && !this.hidden(p) ? { path: p } : null),
    readBinary: async (f: { path: string }) => { this.calls.push(`vault.readBinary ${f.path}`); return this.disk.get(f.path)!.data.slice().buffer; },
    modifyBinary: async (f: { path: string }, data: ArrayBuffer) => { this.calls.push(`vault.modifyBinary ${f.path}`); this.write(f.path, data); },
    createBinary: async (p: string, data: ArrayBuffer) => {
      this.calls.push(`vault.createBinary ${p}`);
      if (this.disk.has(p)) throw new Error("File already exists.");
      if (!this.folders.has(parent(p)) && parent(p) !== "") throw new Error("parent folder missing");
      this.write(p, data);
      return this.tfile(p);
    },
    createFolder: async (p: string) => {
      this.calls.push(`vault.createFolder ${p}`);
      if (this.folders.has(p)) throw new Error("Folder already exists.");
      if (parent(p) !== "" && !this.folders.has(parent(p))) throw new Error("parent folder missing");
      this.folders.add(p);
    },
    delete: async (f: { path: string }) => {
      this.calls.push(`vault.delete ${f.path}`);
      this.disk.delete(f.path);
      this.folders.delete(f.path);
    },
    rename: async (f: { path: string }, to: string) => {
      this.calls.push(`vault.rename ${f.path} -> ${to}`);
      if (this.disk.has(to)) throw new Error("Destination file already exists!");
      const e = this.disk.get(f.path)!;
      this.disk.delete(f.path);
      this.mkdirs(parent(to));
      this.disk.set(to, e);
    },
    adapter: {
      exists: async (p: string) => this.disk.has(p) || this.folders.has(p),
      stat: async (p: string) => {
        const e = this.disk.get(p);
        if (e) return { type: "file", mtime: e.mtime, size: e.data.byteLength, ctime: 0 };
        return this.folders.has(p) ? { type: "folder", mtime: 0, size: 0, ctime: 0 } : null;
      },
      list: async (p: string) => {
        if (!this.folders.has(p)) throw new Error("ENOENT");
        const direct = (x: string) => parent(x) === p;
        return { files: [...this.disk.keys()].filter(direct), folders: [...this.folders].filter(direct) };
      },
      readBinary: async (p: string) => {
        this.calls.push(`adapter.readBinary ${p}`);
        const e = this.disk.get(p);
        if (!e) throw new Error("ENOENT");
        return e.data.slice().buffer;
      },
      writeBinary: async (p: string, data: ArrayBuffer) => { this.calls.push(`adapter.writeBinary ${p}`); this.write(p, data); },
      remove: async (p: string) => { this.calls.push(`adapter.remove ${p}`); this.disk.delete(p); },
      rename: async (from: string, to: string) => {
        this.calls.push(`adapter.rename ${from} -> ${to}`);
        const e = this.disk.get(from);
        if (!e) throw new Error("ENOENT");
        this.disk.delete(from);
        this.mkdirs(parent(to));
        this.disk.set(to, e);
      },
      mkdir: async (p: string) => { this.calls.push(`adapter.mkdir ${p}`); this.mkdirs(p); },
      rmdir: async (p: string) => { this.calls.push(`adapter.rmdir ${p}`); this.folders.delete(p); },
    },
  };

  fileManager = {
    trashFile: async (f: { path: string }) => {
      this.calls.push(`fileManager.trashFile ${f.path}`);
      const e = this.disk.get(f.path)!;
      this.disk.delete(f.path);
      this.mkdirs(".trash");
      this.disk.set(`.trash/${f.path.split("/").pop()}`, e);
    },
    renameFile: async () => { throw new Error("fileManager.renameFile must not be used for synced renames"); },
  };
}

function parent(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
