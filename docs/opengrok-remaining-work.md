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
| Send | Message sends, reply paints live, composer clears |
| Long turn | Stop bar appears, Stop ends the turn |
| Settings ▸ General | Provider named "Open Grok", address shown |
| Settings ▸ Computer | Roster with the active one marked "Your computer"; this Mac named; Reset present |
| Computer view | Screen draws for an ascii box; honest message for a headless one |
| Log out | Returns to the picker; Codex/Claude CLI sessions untouched |

---

## Task 1 — Regression pass, and prove the flag leak is closed

**Owner: ours. Nothing needed from the server.**

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

## Task 2 — A real login page per provider

**Owner: ours. Highest regression risk on this list.**

Today one page has its title and mark swapped per provider. The tagline is still
upstream's generic Grok Bot line, and nothing tells a person that choosing Codex
or Claude will open a terminal. The decision is for **full per-provider pages** —
own layout, own palette, own copy — not swapped text on a shared page.

**Be honest about the cost.** This is the largest patch surface of anything left,
against a checksum-pinned minified bundle, on the one screen a person cannot get
past if it breaks. A broken login page is a broken app.

**Done when:**

- Each of the four providers has its own page: layout, palette, copy.
- Each says what signing in with it actually does — a terminal opens for the CLI
  providers, a browser for OpenGrok — and reflects the CLI state already
  detected (installed, signed in, neither).
- The back arrow still returns to the picker, from every provider's page.
- **Verified by driving each provider's page over CDP**, not by reading the
  patch: pick each of the four, confirm the page renders, confirm the back arrow
  returns, confirm sign-in still starts the right flow.
- The smoke pass still passes — especially launch and log out, which both cross
  this screen.

---

## Task 3 — `computerError` on the agent rows

**Owner: ours. The server already sends it.**

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
