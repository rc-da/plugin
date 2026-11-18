import { describe, it, expect } from "vitest";
import {
  normalizePath, caseKey, parentDir, baseName, joinPath, ancestorDirs,
  isAlwaysExcluded, buildExcluder, validatePath, findCaseCollisions,
} from "../src/core/paths";
import { P } from "./helpers";

const cfg = { configDir: ".obsidian", pluginId: "vault-github-sync" };

describe("normalizePath", () => {
  it("converts backslashes and strips leading ./ and /", () => {
    expect(normalizePath(".\\notes\\a.md")).toBe("notes/a.md");
    expect(normalizePath("/notes//a.md/")).toBe("notes/a.md");
  });

  it("normalizes to NFC so NFD (macOS/iOS) and NFC spellings compare equal", () => {
    const nfd = "Café.md"; // e + combining acute
    const nfc = "Café.md";
    expect(nfd).not.toBe(nfc);
    expect(normalizePath(nfd)).toBe(normalizePath(nfc));
  });

  it("caseKey folds case", () => {
    expect(caseKey("Notes/A.md")).toBe(caseKey("notes/a.md"));
  });

  it("path helpers", () => {
    expect(parentDir("a/b/c.md")).toBe("a/b");
    expect(parentDir("c.md")).toBeNull();
    expect(baseName("a/b/c.md")).toBe("c.md");
    expect(joinPath("", "x.md")).toBe("x.md");
    expect(joinPath("a", "x.md")).toBe("a/x.md");
    expect(ancestorDirs("a/b/c.md")).toEqual(["a/b", "a"]);
    expect(ancestorDirs("c.md")).toEqual([]);
  });
});

describe("isAlwaysExcluded", () => {
  it.each([
    ".git/config",
    "sub/.git/HEAD",
    ".trash/old.md",
    ".DS_Store",
    "notes/Thumbs.db",
    "img/desktop.ini",
    ".obsidian/plugins/vault-github-sync/data.json",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/cache",
    ".obsidian/cache/x",
    ".gitkeep",
  ])("excludes %s", p => {
    expect(isAlwaysExcluded(p, cfg)).toBe(true);
  });

  it.each([
    "notes/a.md",
    ".gitignore",
    ".obsidian/app.json",
    ".obsidian/plugins/other-plugin/data.json",
    "workspace.json",          // only inside the config dir
    "my.git.notes/a.md",       // not literally ".git"
    "sub/.gitkeep",            // only the root placeholder is special
  ])("keeps %s", p => {
    expect(isAlwaysExcluded(p, cfg)).toBe(false);
  });

  it("respects a custom configDir", () => {
    expect(isAlwaysExcluded("cfg/workspace.json", { ...cfg, configDir: "cfg" })).toBe(true);
    expect(isAlwaysExcluded(".obsidian/workspace.json", { ...cfg, configDir: "cfg" })).toBe(false);
  });
});

describe("buildExcluder", () => {
  it("excludes the config dir wholesale unless included", () => {
    expect(buildExcluder(cfg)(P(".obsidian/app.json"))).toBe(true);
    expect(buildExcluder({ ...cfg, includeConfigDir: true })(P(".obsidian/app.json"))).toBe(false);
  });

  it("applies gitignore semantics, including directory patterns and negation", () => {
    const ex = buildExcluder({ ...cfg, gitignoreText: "build/\n*.log\n!keep.log\n" });
    expect(ex(P("build/out.md"))).toBe(true);
    expect(ex(P("deep/build/out.md"))).toBe(true);
    expect(ex(P("a.log"))).toBe(true);
    expect(ex(P("keep.log"))).toBe(false);
    expect(ex(P("notes/a.md"))).toBe(false);
  });

  it("applies user patterns on top of gitignore", () => {
    const ex = buildExcluder({ ...cfg, userPatterns: ["Private/", "*.tmp"] });
    expect(ex(P("Private/secret.md"))).toBe(true);
    expect(ex(P("x.tmp"))).toBe(true);
    expect(ex(P("Public/a.md"))).toBe(false);
  });

  it("user patterns cannot un-exclude hard rules", () => {
    const ex = buildExcluder({ ...cfg, userPatterns: ["!.git/", "!.DS_Store"] });
    expect(ex(P(".git/config"))).toBe(true);
    expect(ex(P(".DS_Store"))).toBe(true);
  });
});

describe("validatePath", () => {
  it("accepts ordinary names on both platforms", () => {
    for (const platform of ["windows", "posix"] as const) {
      expect(validatePath("notes/日本語 (draft) #1.md", platform).ok).toBe(true);
      expect(validatePath(".obsidian/app.json", platform).ok).toBe(true);
    }
  });

  it.each(["a*.md", 'say "hi".md', "a\\b.md", "x<y.md", "x>y.md", "time: 10.md", "a|b.md", "why?.md"])(
    "rejects Obsidian-forbidden character in %s everywhere",
    p => {
      expect(validatePath(p, "posix").ok).toBe(false);
      expect(validatePath(p, "windows").ok).toBe(false);
    },
  );

  it("rejects Windows reserved names and trailing dot/space only on windows", () => {
    for (const p of ["CON", "con.md", "notes/NUL.txt", "COM1.md", "LPT9", "trailing.", "trailing "]) {
      expect(validatePath(p, "windows").ok).toBe(false);
      expect(validatePath(p, "posix").ok).toBe(true);
    }
    expect(validatePath("CONTROL.md", "windows").ok).toBe(true);
    expect(validatePath("COM10.md", "windows").ok).toBe(true);
  });

  it("rejects over-long segments (255 bytes), measured in bytes", () => {
    expect(validatePath("a".repeat(255) + ".md", "posix").ok).toBe(false);
    expect(validatePath("a".repeat(251) + ".md", "posix").ok).toBe(true);
    // 100 × 3-byte chars = 300 bytes but only 100 chars
    expect(validatePath("日".repeat(100), "posix").ok).toBe(false);
  });

  it("rejects control characters, empty and dot segments", () => {
    expect(validatePath("a\u0000b.md", "posix").ok).toBe(false);
    expect(validatePath("a\nb.md", "posix").ok).toBe(false);
    expect(validatePath("", "posix").ok).toBe(false);
    expect(validatePath("a/../b.md", "posix").ok).toBe(false);
    expect(validatePath("a//b.md", "posix").ok).toBe(false);
  });
});

describe("findCaseCollisions", () => {
  it("groups paths that differ only in case", () => {
    const groups = findCaseCollisions(["Notes/A.md", "notes/a.md", "other.md", "README.md", "readme.md"]);
    expect(groups.size).toBe(2);
    expect(groups.get("notes/a.md")).toEqual(["Notes/A.md", "notes/a.md"]);
  });

  it("returns empty when there are none", () => {
    expect(findCaseCollisions(["a.md", "b.md"]).size).toBe(0);
  });
});
