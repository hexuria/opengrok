# Deferred: box.ascii.dev as a remote, persistent Computer

**Status: deferred (2026-08-30).** Planned in full, then held. Execute after
`opengrok-server` is built out — see *Why deferred*. This document is the
complete plan so it can be picked up cold.

## Why deferred

A client-side integration that calls ascii.dev directly is throwaway. The plan's
own endgame is "move behind opengrok-server," so building it in the desktop app
now means porting the box client to TypeScript, wiring coordinator tools and key
handling, then ripping most of it back out once the server owns the box — two
builds for one feature.

The box logic already lives in the right place: `opengrok-server`
`crates/opengrok-box/src/ascii.rs` has a complete, working `AsciiBoxes` behind a
`Computer` trait. Finishing box.ascii.dev **there**, as part of building the
server, is strictly better than a parallel client reimplementation. When the
server ships, the ascii.dev box reaches the client *through* the server, not
around it, and this plan adapts to "route through the server" rather than
"call ascii.dev directly."

## What it is, and the value

A Linux box on ascii.dev's own servers, reached over a small REST API, with
`stop`/`resume` that keeps the disk. The value is a **computer that outlives the
app** with no local emulation — the durability half of what
`opengrok-server/docs/GOAL.md` already sets out to deliver.

**Two facts, corrected during planning (earlier claims were wrong):**

- ascii.dev boxes are **x86_64, not arm64** (`docs.ascii.dev/box/machines`:
  `Architecture | x86_64` for every size). This is *not* an arm64 fix. The win is
  that the box runs on ascii.dev's remote hardware — no local emulation on the
  Mac, and it persists across app close.
- ascii.dev has **no screenshot/click/type API**; our computer-use model does not
  map onto it. Every box ships `lux`, a CLI the agent calls to drive the GUI
  (`lux start "<task>"`), plus an interactive noVNC desktop
  (`POST /boxes/{id}/desktop`, `vnc=1`). GUI automation = the agent running `lux`
  through the ordinary command tool.

## The API (from the working Rust client)

Base `https://ascii.dev/api/box/v1`, `Authorization: Bearer <box_ key>`.

| op | call |
|---|---|
| create | `POST /boxes` `{ttlSeconds}` → `{id\|boxId\|box.id}` |
| run | `POST /boxes/{id}/commands` `{command, timeoutSeconds(1–600), detached:false}` → `{exitCode, stdout, stderr, stdoutTruncated, stderrTruncated, timedOut}` |
| start | same, `{command, detached:true}` → `{processId, running, stdout, stderr, exitCode}` |
| watch | `GET /boxes/{id}/commands/{pid}` → ProcessStatus |
| read | `GET /boxes/{id}/files?path=&encoding=utf8` → `{content}` |
| write | `PUT /boxes/{id}/files` `{path, content, encoding:"utf8"}` |
| expose | `POST /boxes/{id}/host` `{port, title}` → `{url\|previewUrl}` |
| desktop | `POST /boxes/{id}/desktop` `{vnc:1, theme}` → noVNC URL |
| stop/resume | `POST /boxes/{id}/stop` \| `/resume` |
| destroy | `DELETE /boxes/{id}` |

## Integration seams in this client (mapped 2026-08-30)

Two integration points. Build the **routed path first** — it is where the user
runs (Codex/OpenRouter), mirrors the shipped Messages pattern
(`source/node-agent-coordinator/routed-messages-tools.ts`), and sidesteps the
deepest mismatch.

- **Deepest mismatch (defer):** on the Cursor route every computer/shell/file
  tool resolves through `resourceAccessor.get(shellExecutorResource).execute()`,
  and the only implementations stream box-gateway exec frames
  (`source/host/extensions/local-exec/gateway-local-exec-sand-box.ts:42`).
  Making a REST box satisfy that `RemoteExecManager` shape is a large adapter.
- **Routed path has no computer today** — `source/node-agent-coordinator/inference-router.ts:729`
  composes only automations + Messages tools. ascii.dev tools are *additive*
  coordinator-native tools; nothing to refactor.
- **Runtime model:** `source/shared/provider-computers.ts:4` already carries a
  `"box"` kind (`wiring:"live"`); reuse it. `boxRuntimeForScreen` (`:162`)
  currently collapses unknown kinds to `"remote"` — needs a real branch. Also
  `source/shared/box-runtime.ts:1` (`SandBoxRuntime` union + `isSandBoxRuntime`),
  the renderer picker `RBoxRuntime` (`scripts/lib/router-renderer-patch.mjs:140`),
  and `source/electron-main/main-edge.ts:440` (`setBoxRuntime`, which only brings
  up `local-docker` today).
- **API key:** store via `window.desktop.secrets.upsert` — the exact path the
  OpenRouter key uses (`RRouterCredential kind:"key"`). No new mechanism.
- **Screen:** `BoxStatus.vncUrl` is a free-form string (`""` is the tolerated
  headless case). An ascii.dev `vnc=1` URL flows through; the renderer's `abn()`
  noVNC params fit (ascii.dev's stream *is* noVNC); `proxifyBoxVncUrl`
  (`source/node-agent-coordinator/gateway/box-vnc-proxy.ts:34`) passes a
  non-`/vnc.html` URL through untouched. URL expires ~10 min → refresh on poll.

## Execution plan (when resumed)

Adapt each PR to route through opengrok-server if the server is ready; otherwise
they stand as written for a direct-client version.

1. **REST client** — TS port of `AsciiBoxes` (`source/shared/ascii-box.ts`): the
   ten calls, bearer auth, tolerant id parsing, bounded error bodies,
   `timeoutSeconds` clamped 1–600, no Electron imports. Unit-test against mock
   `fetch` with the exact JSON shapes.
2. **Coordinator-native tools + lifecycle** —
   `source/node-agent-coordinator/routed-ascii-box-tools.ts` (`RunCommand`,
   `ReadFile`, `WriteFile`, `ExposePort`), wired into `inference-router.ts:729`.
   `lux` runs through `RunCommand`; a one-line system-prompt note names it.
   Create on first use, persist the box id per agent, `resume` rather than
   duplicate. No per-call consent card (selecting the runtime is the consent).
3. **Runtime picker + Settings key** — the `"box"` kind end to end; `box_` key
   field via secrets; `setBoxRuntime` ensures the box (create/resume).
4. **Desktop screen** — surface `POST /boxes/{id}/desktop?vnc=1` through
   `BoxStatus.vncUrl`; refresh on the box-status poll.

## Verification (when resumed)

- Unit: the REST client (every endpoint, id-parsing variants, error mapping,
  timeout clamp); tool arg→request mapping; lifecycle resumes not duplicates.
- Live over CDP on the OpenRouter route with a real `box_` key: `uname -a`
  returns a Linux x86_64 box; write then read a file; `lux start "…"` drives the
  GUI; the desktop appears in the sidebar; quit and reopen and the same box
  resumes with files intact.
