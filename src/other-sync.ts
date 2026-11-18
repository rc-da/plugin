// Detect obvious signs that another sync tool manages this vault (§9). We do not
// try to coexist cleverly; settings just shows a warning.

export interface OtherSyncProbe {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string | null>;
  /** Absolute vault path on desktop, null on mobile. */
  basePath: string | null;
  configDir: string;
}

export async function detectOtherSyncTools(p: OtherSyncProbe): Promise<string[]> {
  const found: string[] = [];
  if (await p.exists(".stfolder")) found.push("Syncthing");
  if (p.basePath && /Mobile Documents|iCloud Drive|com~apple~CloudDocs/i.test(p.basePath)) found.push("iCloud");
  if (p.basePath && /[\\/](Dropbox|OneDrive|Google Drive)([\\/]|$)/i.test(p.basePath)) {
    found.push(/Dropbox/i.test(p.basePath) ? "Dropbox" : /OneDrive/i.test(p.basePath) ? "OneDrive" : "Google Drive");
  }
  if (await obsidianSyncEnabled(p)) found.push("Obsidian Sync");
  return found;
}

/** core-plugins.json is either ["sync", …] (older) or { "sync": true, … } (newer). */
async function obsidianSyncEnabled(p: OtherSyncProbe): Promise<boolean> {
  const raw = await p.read(`${p.configDir}/core-plugins.json`);
  if (!raw) return false;
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v)) return v.includes("sync");
    if (typeof v === "object" && v !== null) return (v as Record<string, unknown>).sync === true;
  } catch { /* unreadable: say nothing */ }
  return false;
}
