# CLAUDE.md — Obsidian ↔ GitHub vault sync plugin

> - Plugin name: `Vault GitHub Sync`
> - Plugin id: `vault-github-sync` (lowercase, no "obsidian" in it — store rule)
> - GitHub repo of the plugin itself: https://github.com/rc-da/plugin

## 1. What we are building

An Obsidian community plugin that keeps a vault in sync with a GitHub repository
on **desktop and mobile (Android + iOS)** with **no git binary and no extra app**.
It talks to GitHub only through the REST / Git Data API.

It is a clean-room rewrite inspired by `heeeyman/ObsSync` ("Git Vault Sync").
Do not copy its code. Its bug log (`docs/BUG_HISTORY.md` there) is the reason for
many rules below.

### Goals (in priority order)
1. **Never lose user data.** Not a byte of a note, not an attachment, not an edit.
2. Same behaviour on every platform: one engine, one code path.
3. Fast incremental sync: cost scales with *what changed*, not vault size.
4. Edits on two devices to different parts of the same note merge automatically.
5. Works unattended (auto-sync) without ever blocking on a modal.
6. Clear, correct error messages.

### Non-goals (do not build unless asked)
- Local git history, branches-as-workflow, blame, log viewers.
- Git CLI / isomorphic-git / packfiles. **Do not add isomorphic-git.**
- Non-GitHub hosts (keep the HTTP layer swappable, but implement GitHub only).
- Git LFS.
- Multi-language UI (English only, but route all strings through `t()` so it's addable).

### What ObsSync got wrong that we must not repeat
| ObsSync problem | Our rule |
|---|---|
| Two engines (isomorphic-git desktop + API mobile) → double bug surface, feature gaps | **One engine** (GitHub API) everywhere |
| Mobile: any file touched on both sides = conflict | 3-way text merge (§5.4) |
| Re-hashes the whole vault every mobile sync | mtime+size cache, hash only suspects (§5.2) |
| One `POST /git/blobs` per file → secondary rate limit | Inline text in tree request, batch (§6) |
| Gives up on truncated trees ("repo too large") | Walk subtrees, skip unchanged ones (§5.3) |
| `403 rate limited` shown as "bad token", everything else "network error" | Typed errors (§6.3) |
| No retry/backoff | Retry policy (§6.4) |
| Token plaintext in `data.json` | Obsidian `SecretStorage` (§8) |
| `.obsidian/` never synced on mobile | Opt-in allow-list config sync (§7) |
| Binary corruption via UTF-8 round-trip | Bytes are `Uint8Array` end to end (§9) |
| Modal opened from closing modal → black screen | Modal rule (§10) |
| Obsidian layers untested | Pure core + fakes + property tests (§11) |

## 2. Hard platform constraints

- Runs inside Obsidian's WebView on mobile: **no Node APIs** (`fs`, `path`,
  `child_process`, `crypto` module, `Buffer` global), no Electron APIs.
  `manifest.json` → `"isDesktopOnly": false`.
- **All HTTP goes through Obsidian's `requestUrl`.** Plain `fetch` is CORS-blocked.
  `requestUrl` has **no timeout** — always wrap it (§6.4).
- File I/O through `app.vault` (for normal notes, so open editors refresh) and
  `app.vault.adapter` (for dotfiles / `.obsidian/`, which the vault index doesn't
  see). Never touch the filesystem any other way.
- SHA-1 via `crypto.subtle.digest` (Web Crypto). Fine on all platforms.
- Android WebView has a **fixed JS heap cap** independent of device RAM. Treat
  memory as scarce: never hold more than one large file in memory at a time.
- Mobile apps get suspended in the background: timers freeze, in-flight work can
  be killed at any moment. Every sync must be **resumable and idempotent**.
- `minAppVersion`: `1.11.4` (needed for `SecretStorage`). Check typings in
  `node_modules/obsidian/obsidian.d.ts` before using any API; don't guess.

## 3. Architecture

Keep the sync logic **pure and platform-free** so it can be unit-tested in Node.
Obsidian is just an adapter.

```
src/
  main.ts              Plugin entry: wiring, commands, ribbon, status bar, scheduler
  settings.ts          Settings type, defaults, migrations, settings tab
  core/                ← NO imports from "obsidian" in here. Ever.
    types.ts           Path, Sha, FileEntry, Baseline, SyncPlan, SyncResult, errors
    ports.ts           interfaces: VaultPort, RemotePort, StatePort, Clock, Logger
    hash.ts            git blob sha1 ("blob <len>\0" + bytes)
    paths.ts           normalize (NFC), exclude/gitignore matching, name validation
    scan.ts            local change detection using the mtime/size cache
    remote-diff.ts     remote tree walk + diff vs baseline
    plan.ts            build SyncPlan from local diff + remote diff + baseline
    merge.ts           3-way text merge (line-based diff3), binary detection
    apply.ts           execute pull side of plan (writes, deletes, conflict copies)
    push.ts            build trees/commit, update ref, handle non-fast-forward
    sync.ts            orchestrator: lock → scan → diff → plan → guard → apply → push → persist
    retry.ts           backoff, rate-limit waits, timeouts
  adapters/
    obsidian-vault.ts  VaultPort over app.vault / adapter
    github.ts          RemotePort over requestUrl + GitHub API
    state-store.ts     StatePort over IndexedDB
  ui/
    status-bar.ts, conflict-modal.ts, review-modal.ts, mass-delete-modal.ts, log-view.ts
  i18n.ts              t(key, vars) — English strings only
tests/
  fakes/fake-vault.ts  in-memory FS; options: caseInsensitive, nfdNames, failOn(path)
  fakes/fake-github.ts in-memory object store implementing the endpoints we use,
                       with fault injection (rate limit, 422 race, timeout, 5xx,
                       truncated tree, empty repo, force-push)
  *.test.ts
```

Dependencies allowed: `diff3` or `node-diff3` (pure JS merge), `ignore`
(gitignore matching), `fast-check` + `vitest` (dev). Ask before adding anything else.

## 4. State model

Per device, per vault, per (repo, branch) — stored in **IndexedDB**, never in
`data.json` and never inside the vault (the vault may itself be synced by
iCloud/Syncthing; the state is device-specific and must not travel).

```ts
interface Baseline {
  repo: string; branch: string;      // if either changes → baseline is discarded (first-sync mode)
  remoteHead: Sha | null;            // last commit we fully synced with
  files: Record<Path, {              // Path = NFC-normalized, repo-relative
    sha: Sha;                        // git blob sha both sides agreed on
    mode: "100644" | "100755";
  }>;
  dirs: Record<Path, Sha>;           // remote tree sha per directory, for skipping unchanged subtrees
}
interface LocalCache {               // speeds up scanning; safe to lose
  [path: Path]: { mtime: number; size: number; sha: Sha };
}
```

- The baseline is the **only** source of truth for "was this file synced before".
- Baseline updates are written **per file as each operation completes**
  (batched, e.g. every 25 files or 2 s), so a killed sync resumes correctly.
- Losing the baseline must be safe: it degrades to first-sync mode, never to
  deletions (§5.6).
- Device name (for commit messages + conflict copies) lives in `localStorage`
  via `app.saveLocalStorage`, defaulting to platform + short random suffix.

## 5. Sync algorithm

One sync = one pass of `core/sync.ts`. Global mutex: a second trigger while
syncing sets a "run again after" flag instead of running concurrently.

### 5.1 Triggers
- Manual: ribbon, command, status-bar menu.
- On startup (after `onLayoutReady`), on returning to foreground
  (`visibilitychange`), on interval (default 5 min, `registerInterval`).
- **Debounced after edits**: after vault `modify/create/delete/rename` events,
  sync N seconds after the last edit (default 60 s, configurable, can be off).
- **Cheap remote polling**: `GET /repos/{o}/{r}/git/ref/heads/{branch}` with
  `If-None-Match: <etag>`. A `304` costs no rate limit → skip remote diff entirely.

### 5.2 Local scan
- List all files (vault files + adapter listing for included dotfolders).
- Apply excludes (§7) **before** reading anything.
- For each file: if `(mtime, size)` matches `LocalCache`, reuse the cached sha;
  otherwise read bytes, hash, update cache. Yield to the event loop
  (`setTimeout(0)`) every ~25 files so the GC can run.
- Track Obsidian `rename` events (old → new path) in a small pending-renames log so
  local renames are pushed as renames, not delete+add with lost identity.
- Result: `localAdded / localModified / localDeleted` relative to the baseline.

### 5.3 Remote diff
- `GET ref` → remote head. If equal to `baseline.remoteHead` → no remote changes.
- Else get commit → root tree. Walk trees **non-recursively by directory**,
  descending only into directories whose tree sha differs from `baseline.dirs`.
  This handles any vault size and never hits the recursive-tree truncation limit.
  (Only use `?recursive=1` as an optimisation when there is no baseline, and if
  `truncated: true` fall back to the walk — **never** treat a truncated listing
  as complete.)
- Skip entries with mode `120000` (symlink) and `160000` (submodule); report them.
- Result: `remoteAdded / remoteModified / remoteDeleted` + detected renames
  (deleted path and added path with the same blob sha).

### 5.4 Plan (per path)
| Local | Remote | Action |
|---|---|---|
| unchanged | unchanged | nothing |
| changed | unchanged | push |
| unchanged | changed | pull |
| changed | changed, same sha | converged — update baseline only |
| changed | changed, different | **text:** 3-way merge with base = baseline sha (fetch base blob). Clean → write merged locally and push it. Overlap → conflict (§5.5). **Binary:** conflict |
| deleted | unchanged | push deletion |
| unchanged | deleted | delete locally |
| deleted | modified | **resurrect** remote version (edits beat deletes) |
| modified | deleted | **keep local**, push it back (edits beat deletes) |
| added | added, different | conflict (never overwrite either) |
| deleted | deleted | baseline cleanup only |

Text vs binary: valid UTF-8 with no NUL bytes in the first 8 KB, plus an extension
allow-list (`md, txt, canvas, json, css, js, csv, yaml, yml, base`). `.canvas` and
`.json` files merge as text but must be **re-validated with `JSON.parse` after
merging**; if invalid, it's a conflict instead.

### 5.5 Conflicts — never block the sync
- Default (works unattended): keep the **local** file in place and write the
  remote version next to it as `name (conflict <device> <YYYY-MM-DD HHmm>).ext`.
  Push both. Record it in a persisted conflicts list. Status bar shows the count.
- The conflict modal (manual) lists the recorded conflicts: keep local / keep
  remote / keep both / open side-by-side. Bulk actions for all files.
- One conflicted file must never stop other files from syncing.
- Never write `<<<<<<<` markers into notes unless the user picks "edit manually".

### 5.6 Safety guards (run after planning, before applying anything)
- **Mass-deletion guard:** if the plan deletes more than `max(10, 5%)` of files on
  either side, stop and show a confirmation modal listing them. In silent sync,
  just stop and flag the status bar.
- **First-sync mode** (no baseline, or repo/branch changed): never delete
  anything on either side. Identical shas → adopt. Different → conflict copy.
  Local-only → push. Remote-only → pull.
- **Empty-remote guard:** if the remote tree is empty but the baseline has files,
  treat as suspicious (wrong branch / wiped repo) → stop and ask.
- **Edited-during-sync guard:** before overwriting or deleting a local file,
  re-check its mtime/size. If it changed since the scan, skip it (it'll be
  handled next sync). Never overwrite what the user just typed.

### 5.7 Apply (pull side)
Order: writes/renames → deletes → remove now-empty folders (deepest first; only
if truly empty). Writes to existing notes go through `vault.modifyBinary(file)` so
open editors update. Create parent folders as needed. Update the baseline per
file as each op completes.

### 5.8 Push
1. If nothing to push → skip (no empty commits).
2. Build the new tree on top of the remote head's tree with `POST /git/trees`
   using `base_tree`:
   - text files → inline `content` (no separate blob request);
   - binary files → `POST /git/blobs` (base64), one at a time, throttled;
   - deletions → entry with `sha: null`;
   - keep existing modes (preserve `100755`).
   - If the request body would exceed ~8 MB or ~500 entries, split into chained
     tree requests (each uses the previous result as `base_tree`).
3. `POST /git/commits` with parent = remote head, message from template
   (`{{device}}`, `{{date}}`, `{{count}}`).
4. `PATCH /git/refs/heads/{branch}` with `force: false`.
   - `422` (not a fast-forward: another device pushed meanwhile) → re-run remote
     diff + plan for the affected paths and retry. Max 3 attempts, then report.
5. Only after the ref update succeeds: update `baseline.remoteHead`, files, dirs.

## 6. GitHub API rules

### 6.1 Limits to design around
- Primary: 5,000 requests/hour for a user token.
- Secondary: ~80 content-creating requests/minute and ~500/hour (blobs, trees,
  commits, refs count). This is why text goes inline in trees and binaries are throttled.
- Recursive tree listing truncates beyond 100k entries / 7 MB.
- Blob API max 100 MB. Our default max file size: 50 MB (setting). Larger files
  are skipped and listed in the sync report, never fail the whole sync.
- **Empty repo:** Git Data endpoints return `409`. Bootstrap with one
  `PUT /repos/{o}/{r}/contents/.gitkeep` (Contents API), then continue normally.

### 6.2 Request hygiene
- Headers: `Authorization: Bearer`, `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version`, a `User-Agent` (required, else 403).
- Download blobs raw (`Accept: application/vnd.github.raw+json`) → `arrayBuffer`.
  Never JSON+base64+`atob` (≈5× memory, the ObsSync OOM).
- Use ETags (`If-None-Match`) on ref/tree GETs; cache tree responses by sha (immutable).
- Validate responses: wrong content-type (captive portal HTML with 200) → network error.
- Read `X-RateLimit-Remaining`; if under 100, pause non-urgent syncs until reset.

### 6.3 Typed errors (each gets its own user message)
`Offline` (status 0 / DNS) · `Timeout` · `AuthInvalid` (401: token wrong/expired/revoked) ·
`PermissionDenied` (403 without rate-limit headers: token lacks Contents R/W, or SSO) ·
`RateLimited{resetAt}` (403/429 with `X-RateLimit-Remaining: 0` or `Retry-After`) ·
`NotFound` (404: repo/branch missing *or* token can't see a private repo — say both) ·
`EmptyRepo` (409) · `Conflict422` (non-fast-forward) · `BranchProtected` ·
`ServerError` (5xx) · `TooLarge` · `Unexpected`.
Never map one to another. Never put the token in any message or log.

### 6.4 Retry policy
- Timeout on every request: 30 s for metadata, 120 s for blob transfers.
- Retry `Offline`, `Timeout`, `ServerError`: exponential backoff with jitter
  (1 s, 2 s, 4 s, 8 s; max 4 tries).
- `RateLimited`: wait until `Retry-After` / reset if under 60 s, else stop the
  sync and show when it will resume.
- Never retry `AuthInvalid`, `PermissionDenied`, `NotFound`, `TooLarge`.
- Offline at sync start → skip silently in auto mode, show only in manual mode.

## 7. What gets synced

- Excludes: user glob patterns + the repo's `.gitignore` (via the `ignore`
  package), same semantics everywhere.
- **Always excluded, not overridable:** `.git/`, `.trash/`, this plugin's own
  folder `data.json`, any `workspace*.json`, `.obsidian/cache`, OS junk
  (`.DS_Store`, `Thumbs.db`, `desktop.ini`).
- `.obsidian/` config sync is **opt-in with an allow-list**: appearance, hotkeys,
  `snippets/`, `themes/`, core plugin config, and `plugins/*/{main.js,manifest.json,styles.css}`.
  Plugin `data.json` files are opt-in per plugin (they often hold secrets).
  Support per-device excludes (e.g. a desktop-only plugin).
- Respect `app.vault.configDir` — don't hard-code `.obsidian`.

## 8. Security

- Token stored with **`app.secretStorage`** and picked via `SecretComponent` in
  settings; `data.json` stores only the secret's *name*. SecretStorage is
  device-local, so tell the user to set it once per device.
- One-time migration if a plaintext token is found: move to SecretStorage,
  then remove from `data.json` only after the save succeeded.
- Recommend in the UI: fine-grained token, single repo, Contents read/write,
  with an expiry. "Test connection" checks scopes and shows what's missing.
- Logs: ring buffer (last 500 lines) viewable in a modal and copyable for bug
  reports; a redactor scrubs anything token-shaped (`ghp_`, `github_pat_`,
  `Bearer …`) before storing a line.
- Later (not v1): GitHub device-flow sign-in.

## 9. Filesystem & path edge cases (each needs a test)

- **Bytes, not strings:** file content is `Uint8Array` from read → hash → upload →
  download → write. Only decode to text inside the merge step, and only for files
  classified as text.
- **Unicode:** normalize paths to **NFC** for keys/comparison; keep the real
  on-disk name for I/O (iOS/macOS may give NFD).
- **Case-insensitive filesystems** (Windows, macOS, Android storage): if two remote
  paths differ only in case, pull the first, skip the second with a warning.
  A local case-only rename must push as a rename, not delete+add.
- **Invalid names on this OS** (`< > : " | ? *`, `\`, trailing dot/space, `CON`,
  `NUL`, …): skip that one file with a warning; never abort the sync.
- **Path length** > 255 per segment: skip with warning.
- **Folders:** git has no empty folders. Remove local folders only when a
  remote deletion leaves them empty. Folder renames = many file renames; must
  not trigger the mass-delete guard (renames aren't deletions).
- **Line endings:** hash raw bytes; never rewrite CRLF/LF. (We have no autocrlf,
  so the ObsSync CRLF phantom-change bug can't happen — keep it that way.)
- **Modes:** preserve `100755` from remote; new files are `100644`.
- **Zero-byte files** and files with only whitespace must round-trip.
- **Another sync tool on the same vault** (iCloud, Syncthing, Obsidian Sync,
  Dropbox): detect obvious signs (`.stfolder`, iCloud path, Obsidian Sync
  enabled) and show a warning in settings. Don't try to coexist cleverly.

## 10. UI rules

- Status bar: idle ✓ / pending count / syncing spinner (with "pulling 12/40") /
  conflicts count / error (click → message + "Copy log"). Last sync time on hover.
- Ribbon: sync. Commands: Sync now, Review changes, Resolve conflicts, Test
  connection, Show log, Pause/resume auto-sync. No default hotkeys.
- Review modal (works on all platforms): list local changes, untick to hold back
  a file this sync (held-back files stay untouched on disk).
- **Modal rule:** never open a modal synchronously from another modal's close
  or from inside a settings tab. Close the first, wait one frame
  (`requestAnimationFrame` / `setTimeout(0)`), then open the next. Only one
  plugin modal at a time.
- Silent (auto) syncs never open modals; they flag the status bar.
- Mobile: settings rows stack vertically; inputs don't overflow; modals
  respect the safe-area / keyboard.
- Notices: short, actionable, no stack traces.

## 11. Testing (required, not optional)

- `vitest`. `npm test` must pass before any commit.
- **Unit tests** for every `core/` module against `FakeVault` + `FakeGitHub`.
- **Scenario tests** (one test per row of §5.4, per §5.6 guard, per §9 bullet,
  per §6.3 error).
- **Property test** (`fast-check`), the most important one: generate random
  sequences of edits/creates/deletes/renames on two simulated devices
  (text and binary, overlapping and not), interleave syncs with random network
  faults and random "app killed here" points, then sync both until quiet.
  Assert:
  1. both devices and the remote converge to identical content;
  2. no edit is lost (every final version of every edit exists either in place
     or in a conflict copy);
  3. binary files are byte-identical to one of the versions written;
  4. nothing was deleted that wasn't deleted by a user action.
- Regression rule: every bug fix starts with a failing test that reproduces it.
- Keep `docs/BUG_HISTORY.md`: symptom, root cause, fix, test name.
- Manual checklist in `TESTING.md` for what fakes can't cover: real Android
  device (memory), iOS, Windows path/case behaviour, background/resume.

## 12. Coding conventions

- TypeScript `strict: true`, no `any`, no non-null `!` without a comment saying why.
- Small pure functions in `core/`; side effects only in adapters.
- Use `this.registerEvent`, `this.registerInterval`, `this.registerDomEvent`
  so everything is cleaned up on unload.
- No `innerHTML`/`outerHTML`; build DOM with `createEl`. Styles in `styles.css`
  using Obsidian CSS variables, no inline styles (use `setCssStyles` if unavoidable).
- Use `activeDocument`/`activeWindow`, not `document`/`window` (popout windows).
- UI text in sentence case; no "Settings" heading at the top of the tab.
- No `console.log` in production paths; use the logger.
- Commits: conventional commits (`feat:`, `fix:`, `test:`…). Don't bump versions
  in feature commits.

## 13. Build order

Do these in order; each milestone ends with tests green and a working build.

1. **Skeleton:** manifest, esbuild, vitest, lint, `core/ports.ts`, fakes, CI workflow.
2. **Core pull:** hash, paths, remote tree walk, plan (pull rows only), apply. Tests.
3. **Core push:** local scan with cache, push via trees/commit/ref, 422 retry. Tests.
4. **Merge & conflicts:** 3-way text merge, conflict copies, all §5.4 rows. Property test.
5. **Guards:** first-sync mode, mass-delete, empty-remote, edited-during-sync.
6. **Adapters:** Obsidian vault, GitHub over `requestUrl` with typed errors + retry, IndexedDB state.
7. **UI:** settings (SecretComponent, repo/branch pickers, test connection), status bar, commands.
8. **Scheduling:** debounce-after-edit, interval, foreground, ETag polling.
9. **Modals:** conflict, review, mass-delete, log viewer.
10. **Config sync** (`.obsidian` allow-list) and per-device excludes.
11. Manual test pass on Android + iOS + Windows; then release workflow (tag → build → attest → release).

## 14. How to work in this repo (instructions for Claude)

- Before changing `core/`, read the relevant section of this file and the tests
  for that module. If a change would break an invariant in §5.6 or §11, stop and
  say so instead of working around it.
- When unsure about an Obsidian or GitHub API behaviour, check the typings /
  official docs; don't assume. Note the source in a code comment.
- Prefer adding a scenario to the fakes over adding special cases to the code.
- When you fix a bug: failing test first, then fix, then add a BUG_HISTORY entry.
- Keep PRs small: one milestone step or one bug per change.
- Run `npm run build && npm test` before saying a task is done.
