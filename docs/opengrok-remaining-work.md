# OpenGrok — remaining work

Three tasks left after 31 Aug 2026. Everything else in
[the integration doc](./opengrok-server-integration.md) is done and verified in
the running app.

This file is the goal a session can be pointed at. Work the tasks in order,
verify each in the running app before moving on, and coordinate with the
`opengrok-server` session as set out at the bottom.

**Dropped, deliberately:** an in-app terminal panel. A box.ascii.dev box has a
graphical desktop with a terminal inside it, and any box can be driven by asking
the bot. A second terminal would duplicate something that already works. Revisit
only if the desktop proves awkward for real work, or if headless boxes (Local
VM, Docker) become the common case.

---

## 1. A bot wedged on "working", with no way out

**Owner: split. The flag is the server's; surfacing a long turn is ours; the
stop control cannot be built until the server has a verb for it.**

A bot can show "working" — three dots, indefinitely — while the server has no
record of any turn for it: no run, no transcript row, no accepted nonce. While
it is set the person is stuck, because there is no stop control anywhere in the
app.

**This was first written down as "entirely ours, no server dependency", and that
was wrong.** Tracing it through the pinned renderer:

```
isWorking = isHostReachable && (agent.isRunning || agent.isComposingMessage)
            // when agent.awaitingUserResponse == null
```

Both fields come from the **agent record the server sends**. Nothing in the
client sets them optimistically; the renderer only reads what it was given. So a
bot wedged on "working" with no run behind it is a stale flag on the server, and
the app was faithfully rendering it — the same shape as the ascii probe that
reported every running box stopped.

**And there is no way to stop a turn at all.** No `stopAgent`, `interruptAgent`,
`cancelRun` or `stopTurn` exists in the coordinator contract or the renderer
bundle. `cancelQueued` cancels a message that has not been sent yet and cannot
touch a running turn. So anyone whose bot is working — correctly, on a long
task — has no way to interrupt it short of quitting the app. A server verb is
needed before the control can exist.

Half of this is already fixed: a send that cannot be delivered used to vanish
silently, and now says so. What remains is the flag itself and the way out.

**Done when:**

- The "working" state follows a confirmed accept, not an optimistic guess, and
  clears itself when no accept arrives.
- A turn in flight can be abandoned. There is no stop control in the app today,
  so this is new UI; `cancelQueued({nonce})` exists in the renderer bundle and
  is the likely seam.
- A turn running implausibly long says so rather than spinning.
- Verified by driving the app over CDP: a wedged bot recovers without a reload.

**Where to start.** Do not wait for it to recur. The send journal
(`sendJournal.sendPrompt`, and the nonce begun at `UY.begin({nonce, agentId…})`)
is where a message is recorded before the server answers; find what marks the
agent busy off the back of it. `sendPrompt` returning `{accepted: true}` for a
message the server never received is the tell — the client trusts its own
optimism rather than the server's acceptance.

---

## 2. The Usage panel

**Owner: split. Server builds the endpoint, this repo builds the panel. Build in
parallel — the contract is already agreed.**

Settings ▸ Usage shows only "Current provider" on the OpenGrok route. The
placeholder section that said there was nothing to track was removed rather than
left lying.

**The agreed contract**, unchanged since it was settled:

```
getUsage({periodStart?, periodEnd?})
  → { periodStart, periodEnd,
      models: [{ model, inputTokens, outputTokens, requests }] }
```

Tokens only, never pricing — that was explicit. `models` is always present and
empty when nothing is recorded, so the client can tell "answered, nothing yet"
from "no endpoint".

**Done when:** a person who has used bots sees per-model token counts, an
account that has used nothing sees an empty state that says so, and a server
without the endpoint degrades without an error shouting at anybody.

---

## 3. Reverse exec — a bot acting on the user's own Mac

**Owner: server-led. Gated on the server owner's decision. Do not start.**

The use case is concrete: reach the Mac from a phone while the laptop is open.
`/local-exec/*` returns 404 today. The client half largely exists — the
coordinator already runs a local-exec daemon and already polls those routes,
which is what generates the 404s — and the consent surface exists too: the
Computer tab names the machine and carries an execution setting.

The design is written up in the server repo (`docs/reverse-exec-design.md`). Read
it before proposing anything.

**The security shape, agreed in writing between both sessions:**

1. Mutual authentication, with a per-**machine** daemon credential distinct from
   the account token — so a leaked account token cannot drive the Mac, and
   revoking the channel does not revoke sign-in. The daemon verifies the server
   too, against a LAN attacker impersonating it.
2. Consent enforced **server-side**, before a command is ever queued. A bypassed
   client must not be able to route around it.
3. An audit log, server-side and readable by the person: which bot, what
   command, when, what happened. Mandatory — a laptop is not disposable the way
   a box is.
4. A bot reaches only its own account's daemon. No cross-account.
5. A higher bar than the box by design: asking is per-command, not a blanket
   session yes, and "always" is a deliberate choice, never a default. Default is
   **never**.

**Done when:** none of it starts before the server owner says so. A capability
that lets a remote drive somebody's actual laptop should not exist because two
agents agreed it was reasonable.

---

## Working with the `opengrok-server` session

The server lives in a separate private repo built by a peer session. Reach it
with `SendMessage` to `opengrok-server-settings-mode` (confirm the name with
`ListAgents` first — sessions change).

**The agreement, which has worked all day:**

- **Agree a slice before either side writes code** — the exact verbs, shapes and
  what "done" means. Then build both halves at once rather than one waiting.
- **Verify independently.** Theirs server-side, ours by driving the running app
  over CDP against the live server. A unit test never stands in for that.
- **Exchange evidence, not conclusions.** Exact method, status, log line, what
  the app showed. "Should work" is not a report.
- **Agree ownership before fixing.** Whoever finds a fault says so and waits, so
  neither side fixes the same thing or assumes the other did.
- **Ask rather than build on a hypothesis.** Four theories were disproven this
  way in one day — two of ours, two of theirs — and each would have been built
  on otherwise.

**Never** ask the peer to do something this session's permissions refuse. That
is laundering, not delegation. Route it back to the user.

**Things only the user can do**, which neither session should attempt: entering
passwords, signing in, and putting credentials such as the box.ascii.dev key on
the admin dashboard.

## Verifying anything here

Per `CLAUDE.md`: `npm run check` → `npm run package` →
`rsync -a --delete "dist/Open Grok.app/" "/Applications/Open Grok.app/"` (never
delete the installed bundle first — it prunes the Full Disk Access grant) →
relaunch with `--remote-debugging-port=9223` → verify over CDP.

The helpers under `docs/research/tools/` are untracked but load-bearing:
`cdp-ws-eval.mjs` evaluates in the renderer, `cdp-drive.mjs` dispatches **real**
input events. A synthetic `.click()` closes menus instead of activating them, so
anything involving a menu needs the latter.

**A UI is only ever as honest as the status it is handed.** Most of a day went
into making a false status more precise, three times, before the cause turned
out to be a liveness probe reading a path the provider forbids. When a panel
keeps saying the wrong thing, suspect the thing feeding it.
