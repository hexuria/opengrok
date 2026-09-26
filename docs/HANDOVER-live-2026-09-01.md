# Handover — 1 Sept 2026, for Claude Code

Written at the end of a Grok session that ran out of context twice.
`docs/HANDOVER-standing-rules.md` is **stale**: it was written *before* P0–P6
shipped. This file is the current source of truth.

You are not talking to the Grok session. There is no live bus. Read this,
verify the citations, then act. Do not re-investigate standing rules.

---

## 0. Do this first — chat is dead

The user cannot see live replies (needs Cmd+R) and then chat stopped entirely.
The box computer “won’t wake.” **This is one bug, not two, and it is not a
model/box/ascii bug.**

At ~10:18 UTC the OpenGrok **server was rebuilt and restarted** after merging
the standing-rules stacks (`scripts/serve.sh`, pid now **7845**). The Electron
app was **left running**. After that restart:

| Surface | Last success in `/tmp/opengrok-serve.log` | After 10:18:07 |
|---|---|---|
| `GET /events` (SSE live transcript) | **10:10:37** | **zero reconnects** |
| `POST /api/*` (`listAgents`, `getAgentChannels`, `ensureForeverBox`, send) | **10:17:49** | **zero** |
| Connect/gRPC `WatchSandBoxMigration` / DashboardService | still every ~3s | looks “alive” |

So the window still moves, Settings RPCs via Connect still tick, and
`health` is `ok` — but the JSON gateway the chat UI actually uses is dead.
Cmd+R reloads the renderer, reconnects SSE, refetches the transcript: that is
why a reply can exist on the server and only appear after reload.
`ensureForeverBox` is `/api` too, so the sandbox box panel also froze.

**Recovery (do this, in this order, before any code change):**

```sh
# 1. Confirm the hole is still there
rg -n "uri=/events " /tmp/opengrok-serve.log | tail -n 3
curl -sS http://localhost:1447/health; echo
# health pid 7845, isBusy should be false. lastBusyAtMs == startedAt is NORMAL
# (routes.rs:120 hard-codes lastBusyAtMs to started_at_ms — not a stuck clock).

# 2. Relaunch the app IN PLACE. Kill by bundle path, not by name.
pkill -9 -f "Open Grok.app/Contents"; sleep 2
"/Applications/Open Grok.app/Contents/MacOS/Grok Bot" --remote-debugging-port=9223 > /tmp/grok.log 2>&1 &

# 3. Pass: a new GET /events and POST /api/listAgents after the relaunch timestamp.
# Drive the app over CDP on localhost:9223 (NOT 127.0.0.1). Never computer-use.
```

If `/events` still does not return after relaunch, then investigate
`source/node-agent-coordinator/gateway/gateway-client.ts` SSE reconnect
(`reconnectBackoff`, `reconnectGeneration`). Until relaunch is tried, do not
touch box provision, ascii, docker, or the model door.

**Do not** `rm -rf /Applications/Open Grok.app` — that drops Full Disk Access.
In-place rsync only, if you re-package.

---

## 1. Where the repos sit

**Client** `/Volumes/goldcoders/OSS/opengrok` — private `hexuria/opengrok`
- `main` == `origin/main` @ `7c39eb6` Merge PR **#12**
- Stack merged: **#8** modal → **#9** Turn off keeps id (`b4273b8`) → **#10**
  notes (`a566134`) → **#11** session allow (`222a7e3`) → **#12** add-by-hand
  (`7e44b73`)
- Packaged + rsync’d into `/Applications/Open Grok.app` after that merge.
  Live binary is that install, launched with `--remote-debugging-port=9223`.

**Server** `/Volumes/goldcoders/OSS/opengrok-server`
- `main` @ `09019cd` (pins). Standing-rules stack merged: **#6** refuse sudo
  allow (`53d1c01`) → **#7** session allow memory (`56b2887`) → **#8** Ask
  first asks (`3747165`)
- Process: `./target/debug/opengrok` **pid 7845** on `:1447`
  (`OG_BIND=0.0.0.0:1447`). Log: `/tmp/opengrok-serve.log`
- `.env`: `DATABASE_URL` → `127.0.0.1:5455/opengrok_web_verify`
  `OG_PUBLIC_GATEWAY_URL=http://192.168.100.24:1447`
  `OG_MODEL=gpt-5.6-luna` via `OG_GATEWAY_URL=http://127.0.0.1:8080`
  (opencodex proxy, `bun.exe` listening — **up**, not the chat-dead cause)
- Client talks to the LAN URL `http://192.168.100.24:1447`. Privacy-mode
  `ConnectError` in `/tmp/grok.log` is expected: this server is not Cursor’s
  privacy proto.

**Live account / machine** (from this session, still the one Mac)
- account `acct_01a0551e-29ad-74b3-b1d6-236a8122d6d8`
- live machine `mac_01a05bdc9f877e70a09a2cd95f9d6176` (`uriahs-MacBook-Pro.local`)
- enrolled, mode **ask**, standing allow `uname` / `echo` / `whoami`

`docs/HANDOVER-standing-rules.md` investigation (orphaning, 29 rules, 12
machine ids) was real at the time. P1 (keep `machineId` on Turn off) shipped
in client #9. Do not re-copy rules unless the live id is empty again.

---

## 2. Product decisions the user already made

Do **not** re-ask these. Do **not** implement the opposite.

1. **Allow lists stay per-machine**, stored on the server
   (`local_exec_rule` PK `(account_id, machine_id, kind, pattern)`).
   Two laptops ⇒ two different allow/deny lists. **Not** account-wide sync.
2. **No computer picker on desktop.** Desktop Settings is “this Mac”: enrol,
   Turn off, Forget, standing rules all bind to *this* machine’s secret.
3. **Mobile is not built.** The user was describing a *future* phone UI:
   pick which enrolled computer to remote-control. That is the right model.
   Quote: *“we dont have the mobile app yet… if we already build the mobile
   app thats what i would tell the agent.”*
4. **Turn off** = stop commands, keep `machineId`, mode `never`. **Forget** =
   revoke credential. Already implemented (client #9).
5. Auto-review stays **account-wide** (global → coworker). That is a different
   layer from standing rules. P6 mapped `ReviewVerdict::Block` →
   `ReviewOutcome::Ask`. Standing Never remains a hard refuse.

The leftover that is **not** this fire: `enabled_machine`
(`opengrok-server/crates/opengrok-server/src/local_exec.rs:905-928`) still
picks the newest non-revoked daemon with mode ≠ never
(`list_daemons` `order by enrolled_at_ms desc`, postgres.rs:1301-1302).
Always/Never on a card writes to that guess (`conversation.rs:1180-1187`).
Harmless with one Mac. Fix when a second Mac exists or when the phone app
grows a picker. **Do not build a desktop picker now.**

---

## 3. What the user reported in this session (in order)

1. “I want more info about account-wide vs per-machine” → report given, then
   they chose per-machine + phone targets a specific computer.
2. Clarified they did **not** want a desktop picker.
3. “box computer isn’t loading… not being able to wake up from the dead”
   — Hexuria chat, they asked the bot to wake the **sandbox** (ascii box),
   not the Mac. Bot replied it has no computer. Active kind is **ascii**
   (`listOpenGrokComputers` via CDP: ascii `active: true`, local-docker
   available but not active). `getBoxRuntime` mode `opengrok`.
4. “ui is broken if i message i dont see the response i have to press cmd+r”
5. “chat response is not happening what did you fucking do”
6. Asked to coordinate with another Grok session → **cannot**. Then asked
   for this handover to run on Claude Code.

CDP snapshot of the open Hexuria transcript (before relaunch) still showed
the 6:19–6:20 PM “wake up the computer / your sandbox computer not mine”
exchange and the bot claiming it has no machine. That claim is consistent
with tools not being offered because `/api` (ensure/status) is dead, **or**
with `computer_system_prompt` seeing no live box. Re-check after relaunch
before changing provision.

---

## 4. Traps (same as the old handover; they still kill you)

- Renderer patches splice into **one** chunk. Aliases: Dialog `Os`, Switch
  `Ne` (not `Hlt`), Settings pane `Te` is **not** a list scroller.
  File: `scripts/lib/router-renderer-patch.mjs`. Guard:
  `tests/consent-model-patches.test.mjs`.
- New main-edge RPC = handler + `MAIN_METHOD_TABLE` + preload.
- Drive the app with **CDP** (`localhost:9223/json/list`,
  `Runtime.evaluate` `returnByValue: true`). Never computer-use, never
  Chrome-extension tools.
- Package: `npm run package` then
  `rsync -a --delete "dist/Open Grok.app/" "/Applications/Open Grok.app/"`.
- `window.desktop.*` is a frozen contextBridge — cannot stub from CDP.
- Server `GET /events` requires no Origin; health too
  (`gateway/routes.rs:100-123`, `:137-144`).

---

## 5. What you should do

**P0 — restore chat (today, no PR until proven still broken after relaunch)**

1. Relaunch the app as in §0.
2. Watch `/tmp/opengrok-serve.log` for `GET /events` and `POST /api/listAgents`.
3. CDP: send a short message in Hexuria (composer is TipTap `.ProseMirror`,
   `document.execCommand("insertText")`, Enter `KeyboardEvent`). Confirm the
   reply appears **without** Cmd+R.
4. Open the computer pane. `ensureForeverBox` should log again. If ascii is
   still dead *after* `/api` is back, *then* it is a box bug
   (`gateway/conversation.rs` `box_control` / `box_status`,
   `agui/provision.rs`). Not before.

**P1 — only if relaunch does not restore `/events`**

SSE reconnect in `gateway-client.ts` after a server PID change. The client
is supposed to abort after 35s of silence and reconnect forever
(`routes.rs:133-135`). It did not. That is the actual product bug if
relaunch is the only way back.

**Do not**

- Add a desktop machine picker.
- Make standing rules account-wide.
- Re-do P0–P6 standing rules.
- Flip the repo public.
- Restart the server with SIGKILL and leave the app up again without
  relaunching the app. That is how this fire started.

---

## 6. Environment cheat sheet

```sh
# server
curl -sS http://localhost:1447/health
tail -f /tmp/opengrok-serve.log
# db (credentials in opengrok-server/.env — do not paste)
# select machine_id, revoked, mode, allow/deny counts — see old handover §2

# app
curl -sS http://localhost:9223/json/list   # must use hostname localhost
tail -f /tmp/grok.log
```

Brand: **OpenGrok**, bundle `Open Grok.app`, inner binary `Grok Bot`,
user-data `~/Library/Application Support/OpenGrok`.
Schemes: never rename `sand://`; `opengrok://` is ours.
)
