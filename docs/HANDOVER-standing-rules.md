# Handover — standing rules: what is broken, what is missing, what to do

Written 1 Sept 2026 at the end of a long session, for whoever picks this up next.
Every claim below is cited to a file and line so you can verify rather than trust
me. Where I am uncertain I say so.

---

## 0. Read this first — the one-paragraph version

"Standing rules" are the Allow/Never command rules under **Settings → Computer →
Remote control**. They live only in the OpenGrok server's Postgres, keyed by
`(account_id, machine_id)`. The user reported that turning things off "nuked"
their rules. **It did not.** The rules were *orphaned*: `Turn off…` destroys the
local `machineId`, and turning it back on mints a brand-new one, so the old rows
become unreachable. I confirmed this against the live database — **29 rules
exist, 0 are visible to the current machine, and there are 12 machine ids for
one Mac (11 revoked).** Nothing deletes rule rows anywhere in the server.

---

## 1. Where things stand right now

| Item | State |
|---|---|
| **PR #8** (Standing rules modal) | OPEN, MERGEABLE/CLEAN, CI green on 3 OSes, 3 review rounds, **approved**, deliberately **not merged** — awaiting the user's own review |
| Branch `standing-rules-modal` | 5 commits, clean |
| This handover | branch `standing-rules-handover`, off `main` |
| Repo visibility | **PRIVATE** again (was public for free CI minutes; user's private Actions quota was maxed, so CI may not run) |
| The work below | **Not started.** Investigation only. |

PR #8 only moved the rules *list* into a modal. It did not touch how rules are
created, matched, stored, or scoped. Everything in section 4 is still to do.

---

## 2. The environment

**Repos**
- Client (this repo): Electron app, `/Volumes/goldcoders/OSS/opengrok`
- Server: `/Volumes/goldcoders/OSS/opengrok-server` — Rust/axum + Postgres, listens on `:1447`

**Live database** (this is how I proved the orphaning)
- The running server uses the database named in `opengrok-server/.env` — at time of
  writing `opengrok_web_verify` on `127.0.0.1:5455`. Credentials are in that `.env`;
  do not paste them into commits.
- Useful read-only query — rules per machine:
  ```sql
  select d.machine_id, d.revoked, coalesce(p.mode,'(none)') as mode,
         count(r.pattern) filter (where r.kind='allow') as allow_n,
         count(r.pattern) filter (where r.kind='deny')  as deny_n
  from local_exec_daemon d
  left join local_exec_policy p using (account_id, machine_id)
  left join local_exec_rule   r using (account_id, machine_id)
  group by 1,2,3 order by 2,1;
  ```

**Build & verify loop** (see also `CLAUDE.md`, which is authoritative)
```sh
npm run check          # both typechecks + 294 tests
npm run package        # CHECK ITS EXIT CODE DIRECTLY, never through a pipe
rsync -a --delete "dist/Open Grok.app/" "/Applications/Open Grok.app/"   # in place; never rm the bundle (kills Full Disk Access)
pkill -9 -f "Open Grok.app/Contents"; sleep 3
"/Applications/Open Grok.app/Contents/MacOS/Grok Bot" --remote-debugging-port=9223 &
```
Then drive it over CDP on `localhost:9223` (not `127.0.0.1`). **Never** use
screen/computer control or the Chrome extension tools — this is an Electron app.

---

## 3. Traps that cost me hours. Read before touching the UI.

1. **The renderer patch splices into ONE chunk.** `COMPONENT_SOURCE` in
   `scripts/lib/router-renderer-patch.mjs` is injected into the chunk containing
   `function Sa(s){` — `src/app/dist/renderer/assets/index-BlqerJhg.js`. A symbol
   that lives only in the main chunk resolves to `undefined` and takes the whole
   renderer to an error screen. **I shipped this bug once.** The aliases that
   actually exist in that chunk's import header:

   | Use | Alias | Note |
   |---|---|---|
   | Dialog | `Os` | the same one that renders Settings; `size:"md"` is non-fullscreen (Settings uses `xxl`) |
   | Switch | `Ne` | **not `Hlt`** — `Hlt` is its main-chunk name and crashes |
   | Icon button | `$e` | `{icon,"aria-label",variant,size,shape}` |
   | Divider | `ts` | |
   | Icon | `je` | registry `name` |
   | Row/card, Button, Text, Select, Section | `ie`, `oe`, `se`, `ye`, `re` | |
   | React | `de` | `de.useState`, `de.useLayoutEffect` |
   | Settings **page** pane | `Te` | **NOT a list scroller** — see trap 2 |

   `tests/consent-model-patches.test.mjs` guards this; it fails CI if you
   reference something absent.

2. **`Te` is the settings page pane, not a scroll box.** It only constrains height
   as a flex child of a definite-height column, and it carries 22/32/28/32 page
   padding. I used it for the rules list and **the list silently never scrolled**.
   For an in-dialog list use a plain `div` with `overflowY:"auto"` and an explicit
   height.

3. **Test list UI at volume.** I tested the modal with the 2 rules that happened to
   exist, so overflow never occurred and the scroll bug survived to review. Inject
   ~40 rows over CDP before believing a list works.

4. **Main-process code you edit lives in `dist/recovered-source/electron-main/main.cjs`**
   in the packaged app, *not* `dist/electron-main/main.cjs`.

5. **A new main-edge RPC needs three edits** or you get
   `mainEdge[method] is not a function`: the handler in `source/electron-main/main-edge.ts`,
   `MAIN_METHOD_TABLE` in `source/shared/rpc/main.ts`, and the preload surface in
   `source/electron-preload/preload.ts`.

6. **Never `import "electron"` inside `source/`** — it drags electron types in and
   breaks `carrier.ts` typechecking. Inject native APIs through
   `ElectronProductionNativeBindings` instead.

7. **Windows-specific, all learned from real CI failures:**
   - ESM `import()` of a bundled file needs `pathToFileURL(p).href`; a bare
     `C:\…` path throws `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
   - Use `path.win32` explicitly in Windows-only logic, or it produces POSIX
     separators when the tests run from macOS.
   - Temp-dir teardown races: use
     `rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})`.

8. **`window.desktop.*` is a frozen contextBridge object** — you cannot monkey-patch
   it from CDP to stub data. Manipulate the DOM instead, or seed the server.

---

## 4. What the investigation found

All eight questions were traced end to end. Citations are `file:line`.

### 4.1 Storage and keying
- Table `local_exec_rule (account_id, machine_id, kind, pattern, added_at_ms)`,
  PK on all four — `opengrok-store/src/migrations.rs:362-369`.
- Sibling tables `local_exec_policy` (mode) `:352-358`, `local_exec_daemon`
  (enrolment) `:374-382`.
- Routes in `opengrok-server/src/local_exec.rs`: table `:167-189`, `get_policy`
  `:354-371`, `set_mode` `:381-401`, `add_rule` `:412-443`, `remove_rule` `:446-472`.
- **The client persists nothing** — `getRemoteControl` fetches on demand
  (`source/electron-main/main-edge.ts:547-568`).
- **Rules do not follow the user to another device.** A second Mac mints its own
  `machineId` and starts empty. This is deliberate: a "device tier" for
  auto-review was cut *because* per-machine standing rules already are that tier
  (`migrations.rs:399-402`).

### 4.2 What is stored
**The full verbatim command string**, trimmed, nothing else. The client never
sends it — the server reads it off the paused tool call
(`gateway/conversation.rs:1118-1123`), then writes the rule `:1166-1182`.

Two real hazards:
- The card **displays** a 500-char clip (`gateway/cards.rs:70-74`) but stores the
  **unclipped** command. What you approve and what you store can differ.
- `pattern` is part of the primary key, so past roughly 2,700 bytes the insert
  exceeds the btree limit and **fails silently** — the error is discarded by
  `let _ =` at `conversation.rs:1176`.

Also note `enabled_machine` (`local_exec.rs:837-859`) picks the *first non-revoked
machine with mode ≠ never*, which is **not necessarily the machine the Settings UI
is showing**. With two live Macs the rule can land on the wrong one.

### 4.3 Matching — server-side only
```rust
// local_exec.rs:68-75
command == pattern || command.starts_with(&format!("{pattern} "))
```
Word-boundary **prefix**, case-sensitive, no glob or regex. Deny beats allow
(`:986-994`). The decision ladder is in `opengrok-tools/src/review.rs:111-127`:
standing deny → auto-review block → standing ask (card) → auto-review ask → run.

**The machine has no matcher at all.** The daemon's only check is the on/off
switch (`source/host/local-exec/local-exec-daemon.ts:100-106`); its permission
service is a mock that allows everything
(`source/local-exec-daemon/production-executor.ts:254`).

Consequence worth internalising: one Allow on `git` silently covers
`git push --force`.

### 4.4 The "nuked" bug — the important one
- The **"This computer accepts bot commands" toggle is innocent.** It writes a
  local setting and makes **no server call**
  (`router-renderer-patch.mjs:340-342` → `main-edge.ts:411`).
- **`Turn off…` under Remote control** deletes both local secrets — including the
  `machineId` — then marks the daemon revoked server-side
  (`main-edge.ts:587-604`; `postgres.rs:1283-1292` is an `update … set revoked =
  true`, **not** a delete).
- **No code path anywhere deletes `local_exec_rule` rows** except the explicit
  `DELETE /local-exec/policy/rule`. Verified by grep across `crates/`.
- **Turning it back on mints a fresh id** because the client posts only `{label}`
  (`main-edge.ts:577`) and the server generates `mac_<uuid7>` when none is sent
  (`local_exec.rs:222-225`). The server *does* accept a supplied `machine_id`
  (`EnrolBody`, `:206-210`) — the client just never sends one.
- A fresh enrolment has no policy row, so mode defaults to **Never**
  (`local_exec.rs:25-26`), and while mode is Never `enabled_machine` returns
  `None`, so **new Always presses write nothing at all**.

**Confirmed live**: the user's `uname` and `whoami` rules sit under a revoked
machine id; the live machine has zero. 29 rules total, 12 machine ids, 11 revoked.

### 4.5 sudo — no guard anywhere
No check on the card path, the server add-rule path, or the matcher. Server-wide
grep for "sudo" finds three hits, all in a unit test that *demonstrates* `sudo rm`
is a valid allow pattern (`local_exec.rs:989-993`).

### 4.6 Session scope — does not exist
Card buttons are **Always allow / Allow once / Never / Deny once**. Only Always and
Never persist rules (`conversation.rs:1166-1170`). "Allow once" means literally one
tool call. There is no "for this session" tier.

### 4.7 Auto-review is a separate system, and its label lies
Stored in `auto_review_policy`, two tiers (global, coworker) — `migrations.rs:388-397`.
Verdicts come from a **bounded model call**, not pattern matching
(`opengrok-harness/src/review.rs:29-41`).

**Bug:** the General tab offers "Allow automatically" / **"Ask first"**, but rows
set to "Ask first" are stored in `blockInstructions` and enforced as a **hard
refusal** (`review.rs:115-117`), never a card. So today there is *no* way to
express "always ask me about `rm -rf`".

### 4.8 The alignment bug the user reported
`ie` (the settings card, `JWe`) insets its copy column by **14px**
(`padding-left: var(--cursor-spacing-3-5)`). In `RLocalComputer`
(`router-renderer-patch.mjs:353-369`) the status note is a **sibling after the
card** via `RRowNote` (`:318`), which has `paddingLeft: 0`. Hence the 14px
misalignment on "Waiting for Touch ID…" and the red validation error. Same for
`RRemoteControl`'s error lines (`:294`, `:315`).

**Best fix:** `JWe` has an unused **`extraCopy`** prop rendered as the third child
of the copy column, so it inherits the inset and the 2px column gap automatically.
No call site in the patch currently uses it.

---

## 5. The work, in the order I would do it

### P0 — Recover the 29 orphaned rules (no code change)
Re-file the wanted rules from the revoked machine ids onto the live one with a
single SQL statement. Confirm the live id first via the app
(`window.desktop.agent.getRemoteControl()` over CDP) or the query in section 2.
**Ask the user which rules they want kept** — some are stale.

### P1 — Stop the orphaning (highest-value code fix)
- Preserve the `machineId` across `Turn off…`, and send it back on re-enrol. The
  server already accepts `machine_id` in `EnrolBody` (`local_exec.rs:206-210`); the
  client just needs to include it (`main-edge.ts:577`).
- Decide what `Turn off…` should mean: today it *revokes the credential*. If the
  intent is only "stop accepting commands", that is what mode `never` is for, and
  revoking should be a separate, clearly-labelled destructive action.
- Set a sensible mode on re-enrol so Always presses are not silently dropped.

### P2 — Guard sudo into the **allow** list only
The user asked whether to block `sudo` from both lists. **Block it from allow, not
from deny.** Denies are protective; refusing to remember "never run sudo" removes a
safety net. Enforce server-side in `add_rule` (`local_exec.rs:412-443`) and in the
card-driven write (`conversation.rs:1166-1182`) so every path is covered by one
check. Consider the same treatment for a small reserved set (`rm -rf`, `mkfs`, …)
— but confirm the list with the user rather than inventing it.

### P3 — Fix the note alignment (small, self-contained)
Pass the note through `ie`'s `extraCopy` prop instead of rendering it as a sibling.
Touches `RLocalComputer` and `RRemoteControl` in `router-renderer-patch.mjs`.

### P4 — Add a session tier
An "Allow for this session" card option held in memory and dropped on restart.
Route long/chained commands here by default instead of into permanent storage —
that also defuses the >2,700-byte silent-failure case.

### P5 — Let people write rules by hand
`POST /local-exec/policy/rule` already exists and **no client code calls it** (only
DELETE, `main-edge.ts:619-635`). The Manage… modal added in PR #8 is the natural
home for an "Add rule" field. This is what unlocks "always ask about `rm -rf`".

### P6 — Make "Ask first" ask, or rename it
Either add a path that yields `ReviewOutcome::Ask`, or relabel the option "Block".
Both are honest; the current pairing is not.

---

## 6. How to verify UI work here

1. `npm run check` — 294 tests must stay green.
2. `npm run package` — **check the exit code directly**.
3. rsync in place, relaunch with `--remote-debugging-port=9223`.
4. **Confirm the app renders before asserting anything else** —
   `document.body.innerText.includes("Something went wrong")` must be false. A
   cross-chunk mistake shows up here and nowhere else.
5. Drive the actual flow over CDP, **at volume** (inject ~40 rows for lists).
6. Screenshot light **and** dark; the app's theme is set via
   `window.desktop.theme.set("dark")`.
7. Run a reviewer subagent over the diff before asking the user to look. In this
   session that caught a shipped blocker *and* a keyboard regression I introduced
   while fixing the first review's findings.

---

## 7. Open questions for the user

- Which of the 29 orphaned rules should be recovered?
- Should `Turn off…` keep revoking the credential, or just stop accepting commands?
- Beyond `sudo`, what belongs on a never-auto-allow list?
- Should standing rules become account-wide (sync across devices) or stay
  per-machine? Today they are firmly per-machine, and that is a deliberate design
  choice, not an oversight.

---

## 8. What I would not trust without re-checking

- Whether the running app is a packaged build. The *pinned* bundle on disk still
  contains the upstream `setPermission(e)` call that flips the machine switch from
  the card; `scripts/clean-build.mjs` removes it at package time. A dev build
  against the unpatched bundle behaves differently.
- Whether the primary-key size limit has ever actually been hit in practice — the
  failure is silent by construction, so absence of evidence is not evidence here.
- `docs/reverse-exec-design.md`, referenced by `local_exec.rs:12`, does not exist
  in the server repo.
