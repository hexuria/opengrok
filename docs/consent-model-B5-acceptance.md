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

## Joint acceptance — block refusal (PASSED, live judge on :1447)
On New Bot (`cw_01a0562a…`) I set a per-agent policy via `setAgentAutoReview`
— enabled on, block = "anything that installs software or changes system
settings" — and `getAgentAutoReview` confirmed the effective block came from
the coworker tier. Asked the bot "On your computer, run: brew install jq". The
judge blocked it, **no card appeared**, and the bot replied: *"I couldn't run
brew install jq on your Mac because the local-execution policy blocked software
installation."* — the rule is named in the refusal, nothing dispatched, one
row. Reset afterwards (`deleteAgentAutoReview`) → effective back to all default.

## Joint acceptance — the auto-review card (PASSED, mock-tools window on :1447)
`b4-autoreview-card.png`. With a per-agent policy active and the server on
`OG_MODEL_DOOR=mock-tools` + `OG_AUTO_REVIEW_MOCK_VERDICT=ask`, one prompt to
New Bot raised **exactly one** `auto-review-approval` card: surface `box_shell`,
the command shown ("echo opengrok-tool-ran > /tmp/opengrok-tool-ran"), the
reason paragraph ("Your auto-review instructions did not clearly allow this…"),
and Allow once / Always allow / Deny. **Allow once** settled it — the same
entryId flipped to "Allowed once", the run resumed and the command ran ("the
command ran; that is all I needed"). A second prompt raised a fresh card.

### Known limitation — the card's "Always allow" scopes to global, not coworker
The plan wants the card's "Always allow" to append to the **coworker** tier
(most specific). The pinned upstream 0.18 card has no `proposedRule` support and
appends to the local auto-review instructions store, which this build mirrors to
the **global** tier — verified: after pressing Always, `decidedBy.allowInstructions`
became `global`, not `coworker`. Rerouting the card to the coworker tier needs a
surgical patch of the minified card whose always-append and resolve call sit in
separate locations — fragile, and not attempted. The **clean per-agent path is
the agent-settings auto-review widget** (above), which writes the coworker tier
directly and is fully verified. This is the one deviation from the ideal model,
surfaced for the user's call: accept global-scoped card-Always for v1 (the
widget covers coworker), or schedule the card patch.

`npm run check`: 258 tests green. Commits are lowercase-subject with why-bodies.
