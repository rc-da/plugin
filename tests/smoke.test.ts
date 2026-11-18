import { describe, it, expect } from "vitest";
import { FakeVault } from "./fakes/fake-vault";
import { FakeGitHub } from "./fakes/fake-github";
import { mkPath } from "../src/core/types";

describe("FakeVault", () => {
  it("reads back what was seeded", async () => {
    const vault = new FakeVault();
    vault.seed("notes/hello.md", "hello world");
    const bytes = await vault.readBytes(mkPath("notes/hello.md"));
    expect(new TextDecoder().decode(bytes)).toBe("hello world");
  });

  it("lists files", async () => {
    const vault = new FakeVault();
    vault.seed("a.md", "a");
    vault.seed("b.md", "b");
    const files = await vault.listFiles();
    expect(files.map(f => f.path).sort()).toEqual(["a.md", "b.md"]);
  });

  it("write then stat reflects new size", async () => {
    const vault = new FakeVault();
    vault.seed("x.md", "hi");
    await vault.writeBytes(mkPath("x.md"), new TextEncoder().encode("hello!"));
    const s = await vault.stat(mkPath("x.md"));
    expect(s?.size).toBe(6);
  });

  it("delete removes file", async () => {
    const vault = new FakeVault();
    vault.seed("del.md", "bye");
    await vault.deleteFile(mkPath("del.md"));
    expect(await vault.fileExists(mkPath("del.md"))).toBe(false);
  });

  it("rename moves file", async () => {
    const vault = new FakeVault();
    vault.seed("old.md", "content");
    await vault.renameFile(mkPath("old.md"), mkPath("new.md"));
    expect(await vault.fileExists(mkPath("old.md"))).toBe(false);
    expect(await vault.fileExists(mkPath("new.md"))).toBe(true);
  });
});

describe("FakeGitHub", () => {
  it("seedRef + getRef round-trips", async () => {
    const gh = new FakeGitHub();
    const treeSha = gh.seedTree({ "note.md": "hello" });
    const cSha = gh.seedCommit(treeSha, null, "init");
    gh.seedRef("owner/repo", "main", cSha);
    const ref = await gh.getRef("owner/repo", "main");
    expect(ref?.sha).toBe(cSha);
  });

  it("getRefIfChanged reports unchanged on matching etag (304)", async () => {
    const gh = new FakeGitHub();
    const treeSha = gh.seedTree({ "a.md": "a" });
    const cSha = gh.seedCommit(treeSha, null, "init");
    gh.seedRef("owner/repo", "main", cSha);
    const first = await gh.getRef("owner/repo", "main");
    const second = await gh.getRefIfChanged("owner/repo", "main", first!.etag);
    expect(second).toEqual({ status: "unchanged" });
  });

  it("getBlob returns seeded content", async () => {
    const gh = new FakeGitHub();
    const sha = gh.seedBlob("test content");
    const bytes = await gh.getBlob("owner/repo", sha);
    expect(new TextDecoder().decode(bytes)).toBe("test content");
  });

  it("postTree builds on base", async () => {
    const gh = new FakeGitHub();
    const baseSha = gh.seedTree({ "a.md": "a", "b.md": "b" });
    const newTreeSha = await gh.postTree("owner/repo", [
      { path: mkPath("c.md"), mode: "100644", content: "c" },
    ], baseSha);
    const tree = await gh.getTree("owner/repo", newTreeSha);
    const paths = tree.entries.map(e => e.name).sort();
    expect(paths).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("fault injection throws RateLimited", async () => {
    const gh = new FakeGitHub();
    gh.nextFault = "rateLimit";
    await expect(gh.getRef("owner/repo", "main")).rejects.toMatchObject({ kind: "RateLimited" });
  });

  it("bootstrapRepo creates a ref", async () => {
    const gh = new FakeGitHub();
    await gh.bootstrapRepo("owner/repo", "main");
    const ref = await gh.getRef("owner/repo", "main");
    expect(ref).not.toBeNull();
  });
});
