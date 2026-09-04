# OpenGrok

A faster, more complete Grok Bot. Use it as a drop-in replacement for the official app.

## Getting started

macOS on Apple Silicon, Node.js 26.5.x. Bring your own Cursor, Codex, or Claude subscription, or an OpenRouter key. A self-hosted [opengrok-server](https://github.com/hexuria/opengrok-server) is optional and is how you reach other models.

## Install

```sh
git clone https://github.com/hexuria/opengrok.git
cd opengrok
git clone git@github.com:hexuria/opengrok-stow.git /tmp/stow
scripts/ci-restore-recovered.sh /tmp/stow
npm ci
npm run package
ditto dist/Open\ Grok.app /Applications/Open\ Grok.app
```

The recovered trees (`frontend/`, generated protos, `src/app/`) live in the private stow archive and are not in a bare clone. `package` typechecks, tests, compiles the Vite UI, signs and verifies. Output is `dist/Open Grok.app`.

`package` signs with a local identity and `--timestamp=none`, so it does not need Apple's timestamp server. For a zip you can give to someone else, `npm run release:macos` re-signs that same `dist/Open Grok.app` with a Developer ID, `--timestamp`, the hardened runtime, and Electron's JIT entitlements, then `ditto -c -k --keepParent` into `dist/Open Grok.zip`. Notarization and stapling stay off unless you set `SAND_NOTARIZE=1` with `SAND_NOTARY_KEYCHAIN_PROFILE` (or an App Store Connect API key file via `SAND_NOTARY_API_KEY_PATH`, `SAND_NOTARY_API_KEY_ID`, and `SAND_NOTARY_ISSUER`).

## How to use

Open **Open Grok**. **Settings → Router** picks who runs new turns.

### Bring your own subscription

No server required. The app uses the account you already have.

| Provider | How you sign in |
|---|---|
| **Cursor** (Grok Bot) | **Sign in with Cursor** — browser OAuth on cursor.com. The app registers `sand://` for the callback. This is the default. |
| **Codex** | Official Codex CLI. Choose Codex in Router; if you are not signed in, the app starts `codex login` (ChatGPT in the browser) and waits until the CLI reports a session. |
| **Claude** | Official Claude Code CLI. Install Claude Code, then `claude /login` (or choose Claude in Router — that opens Terminal for the same command). The app will not switch until `claude auth status` reports signed in. |
| **OpenRouter** | API key, stored in the desktop secrets bridge. |

Claude and Codex both refuse the switch until the official CLI says you are signed in. Codex login is background + browser; Claude login is an interactive TUI, so it needs a real Terminal window.

> **Claude Code.** The login command is correct, and the route works. Routing Claude through a third-party client is very likely against Anthropic's terms, and accounts have been suspended for less. We would not use it ourselves. Codex or OpenRouter are the safer BYOS routes.

### Other models: OpenGrok server + open-ai-gateway

The four providers above are what this app can drive by itself. For anything else, run [opengrok-server](https://github.com/hexuria/opengrok-server) in front of [open-ai-gateway](https://github.com/hexuria/open-ai-gateway), then paste the server URL in **Settings → Router** (and pick **OpenGrok Server** under Computer). Sign-in then happens on *your* server, not Cursor.

You can run that stack **locally** (Docker / `just dev` on this machine) or **remotely**.

- **Local, just you:** a personal Codex or xAI Grok CLI seat on the gateway is still your own usage.
- **Remote or more than one person:** do **not** put a personal Claude / Codex / Cursor / Grok subscription behind the gateway. Providers treat that as intermediating someone else's seat, and that is how accounts get banned. Use **API keys** (or a Team/Enterprise seat bound to one person). Anthropic does not allow Claude.ai / Claude Code credentials in a third-party gateway at all — an Anthropic API key is the only sanctioned Claude path there.

Nothing in this client requires the server. BYOS on Router is enough to use the app.

## Benchmark

Measured live over CDP against official 0.29, same image-heavy conversation, real trackpad input:

| | before this work | **OpenGrok** | official 0.29 |
|---|---|---|---|
| frames over 50ms | 18 | **0** | 1 |
| frames over 100ms | 5 | **0** | 0 |
| worst frame | 134ms | **34ms** | 76ms |

Zero dropped frames, and a worst frame less than half of official's. Official 0.29 also renders box attachments broken on that same conversation; this does not.

What changed since stock 0.18 is in the [changelog](CHANGELOG.md).
