import type { VaultPort } from "./ports";
import type { ConflictRecord } from "./types";
import { gitBlobSha } from "./hash";
import { decodeUtf8, encodeUtf8, isTextFile } from "./merge";

// Resolving a recorded conflict (§5.5). The local version stays at `path`, the remote
// version sits next to it at `conflictPath`. Both were pushed, so both are also in
// the repo history, but we still never discard anything the user changed after the
// conflict was recorded: such a resolution is refused with a reason.

export type ConflictChoice = "keepLocal" | "keepRemote" | "keepBoth" | "editManually";

export type ResolveOutcome =
  | { status: "resolved" }
  /** Nothing left to resolve (the copy is gone): drop the record. */
  | { status: "stale" }
  | { status: "refused"; reason: string };

export async function resolveConflict(vault: VaultPort, rec: ConflictRecord, choice: ConflictChoice): Promise<ResolveOutcome> {
  const hasCopy = await vault.fileExists(rec.conflictPath);
  const hasLocal = await vault.fileExists(rec.path);
  if (!hasCopy) return { status: "stale" };
  if (choice === "keepBoth") return { status: "resolved" };

  const copy = await vault.readBytes(rec.conflictPath);
  const copyEdited = (await gitBlobSha(copy)) !== rec.remoteSha;

  if (!hasLocal) {
    if (choice !== "keepRemote") return { status: "refused", reason: `${rec.path} no longer exists. Keep the other version, or keep both.` };
    await vault.renameFile(rec.conflictPath, rec.path);
    return { status: "resolved" };
  }

  const local = await vault.readBytes(rec.path);
  const localEdited = (await gitBlobSha(local)) !== rec.localSha;

  switch (choice) {
    case "keepLocal":
      if (copyEdited) return { status: "refused", reason: `${rec.conflictPath} was edited after the conflict. Keep both, or delete it yourself.` };
      await vault.deleteFile(rec.conflictPath);
      return { status: "resolved" };

    case "keepRemote":
      if (localEdited) return { status: "refused", reason: `${rec.path} was edited after the conflict. Keep both, or edit manually.` };
      await vault.writeBytes(rec.path, copy);
      await vault.deleteFile(rec.conflictPath);
      return { status: "resolved" };

    case "editManually": {
      if (!isTextFile(rec.path, local) || !isTextFile(rec.conflictPath, copy)) {
        return { status: "refused", reason: "Only text files can be edited manually." };
      }
      // Markers only on explicit request (§5.5). Nothing is lost: both versions end up in the file.
      const merged = withConflictMarkers(decodeUtf8(local), decodeUtf8(copy), rec.conflictPath);
      await vault.writeBytes(rec.path, encodeUtf8(merged));
      await vault.deleteFile(rec.conflictPath);
      return { status: "resolved" };
    }
  }
}

/**
 * Two-way markers around the differing middle: common leading and trailing lines
 * stay as they are, so the user only has to look at the part that differs.
 */
export function withConflictMarkers(local: string, remote: string, otherLabel: string): string {
  if (local === remote) return local;
  const a = local.split("\n");
  const b = remote.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const mid = (x: string[]) => x.slice(pre, x.length - suf);
  return [
    ...a.slice(0, pre),
    "<<<<<<< this device",
    ...mid(a),
    "=======",
    ...mid(b),
    `>>>>>>> ${otherLabel}`,
    ...a.slice(a.length - suf),
  ].join("\n");
}

/** Records whose conflict copy no longer exists (handled outside the modal). */
export async function staleConflicts(vault: VaultPort, records: ConflictRecord[]): Promise<ConflictRecord[]> {
  const out: ConflictRecord[] = [];
  for (const r of records) if (!(await vault.fileExists(r.conflictPath))) out.push(r);
  return out;
}

export function sameConflict(a: ConflictRecord, b: ConflictRecord): boolean {
  return a.path === b.path && a.conflictPath === b.conflictPath;
}
