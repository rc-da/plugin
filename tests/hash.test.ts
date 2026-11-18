import { describe, it, expect } from "vitest";
import { gitBlobSha, bytesEqual, toHex } from "../src/core/hash";
import { gitBlobShaSync } from "./fakes/fake-github";

const enc = (s: string) => new TextEncoder().encode(s);

describe("gitBlobSha", () => {
  it("matches git's known empty-blob id", async () => {
    // `git hash-object -t blob /dev/null`
    expect(await gitBlobSha(new Uint8Array(0))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("matches git for 'hello world\\n'", async () => {
    // `printf 'hello world\n' | git hash-object --stdin`
    expect(await gitBlobSha(enc("hello world\n"))).toBe("3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
  });

  it("hashes raw bytes: CRLF and LF differ", async () => {
    expect(await gitBlobSha(enc("a\r\nb"))).not.toBe(await gitBlobSha(enc("a\nb")));
  });

  it("agrees with the test fake's synchronous implementation on binary data", async () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
    expect(await gitBlobSha(bytes)).toBe(gitBlobShaSync(bytes));
  });

  it("handles multi-byte UTF-8 by byte length, not string length", async () => {
    const s = "héllo 🌍";
    const bytes = enc(s);
    expect(bytes.byteLength).not.toBe(s.length);
    expect(await gitBlobSha(bytes)).toBe(gitBlobShaSync(bytes));
  });
});

describe("helpers", () => {
  it("toHex pads", () => {
    expect(toHex(new Uint8Array([0, 1, 255]))).toBe("0001ff");
  });

  it("bytesEqual compares content", () => {
    expect(bytesEqual(enc("ab"), enc("ab"))).toBe(true);
    expect(bytesEqual(enc("ab"), enc("ac"))).toBe(false);
    expect(bytesEqual(enc("ab"), enc("abc"))).toBe(false);
  });
});
