# OpenGrok — remaining work

The state of play after 31 Aug 2026, and the goal a session can be pointed at.
Everything already shipped is in
[the integration doc](./opengrok-server-integration.md).

**Work one task at a time. A task is not finished until it has been verified in
the running app and nothing that worked before it has stopped working.** Several
things went in today that looked right and were not; every one that was caught
was caught by driving the app, never by a test alone.

---

## Rules for anyone working this file

1. **One task at a time.** Do not start the next until the current one is
   verified and committed.
2. **Verify in the running app, over CDP.** `npm run check` passing is necessary
   and never sufficient. The helpers are `docs/research/tools/cdp-ws-eval.mjs`
   (evaluate in the renderer) and `cdp-drive.mjs` (**real** input events — a
   synthetic `.click()` closes menus instead of activating them).
3. **Prove the absence of regression, do not assume it.** Every task ends with
   the same smoke pass; run it and say what you saw.
4. **Never guess a contract.** If something needs the server, draft the handover
   and send it — do not invent a method name and discover it 404s.
5. **Report what you observed, not what should happen.** Exact method, status,
   log line, what the app showed.

### The smoke pass

Run after every task. This is the regression guard.

| Path | What must be true |
|---|---|
| Launch | Loading page → app. No Grok Bot sign-in page flashes. |
| Roster | Bots listed, correct account |
| Send | Message sends, reply paints live, composer clears. In `~/Library/Application Support/OpenGrok/sand-data/telemetry-log.jsonl` the send shows `echo-coordinator-sse`, then (unless the replica already had an epoch) `getAgentTranscriptTail` + `replica.resync transcript covered`, then `send_ack` within a second. No `echo-coordinator-sse-missing`. |
| Send after reload | Cmd+R, then send: exactly one `coordinator_handoff adopted renderer_port` after the reload, and the same chain as Send. This is the "reply only after Cmd+R" class fixed 2 Sep 2026 (hexuria/opengrok#17); a page that shows "…" and no reply here has a replica that never re-fetched — see `docs/local-telemetry-log.md`. |
| Long turn | Stop bar appears, Stop ends the turn |
| Settings ▸ General | Provider named "Open Grok", address shown |
| Settings ▸ Computer | Roster with the active one marked "Your computer"; this Mac named; Reset present |
| Computer view | Screen draws for an ascii box; honest message for a headless one |
| Log out | Returns to the picker; Codex/Claude CLI sessions untouched |

---

## Task 1 — Regression pass, and prove the flag leak is closed — DONE 31 Aug 2026

**Owner: ours. Nothing needed from the server.**

**Result.** The whole smoke pass passed against the live server, and the leak
fix is proven rather than trusted:

| Path | Observed |
|---|---|
| Launch | `["\|app"]` — no frame where the sign-in page is visible |
| Roster | 3 bots, `signin@acme.test` |
| Send | composer cleared 2s, real answer (42) painted 4s |
| Long turn | bar absent at 20s and 40s, present at 48s, torn down when work ends |
| Stop | `isRunning` true → `stopAgentTurn` → false at +3/5/10/15s, bot usable in 3s, no reload |
| Settings ▸ General | `O ǀ Open Grok ǀ signin@acme.test ǀ Sign Out` |
| Settings ▸ Computer | roster with box.ascii.dev "Your computer", Reset present, this Mac named with its permission |
| Computer view | `state: running`, real `vnc.html` URL, no placeholder |
| Log out | present in the menu — **not pressed**, because signing back in needs the user |

**One thing ruled out rather than assumed.** The transcript appeared to show
prompts concatenated together, which would have been a serious send bug. It is
not: the composer was empty before typing, took only the new text, and the
message was sent alone. The app groups consecutive messages from the same sender
into one bubble for display.

**Turns now finish in seconds**, so the 45s bar could not be reached by asking
for a long answer. It was verified directly instead, by holding a working
indicator up and watching the bar's own timing — which tests the bar rather than
the model's speed.

Around twenty-five commits landed in a day, several touching the same paths.
Nothing has verified them together.

**Done when:**

- The whole smoke pass passes, reported line by line with what was seen.
- **The `isRunning` leak fix is proven, not assumed.** The server now clears the
  flag on every exit of a turn including abort. Force an aborted turn — start a
  long one, stop it — and confirm `isRunning` goes false and stays false, and
  that the bot is usable immediately afterwards with no reload.
- Any fault found is either fixed here or drafted as a handover, never left
  unrecorded.

---

## Task 2 — A real login page per provider — DONE 31 Aug 2026

**Owner: ours. Highest regression risk on this list.**

Each provider carries its own accent, its own opening line, and a sentence
naming what pressing Sign in does — a terminal for Codex and Claude, a browser
for Cursor and OpenGrok — plus what their CLI is already doing, so pressing the
button is not a guess. Upstream's sign-in button is untouched: it is what starts
each flow, and replacing the page to restyle it would have risked the one screen
a person cannot get past.

**All four pages driven over CDP:**

| Provider | Accent | Title | What Sign in does |
|---|---|---|---|
| cursor | `#8b8b8b` | Grok Bot | opens your browser to Cursor |
| opengrok | `#4ec9a5` | Open Grok | opens your browser to your server |
| codex | `#74aa9c` | Codex | opens a terminal and runs the Codex login |
| claude-code | `#d97757` | Claude | opens a terminal and runs the Claude login |

Four distinct accents, four distinct ledes, the rule present on each, and the
sign-in button preserved on every one.

**How, without signing anybody out.** The page exists only when signed out, and
every obvious route to it harms the thing being verified: signing out needs the
user; switching provider to reach a page signs them out anyway when it crosses
the OpenGrok boundary; and injecting a page into the document opens the picker
and restarts the coordinator.

So the painter was made inspectable instead. It found its page by selector and
could therefore only ever paint the real one; it now accepts a page, and
`__sandLoginPreview(id)` paints any provider into a detached page and hands back
what it produced. Detached deliberately — it never enters the document, so it
cannot trip the observer or be seen. Inert unless called, like the
`__sandMediaDebug` and `__sandLayoutReport` hooks this app already ships.

**Smoke pass after this task:** launch clean with no flash, 3 bots, signed in,
reply in 4s, log out present, General shows Open Grok, Computer shows the
roster, reset and this Mac.

## Task 3 — `computerError` on the agent rows — DONE 31 Aug 2026

**Owner: ours. The server already sends it.**

**Result.** A bot whose own computer could not be provisioned now says so, in the
same seven codes as the Computer panel but worded about the bot rather than the
organisation. An unrecognised code still shows the server's own words.

Verified live: the route answers against the real roster with `issues: []` — all
three bots share one working box — and **no bar is shown**. That is the property
worth proving, because a bar claiming a broken computer when nothing is wrong
would be worse than none at all. A roster that cannot be read returns no issues
rather than inventing one.

The positive case was not forced. Producing a real failure means breaking the
organisation's box key, which is the user's credential and their working setup.
The wording and the fallback are covered by tests instead.

Smoke pass after this task: launch clean, 3 bots, signed in, reply in 2s, log
out present, General shows Open Grok, Computer shows the roster, reset and this
Mac.

`computerError` was agreed on two surfaces. The account-level one is rendered;
the per-agent one on `listAgents` rows is not read at all.

It only carries information in **per-bot** sharing mode — not the mode in use —
so this is completeness rather than a live bug. Worth doing while it is small
and the contract is fresh.

**Done when:** a bot whose own computer failed to provision says why, in its own
row, using the same codes and copy as the account-level surface; a bot with a
working computer says nothing; an unrecognised code still shows the server's own
words. Verified over CDP.

---

## Blocked, and by whom

**The Usage panel** — needs `getUsage`, which the server has never built. The
contract is agreed and unchanged:

```
getUsage({periodStart?, periodEnd?})
  → { periodStart, periodEnd,
      models: [{ model, inputTokens, outputTokens, requests }] }
```

Tokens only, never pricing. `models` always present, empty when nothing is
recorded. **Do not build the panel against an endpoint that 404s.**

**Reverse exec** — a bot acting on the user's own Mac. Specified in the server
repo (`docs/reverse-exec-design.md`), security shape agreed in writing, and
**deliberately unbuilt**: gated on the server owner's explicit decision. A
capability that lets a remote drive somebody's laptop should not exist because
two agents agreed it was reasonable. Do not start it.

**Dropped** — an in-app terminal. An ascii box has a graphical desktop with a
terminal inside it, and any box can be driven by asking the bot.

---

## Working with the `opengrok-server` session

A peer session builds the server in a separate private repo. Reach it with
`SendMessage` to `opengrok-server-settings-mode` (confirm with `ListAgents`
first — sessions change).

**When something turns out to be theirs, draft a handover rather than working
around it.** A good one carries: what was observed, exactly; what was ruled out
and how; whose half it is and why; and what is needed, by name. Four hypotheses
were disproven this way in one day — two from each side — and every one would
otherwise have been built on.

**The agreement:**

- Agree a slice before either side writes code, then build both halves at once.
- Verify independently: theirs server-side, ours by driving the app.
- Exchange evidence, not conclusions. "Should work" is not a report.
- Agree ownership before fixing, so neither side fixes the same thing.

**Never** ask the peer to do something this session's permissions refuse — that
is laundering, not delegation. Route it back to the user.

**Only the user** enters passwords, signs in, or places credentials such as the
box.ascii.dev key on the admin dashboard.

## Building

`npm run check` → `npm run package` →
`rsync -a --delete "dist/Open Grok.app/" "/Applications/Open Grok.app/"` (never
delete the installed bundle first — it prunes the Full Disk Access grant) →
relaunch with `--remote-debugging-port=9223` → verify over CDP.

**A UI is only ever as honest as the status it is handed.** Most of a day went
into making a false status more precise, three times over, before the cause
turned out to be a liveness probe reading a path the provider forbids. When a
panel keeps saying the wrong thing, suspect the thing feeding it.

---

## Reverse exec — VERIFIED END TO END, 31 Aug 2026

Two real commands ran on the user's Mac behind two real Allow presses:
`~/Code/example123` and `~/Code/example123/xyz` both exist on disk, created
through: bot ask → inline approval card → Allow once → local approval recorded
→ server resume-dispatch (approvalId = callId) → shellStreamArgs exec on the
daemon → streamed result → model summary in the chat.

### The inline card contract (byte-verified against the shipped renderer)

The server emits a transcript entry when `user_machine_shell` suspends on Ask:

```json
{"kind":"send-message","id":"<entryId>","timestampMs":0,
 "message":{"type":"local-tool-permission",
  "ask":{"requestId":"<callId>","status":"pending",
         "action":"run-command","target":"<full command>"}}}
```

- Renderer dedup key: `local-tool-permission:${requestId}:${status}` — to
  update a card re-emit the SAME entryId with only `ask.status` changed
  (`allow-once|always|denied|never|expired`).
- The answer arrives server-side as gateway method
  `POST /api/resolveLocalToolPermission`
  `{entryId, requestId, resolution, agentId}`. "Always" may arrive as
  `allow-once` (client ceiling downgrade).
- Allow once records the LOCAL approval under requestId BEFORE resolving, so
  the resumed frame passes the machine's own gate. The Mac stays the consent
  source of truth. Always/Never set the machine's local Execution permission.
- A resolve for a dead request flips the stored entry to `expired` (server
  heal-on-press) and returns 410. Asks have NO timeout by design.
- The modal is retired. The daemon's hold-and-ask file remains the gate for
  frames arriving with no approval (out-of-band); they expire at 90s with no
  UI until out-of-band consent is designed (push notification, not a window).

### Still open

- "Always allow this command" — **built, and it works globally.** The gap is
  the destination, not the wiring. Corrected 2 Sep 2026 after an earlier note
  here got it wrong; the earlier note grepped only the two chunks the build
  patches and concluded the feature did not exist.
  The card is not in either patched chunk. It has its own lazily imported one,
  `src/app/dist/renderer/assets/view-QqBtBG74.js` (5.8 KB), which the registry
  chunk dynamic-imports by the `auto-review-approval/view.tsx` key. That chunk
  holds the only occurrence of `proposedRule` in the whole renderer, and it
  consumes it: one helper trims and redacts the rule, the "Always allow" button
  appends it to the allow list, and the settled note reads "A rule always
  allowing this was added to your Auto-review settings".
  It reaches the judge. The append goes through `setAutoReviewInstructions`,
  which persists locally, syncs to the box, and mirrors to the server with
  `PUT /auto-review/policy` at **`scopeKind: "global"`**
  (`main-edge.ts putOpenGrokAutoReviewPolicy(deps, "global", "", ...)`).
  So the rule is real, it is stored, and the server honours it — for every
  coworker, not just the one whose card it was. The allow list is capped at 20
  rules of 1000 characters.
  **What is actually left** is routing that append to the coworker instead: the
  card already has the agent id in scope, and `setAgentAutoReview` already does
  a whole-row coworker PUT. Doing it means patching a third chunk, which the
  patch pipeline and the package verification both currently forbid — they
  accept exactly the roles "registry" and "panel" and at most two chunks.
- Passkey ceremony test (RP `opengrok.app`) — needs the user's go.
- Per-bot desktops (one box, several displays — verdict in
  docs/per-bot-desktops-plan.md), parked next in line.
