// Config-folder allow-list (§7). Opt-in: nothing under the config dir is synced
// unless the user turns config sync on, and then only these categories:
//
//   appearance        appearance.json, themes/<name>/{theme.css,manifest.json}, snippets/*.css
//   hotkeys           hotkeys.json
//   coreSettings      every other top-level *.json (app.json, core-plugins.json, graph.json,
//                     daily-notes.json, templates.json, …) — workspace*.json never (always excluded)
//   communityPlugins  community-plugins.json, plugins/<id>/{main.js,manifest.json,styles.css}
//   pluginData        plugins/<id>/data.json, per plugin id only (they often hold secrets)
//
// excludedPlugins (per device) removes plugins/<id>/ entirely, e.g. a desktop-only plugin.
// Paths here are relative to the config dir ("plugins/x/main.js").

export interface ConfigSyncOptions {
  appearance: boolean;
  hotkeys: boolean;
  coreSettings: boolean;
  communityPlugins: boolean;
  pluginData: readonly string[];
  excludedPlugins: readonly string[];
}

const PLUGIN_CODE = new Set(["main.js", "manifest.json", "styles.css"]);
const THEME_FILES = new Set(["theme.css", "manifest.json"]);

/** May this path inside the config dir be synced? `isDir` asks whether a walk should descend into it. */
export function configAllowed(rel: string, isDir: boolean, o: ConfigSyncOptions): boolean {
  if (rel === "") return true;
  const seg = rel.split("/");
  if (seg.some(s => s === "" || s === "." || s === "..")) return false;

  if (isDir) {
    if (seg[0] === "themes" || seg[0] === "snippets") return o.appearance && (seg[0] === "themes" ? seg.length <= 2 : seg.length === 1);
    if (seg[0] === "plugins") {
      if (seg.length === 1) return o.communityPlugins || o.pluginData.length > 0;
      if (seg.length === 2) return pluginVisible(seg[1], o) && (o.communityPlugins || o.pluginData.includes(seg[1]));
    }
    return false;
  }

  if (seg.length === 1) {
    const name = seg[0];
    if (!name.endsWith(".json") || /^workspace.*\.json$/.test(name)) return false;
    if (name === "appearance.json") return o.appearance;
    if (name === "hotkeys.json") return o.hotkeys;
    if (name === "community-plugins.json") return o.communityPlugins;
    return o.coreSettings;
  }
  if (seg[0] === "snippets" && seg.length === 2) return o.appearance && seg[1].endsWith(".css");
  if (seg[0] === "themes" && seg.length === 3) return o.appearance && THEME_FILES.has(seg[2]);
  if (seg[0] === "plugins" && seg.length === 3) {
    const [, id, file] = seg;
    if (!pluginVisible(id, o)) return false;
    if (PLUGIN_CODE.has(file)) return o.communityPlugins;
    if (file === "data.json") return o.pluginData.includes(id);
  }
  return false;
}

function pluginVisible(id: string, o: ConfigSyncOptions): boolean {
  return !o.excludedPlugins.includes(id);
}
