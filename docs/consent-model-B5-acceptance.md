# Part B5 — client acceptance (consent-model cleanup)

Every claim below was observed in the **packaged app** over CDP
(`--remote-debugging-port=9223`), against the live server on `:1447` with a
real account token — never the recovered tree. Screenshots are in
`docs/consent-model-evidence/`.

## B1 — the Mac switch is one On/Off toggle
`b1b3-computer-tab.png`. Settings ▸ Computer ▸ This computer shows a single
control **"This computer accepts bot commands"** set to **On** — the old
three-way `always/ask/never` "Execution on this computer" is gone. The daemon
gate is on/off (`isLocalToolPermissionOn`: false only for an explicit `never`);
the hold loop, approvalId check, pending-asks store and prompt watcher are
deleted (commit `bd79197`). General tab carries no execution control
(`b4-general-tab.png`).

## B2 — the card writes a server rule, no local flip
Verified in the installed bundle: the shipped card's `OLn` no longer calls
`setPermission` on always/never (0 occurrences of the flip in
`app.asar`; `patchOriginalCardLocalFlip`, commit `6aae70c`). This removed the
bug where pressing **Never** on one command turned the whole Mac switch off.
The resolution still reaches `resolveLocalToolPermission`, so the server writes
the standing rule.

## B3 — standing rules are a visible, deletable list
`b1b3-computer-tab.png` (Standing rules section) + driven test: with three
allow rules live (`uname`, `echo`, `whoami`), each renders as its own row —
"Allow · <command> · Delete" — and the copy reads "Delete one to be asked
again." CDP found **3 Delete buttons**; each calls the live
`DELETE /local-exec/policy/rule {machineId,kind,pattern}` (commit `7f65363`).

## B4 — auto-review, two tiers, wired to the server
`b4-agent-autoreview.png`. The agent-settings screen carries an **"Auto-review
for this agent"** section:
- The badge reads `GET /auto-review/effective`'s `decidedBy` verbatim:
  *"Effective: off — enabled from default, allow from default, block from
  default."* (no client-side precedence).
- **Save** (Off + a block rule) → `PUT /auto-review/policy scopeKind=coworker`
  → the badge flipped to *"enabled from **this agent**, allow from this agent,
  block from this agent."* — proving the coworker row wrote and resolved.
- **Reset to global** → `DELETE /auto-review/policy {coworker}` → badge back to
  *"from default"*, control to *Inherit*. Server state left clean.
- The General-tab save also mirrors to the server as the global tier
  (`scopeKind=global`, commit `14fedd5`). Edges + widget in `b93cec9` / `d16c149`.

## Not yet exercisable from the client (needs the server judge, A2/A3)
- A **block** instruction actually refusing a matching command with the rule
  named in the bot's reply.
- The **auto-review-approval card** raising exactly one card, and its
  "Always allow" routing to the coworker tier.
These are the joint acceptance items, run once the server relaunches with
`OG_AUTO_REVIEW_MOCK_VERDICT`.

`npm run check`: 258 tests green. Commits are lowercase-subject with why-bodies.
