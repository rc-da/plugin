import type { RemotePort, StatePort } from "./ports";

// Cheap remote check for the interval trigger (§5.1): a conditional GET of the ref.
// A 304 costs no rate limit, so polling every few minutes is free.
//
// The question asked is "is the remote head different from what we last fully
// synced?" (baseline.remoteHead), never "did the ETag change?". The ETag is stored
// together with the head it belongs to; if a poll sees a new head and the sync that
// follows fails, the next poll's 304 still maps to that unsynced head, so the change
// is never skipped.

export type RemoteCheck = "changed" | "unchanged";

export async function checkRemote(remote: RemotePort, state: StatePort, repo: string, branch: string): Promise<RemoteCheck> {
  const baseline = await state.loadBaseline(repo, branch);
  // No (matching) baseline or a partial last sync: only a full sync can tell.
  if (!baseline || baseline.repo !== repo || baseline.branch !== branch || !baseline.remoteHead) return "changed";

  const prev = await state.loadRefPoll(repo, branch);
  const poll = await remote.getRefIfChanged(repo, branch, prev?.etag ?? "");
  let head;
  if (poll.status === "unchanged") {
    if (!prev) return "changed"; // cannot happen without an ETag; be safe
    head = prev.sha;
  } else if (poll.status === "missing") {
    return "changed"; // branch gone or repo emptied: let a sync (and its guards) look
  } else {
    await state.saveRefPoll(repo, branch, { sha: poll.sha, etag: poll.etag });
    head = poll.sha;
  }
  return head === baseline.remoteHead ? "unchanged" : "changed";
}
