# Manual test checklist

What the fakes cannot prove (§11). Run before each release; note device, OS and
Obsidian version next to each tick.

## GitHub API behaviour the docs do not pin down
- [ ] **Empty repo bootstrap:** brand-new repo with no commits → first sync creates
      the branch via `PUT /contents/.gitkeep` (docs don't say what `branch` does on an
      empty repo). Try both the default branch and a non-default branch name.
- [ ] **Missing branch in a non-empty repo** → orphan branch with only `.gitkeep`;
      other branches untouched.
- [ ] **Protected branch / ruleset** → push reports "branch is protected", not a retry loop.
- [ ] **Fine-grained token without Contents write** → "lacks access", not "bad token".
- [ ] **Expired/revoked token** → "wrong, expired or revoked".
- [ ] **Org with SSO** → SSO message.
- [ ] **Secondary rate limit:** push ~300 binary files at once; sync pauses and resumes
      instead of failing.
- [ ] **Captive portal / hotel Wi-Fi** → treated as offline, nothing written.

## Platform
- [ ] **Android:** vault with a 40 MB attachment; sync up and down without the
      WebView running out of memory.
- [ ] **Android/iOS:** background the app mid-sync, return after 10 min; next sync
      resumes and converges (IndexedDB connection may have been closed by the OS).
- [ ] **iOS:** note named with accents (`Café.md`) created on iOS syncs to desktop and
      back without a duplicate; same for a folder with an accented name.
- [ ] **Windows:** remote file `CON.md` / `a:b.md` → skipped with a warning; two remote
      files differing only in case → first pulled, second skipped.
- [ ] **Deleted notes** go to the trash the user configured (Obsidian trash / system
      trash), not permanently removed.
- [ ] **Open editor:** a pulled change to the note you are viewing shows up without
      reopening it; typing during a sync is never overwritten.
- [ ] **Two vaults with the same name** on one device keep separate sync state.

## Plugin UI (milestone 7: Obsidian glue has no automated tests)
- [ ] Fresh install: status bar says "Set up sync"; "Sync now" explains what is missing.
- [ ] Pick a token with the secret picker on desktop and on mobile; restart: still set.
      `data.json` contains only the secret id, never the token.
- [ ] Upgrade from a data.json with a plaintext `token`: after load it is in secret
      storage and gone from data.json.
- [ ] Repo and branch fields suggest from GitHub after the token is set.
- [ ] Test connection with: good fine-grained token, classic token without `repo`,
      read-only token, expired token, wrong repo name. Each says what is missing.
- [ ] Status bar shows progress ("Pulling 12/40"), conflicts, errors; hover shows last
      sync time; click opens the menu (sync, problem detail, pause, copy log).
- [ ] Startup does not show the whole vault as pending.
- [ ] Copied log contains no token (search it for `ghp_` / `github_pat_` / `Bearer`).
- [ ] Mobile: settings rows stack, no horizontal overflow, keyboard does not hide inputs.
- [ ] Another sync tool (Syncthing `.stfolder`, Obsidian Sync on) → warning in settings.

## Scheduling (milestone 8)
- [ ] Interval poll sends `If-None-Match` and gets a **304** through `requestUrl` on
      desktop *and* mobile (check `X-RateLimit-Remaining` does not drop between idle polls).
- [ ] Edit a note, stop typing: one sync ~60 s later. Keep typing: no sync until you stop.
- [ ] A pull that writes files does **not** trigger another sync by itself (watch the log:
      no "auto sync: edit" right after a pull).
- [ ] Android/iOS: edit, then switch to another app within the debounce: sync starts
      immediately (log "auto sync: background"); return later: "auto sync: foreground".
- [ ] Startup sync runs once after the vault opens, not for every file the vault loads.
- [ ] Pause automatic sync: no polls or syncs in the log; manual sync still works.

## Modals (milestone 9)
- [ ] Mass-delete: delete 15 notes in a 50-note vault, "Sync now" → modal lists them; Cancel
      changes nothing; Confirm deletes on GitHub. Same via status-bar "Review and continue…"
      after a silent sync stopped.
- [ ] Empty remote: wipe the branch on GitHub → modal; "Upload this vault again" restores
      everything; "Delete local files too" needs two clicks.
- [ ] Opening any modal from another modal's button (e.g. confirm → sync → next stop) and
      from the settings tab: no black screen on Android/iOS, never two modals stacked.
- [ ] Review: untick a changed note → sync → note unchanged locally and on GitHub; next
      plain sync pushes it.
- [ ] Conflicts: create one on two devices; keep mine / keep theirs / keep both / edit
      manually each do what they say; Compare opens both side by side; editing a file after
      the conflict makes "keep theirs" refuse with a reason.
- [ ] Log viewer: scrolls to the newest line, "Only warnings and errors" filters, Copy works.
- [ ] Mobile: long lists scroll inside the modal; buttons reachable above the home indicator
      and with the keyboard open.

## Config sync and per-device excludes (milestone 10)
- [ ] Repo with `.github/workflows/*.yml`: sync from desktop and phone several times; the
      workflow files stay on GitHub untouched and never appear in the vault.
- [ ] Root `.gitignore` in the repo arrives in the vault and its patterns take effect on
      the next sync (excluded files are left alone, not deleted).
- [ ] Turn on "Sync the .obsidian folder" on two devices: a theme, a CSS snippet, a hotkey
      and a core setting changed on one appear on the other after restarting Obsidian there.
- [ ] Community plugin installed on desktop shows up on the phone (code only); its
      settings arrive only after ticking its data.json toggle.
- [ ] A plugin marked "not synced on this device" keeps its own version here and is not
      deleted from GitHub or the other devices.
- [ ] `workspace.json`, `workspace-mobile.json` and `.obsidian/cache` never reach GitHub.
- [ ] This plugin's own `data.json` never reaches GitHub, even with config sync on.
- [ ] Turning config sync off: nothing is deleted on either side.
