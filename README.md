# OpenGrok

A faster, more complete Grok Bot. Use it as a drop-in replacement for the official app.

## Getting started

macOS on Apple Silicon, Node.js 26.5.x. Sign in with a Cursor account, or with Codex / OpenRouter. Pointing the app at [opengrok-server](https://github.com/hexuria/opengrok-server) is optional; the client runs without it.

## Install

```sh
git clone https://github.com/hexuria/opengrok.git
cd opengrok
npm ci
npm run bootstrap
npm run package
ditto dist/Open\ Grok.app /Applications/Open\ Grok.app
```

`bootstrap` downloads the pinned 0.18.0 release, verifies its SHA-256, and extracts what the build needs. `package` typechecks, tests, compiles, patches the renderer, signs and verifies. Output is `dist/Open Grok.app`.

## How to use

Open **Open Grok**. **Settings → Router** picks the backend for new turns.

| Provider | Sign-in |
|---|---|
| Cursor | your existing Grok Bot/Cursor session (default) |
| Codex | official `codex login` (ChatGPT) |
| OpenRouter | API key, stored in the desktop secrets bridge |
| Claude Code | official `claude /login` — **see below** |

Choosing Claude or Codex opens Terminal for the official CLI login when it is not already signed in, and refuses the switch until that CLI reports a session.

> **Do not use the Claude Code route.** It works, but routing Claude through a third-party client this way is very likely against Anthropic's terms of service, and accounts have been suspended for less. We would not use it ourselves. Reach for Codex or OpenRouter.

To run against your own backend, set the OpenGrok server URL in Router. That is [opengrok-server](https://github.com/hexuria/opengrok-server), a Cursor-compatible API so this client can run with no Cursor dependency. Nothing here requires it.

## Benchmark

Measured live over CDP against official 0.29, same image-heavy conversation, real trackpad input:

| | before this work | **OpenGrok** | official 0.29 |
|---|---|---|---|
| frames over 50ms | 18 | **0** | 1 |
| frames over 100ms | 5 | **0** | 0 |
| worst frame | 134ms | **34ms** | 76ms |

Zero dropped frames, and a worst frame less than half of official's. Official 0.29 also renders box attachments broken on that same conversation; this does not.

What changed since stock 0.18 is in the [changelog](CHANGELOG.md).
