import type { Sha } from "./types";
import { mkSha } from "./types";

// Git blob object id: sha1("blob <byteLength>\0" + bytes).
// Uses Web Crypto (crypto.subtle), which exists in Obsidian's WebView on every
// platform and in Node >= 19 — no Node "crypto" module, no Buffer.
// Source: https://git-scm.com/book/en/v2/Git-Internals-Git-Objects

const encoder = new TextEncoder();

export async function gitBlobSha(bytes: Uint8Array): Promise<Sha> {
  const header = encoder.encode(`blob ${bytes.byteLength}\0`);
  // One concatenation copy is unavoidable with a single-shot digest; callers
  // must still make sure only one large file is in memory at a time (§2).
  const buf = new Uint8Array(header.byteLength + bytes.byteLength);
  buf.set(header, 0);
  buf.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return mkSha(toHex(new Uint8Array(digest)));
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
