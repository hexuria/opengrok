# NativeChat → OpenGrok client (migration v2)

Logic and phases only. No implementation in this folder.

**Goal:** NativeChat stops calling Gemini (or any provider) with local API keys. It becomes a GPUI window onto **opengrok-server**, which already owns login, coworkers (agents), model pins, transcripts, and inference through **open-ai-gateway**.

**Sources (read-only, 2026-09-13):**

| Repo | Path | Role |
|------|------|------|
| opengrok-server | `/Volumes/goldcoders/hexuria/opengrok-server` | Product: account, coworker, run, policy |
| open-ai-gateway | `/Volumes/goldcoders/hexuria/open-ai-gateway` | Model door: routes, keys, spend |
| opengrok (Electron) | `/Volumes/goldcoders/hexuria/opengrok` | Desktop look/feel; 123-command wire we do **not** copy |
| NativeChat | this repo | GPUI shell, local sqlite sessions, Gemini `LlmProvider` |

**Live stack (dev):** `opengrok` `http://127.0.0.1:1447`, `oag` `http://127.0.0.1:29080`. NativeChat never talks to `:29080`.

**Read order**

1. [00-vocabulary.md](00-vocabulary.md) — do not mix “profile”, “session”, “agent”
2. [01-opengrok-agents.md](01-opengrok-agents.md) — how OpenGrok actually models an agent
3. [02-login-and-inference.md](02-login-and-inference.md) — **do this first**
4. [03-nativechat-gap.md](03-nativechat-gap.md) — what we have vs what we drop
5. [04-schema.md](04-schema.md) — sqlite remodel / cache, not a second product
6. [05-phases.md](05-phases.md) — ordered slices
7. [06-out-of-scope.md](06-out-of-scope.md) — product wishes OpenGrok does not have yet
8. [07-verification.md](07-verification.md) — **gpui-agent on the live window**; no browser

**Verify every phase with gpui-agent** (`GPUI_AGENT=1 cargo run -p nativechat --features agent`). NativeChat is GPUI. A compile, a unit test, or a web screenshot does not close a slice.

**Non-negotiables (from OpenGrok, keep them)**

- The server is the product. Closing NativeChat must not lose a run.
- The app never holds a provider key or an `oag_live_` key.
- A coworker’s model is a **gateway route** (`xai/grok-4.6@sub`), not a key.
- The computer is **assigned by the server**, never named by the client.
- NativeChat is a **new** client: console JSON + AG-UI, not the 123 Electron commands.
