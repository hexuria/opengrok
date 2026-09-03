# Changelog

Built from the checksum-pinned Grok Bot 0.18.0 macOS release, carried toward official 0.29, and measured smoother than official 0.29 on the same conversation.

macOS on Apple Silicon only. This is an unofficial project, not an Anysphere release. Names and module boundaries inferred from a compiled application may differ from the original source.

## Unreleased

- Auto-review: Allow and Block live in a standing-rules modal (inherit / on / off, ten-row list, + to write a rule).
- Agent settings: the Description heading is Role.
- Restore `getCoworkerSpend` so the packaged app creates a window again after #60 dropped the handler.

## What was broken in stock 0.18, and is fixed here

Out of the box, without these fixes, the app is either unusable or badly degraded.

- **The entire app rendered on the CPU.** 0.18's main process calls `app.disableHardwareAcceleration()` unconditionally — every graphics pipeline stage reports `disabled_software`. Now GPU-composited through ANGLE Metal: p95 frame time 17ms → 9ms.
- **You could not get past the sign-in wall without a Cursor account.** A "Choose Other Provider" path now starts the app on Codex, OpenRouter or Claude Code instead.
- **Real trackpad scrolling stalled** while programmatic scrolling measured perfectly smooth — a non-passive wheel listener on the transcript meant every tick waited on main-thread JS before the page could move.
- **The Usage tab was hidden** unless you were signed in to Cursor.
- **The transcript jumped while loading.** Row heights were estimated from per-kind constants, so cached media reflowed the moment it resolved. Official 0.29 and 0.30 still do this. Here the estimate matches the render: fresh-launch scroll displacement 193px → **0**, and a 38,074px history insert under simulated 3G leaves all 64 on-screen rows pixel-identical.
- **Images were fetched at the wrong size**, then scaled. Variants are now requested at the size actually displayed — roughly 9× less over-fetch per tile.
- **The auto-updater would replace the app**, discarding the pinned build. It is disabled at the packaging boundary, along with upstream telemetry.

## What was added

**Inference routing** — Cursor, Claude Code, Codex and OpenRouter, with Grok Bot plugin and MCP tools working across all of them, plus local usage tracking.

**Message management** — per-message delete, multi-select, bookmarks, Collections (a page shared and bookmarked messages land in), self-contained HTML export, and JSON import/export.

**Shareable deep links** — `opengrok://app/v1/message` links that jump-load straight to a message.

**0.29 parity** — jump-to-newest pill, first-layout reveal gate, math rendering in both bubble kinds, per-agent composer drafts.

**0.27 ports** — motion and spring easing, accent colours, notification sounds, the activity taxonomy, and the Messaged-agent event row.

**Local Docker sandbox** — run the box host and execution daemon in an owned local container, bound to loopback, instead of the remote sandbox.

**Diagnostics** — a ⌘⇧D media inspector and an opt-in layout lint with a persistent findings report.

**opengrok-server** — a separate project rebuilding the Cursor-compatible server API so this client can run with no Cursor dependency. The app works today either way.
