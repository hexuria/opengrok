# OpenGrok server integration — state, split, and what is left

The desktop app can sign in to an `opengrok-server`, be told which computers
that server offers, and report why there is none. It **cannot yet create a bot,
send it a message, or receive a reply.** This document is the shared picture of
why, who owns which half, and what has to land next.

Last updated 31 Aug 2026, after the first end-to-end attempt from the desktop.

The server lives in the separate private repo `opengrok-server` and is built by
a peer session. Nothing here is a contract we may change unilaterally; the
shapes below were agreed between the two sessions and both sides build to them.

## How the two halves meet

Two seams, two tokens, and they are not interchangeable — each rejects the
other's token.

| | Seam A — gateway | Seam B — ConnectRPC |
|---|---|---|
| Shape | `POST /api/<method>` + SSE `GET /events` | `POST /aiserver.v1.GrokBotService/<Method>` |
| Token | gateway bearer, minted by `EnsureSandBox` | account access token (JWT) |
| Used by | the coordinator, for everything the renderer asks | sign-in, computers, account facts |
| Client method list | `source/shared/rpc/coordinator.ts` (90 commands) | `source/electron-main/box/opengrok-signin.ts` |

In OpenGrok mode the coordinator deliberately gives the local inference router
no first refusal (`source/node-agent-coordinator/main.ts`): every renderer
request goes to the gateway, or the app would answer `listAgents` from this
machine and show the wrong roster while looking connected.

The gateway bearer is a **static** server env var (`OG_GATEWAY_BEARER`) with no
TTL and no rotation. The account token expires in **one hour** and is refreshed
through `/oauth/token`; see "Done" below.

## Done — client

- **Provider picker before any provider's login page.** Loading page → "How do
  you want to sign in?" → the chosen provider's page. The gate is a stylesheet
  rule applied before the first paint, because hiding cannot be a reaction to
  an async lookup.
- **Sign-in to an OpenGrok server**, tokens stored, and `adoptExternalCredentials`
  so a session established by another backend is not reported as logged-out
  until the process restarts.
- **Account token refresh.** The stored copy was passed on stale; OpenGrok calls
  now ask for a valid token, which renews via `/oauth/token` before expiry.
  Proven against an already-expired token.
- **Log out** returns to the picker and never touches the Codex or Claude CLI
  sessions on this Mac.
- **Settings**: names the server you signed into, draws the Computer tab icon,
  drops a Usage section that only said there was nothing to track.
- **Computers roster** renders the server's kinds under readable names, greys a
  kind the org has not configured rather than hiding it, and says why there is
  no computer via `computerError`.
- **Gateway failures leave a trace.** They were handed to the renderer, which
  drops them, so a refused gateway produced a silent dead app.
- One settings read per change instead of three per renderer request.

## Done — server (reported by the peer session)

- `listOpenGrokComputers` is real: `local-docker` / `ascii` / `windows365`, with
  `configured` and a label rendered verbatim.
- **box.ascii.dev is proven against the live API**, create and destroy. The
  delete confirm header is `X-Ascii-Confirm-Delete` set to the box id.
- Admin dashboard sets the org's box key; "Test connection" round-trips a
  throwaway box.
- `OG_HOSTED=1` drops `local-docker` from the advertised kinds.
- Request tracing (`OG_TRACE_REQUESTS=1`).

## The blocker: a bot cannot be created or spoken to

First end-to-end attempt from the desktop, 31 Aug 2026. Signed in, gateway
healthy, and pressing Send does **nothing** — no request, no error, composer
never clears, roster stays empty.

Established by observation, not inference:

- The transport is **healthy**. The server's trace shows the coordinator's
  bearer matching, `origin=false`, and `listAgents` returning **200**. Neither
  token theory survived: the gateway bearer never expires, and the account token
  now refreshes.
- `createAgent` **never reaches the gateway.** The coordinator's own failure log
  is empty apart from one unimplemented method.
- The send path runs and declines. Calling the Send button's React `onClick`
  directly, and `form.requestSubmit()`, both complete cleanly and do nothing.
- The shell is mounted and the account is signed in; the roster is empty because
  the account genuinely has no coworkers on that database.

Two candidate causes, both cheap to test and both needing the server:

1. **`WatchSandBoxMigration` returns 400** and is the client's most frequent
   call (22 per boot). If boot or roster hydration gates on it succeeding, that
   loop explains an app that authenticates, gets a clean 200, and still renders
   nothing. The peer offered to stub it to a benign 200.
2. **No coworker exists** for the account, so there may be nothing to create a
   bot from and nothing to address.

## What the server must implement, in the order we need it

Exact client method names. Seam A unless marked. The client already calls all of
these; nothing new is needed here.

**P0 — make one message work end to end**

| Method | Why it is on the critical path |
|---|---|
| `WatchSandBoxMigration` (seam B) | currently 400 on every poll; suspected boot gate |
| `listAgents` | done, returns 200 — needs a non-empty roster to test against |
| `createAgent` | no bot can exist without it |
| `sendPrompt` | the message itself |
| `GET /events` (SSE) | the reply streams here; currently 200 but untested with real traffic |
| `getAgentThread`, `getAgentTranscriptTail`, `openAgentTail` | the transcript the reply is painted into |
| `promptAcceptanceStatus` | the client asks whether a prompt was taken |

A **real model door** is required for this tier to mean anything — the server is
on `OG_MODEL_DOOR=mock`, which echoes rather than answers.

**P1 — the bot can use its computer**

| Method | Why |
|---|---|
| `getForeverBoxStatus`, `ensureForeverBox` | the bot's box, and its state in the UI |
| `handBackForeverBox` | release it |
| `getBoxSecretsStatus`, `setBoxSecrets` | secrets inside the box |

Tool execution itself already runs server-side (proven on Docker), so this tier
is about the client being able to see and manage the box.

**P2 — usage**

`getUsage({periodStart?, periodEnd?})` → `{periodStart, periodEnd, models:[{model,
inputTokens, outputTokens, requests}]}`. Tokens only, never pricing. `models` is
always present, empty when nothing is recorded, so the client can tell "answered,
empty" from "no endpoint". The panel is unbuilt and waits on this.

**Not on the path, deliberately**

`/local-exec/requests` and `/local-exec/responses` 404 on the server. That is the
channel by which a server-run bot would ask *the user's machine* to execute
something — the reverse exec channel we agreed nobody should build casually. The
coordinator starts that supervisor unconditionally, so it polls and gets 404. It
is noise, not a blocker, and it is left in place rather than silently disabled so
the decision stays a shared one.

`GetUserPrivacyMode` returns 400 although the server handles it — a framing
problem on seam B. The client falls back to privacy-safe defaults eleven times
per boot. Not fatal, worth fixing.

## Agreed contracts

**`computerError`**, on two surfaces, flat, never nested:

- `listOpenGrokComputers` → top-level `computerError: {code, message} | null`,
  for account- and org-scoped failures, where no agent exists yet.
- `listAgents` agent rows and the `createAgent` reply → the same field.

Codes: `no_org_key`, `invalid_key`, `quota_exceeded`, `provider_unreachable`,
`provider_error`, `not_supported`, `unknown`. The **code is the contract**; the
message is prose the server may reword, so the client matches on code, keeps an
unrecognised code verbatim, and always shows the message. It **clears to null**
when a computer exists — the key stays present — so "has a computer" is read,
never inferred.

## Product decisions

- `OG_COMPUTER=docker` is **dev and self-host only**. Production offers box,
  Windows 365, later gcloud/EC2/VPS. Bot containers must never run on the API
  host in a hosted deployment.
- Credentials for box and Windows 365 are **per organisation**, set on the
  server's admin dashboard, never entered in the desktop client.
- **One account, one computer**, provisioned **at account creation**, non-fatal —
  a failure never blocks creating an account or signing in. Idle-stop is the cost
  lever, not deferring creation.
- Bots created from the desktop still land on the host account until the gateway
  `/api` path resolves the caller. Seam B already resolves the caller, which is
  why the computers roster is correctly per-account today.

## Verifying

Per `CLAUDE.md`: `npm run package` → `rsync -a --delete "dist/Open Grok.app/"
"/Applications/Open Grok.app/"` (never delete the installed bundle first) →
relaunch with `--remote-debugging-port=9223` → verify over CDP.

Two CDP helpers exist under `docs/research/tools/` (untracked): `cdp-ws-eval.mjs`
evaluates in the renderer, `cdp-drive.mjs` dispatches **real** input events —
necessary because a synthetic `.click()` closes menus instead of activating them.
