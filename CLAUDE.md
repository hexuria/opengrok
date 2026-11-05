# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NativeChat is a macOS GPUI (`gpui-kit`) desktop client for **opengrok-server**. It is a window onto the server: login, coworkers ("Bots"), chat turns, approvals, the bot's computer, routines, recipes, skills. It never calls model providers and holds no API keys.

```
NativeChat → opengrok-server (:1447, POST /ag-ui etc.) → open-ai-gateway (:29080) → models
```

Sibling checkouts live in `/Volumes/goldcoders/hexuria`: `opengrok-server` (the source of truth for every wire shape), `open-ai-gateway`, and `opengrok` (the reconstructed Electron "Grok Bot" client, used as the UX reference only; do not copy its 123-command wire).

## Commands

```sh
just run [port]                                        # --features agent build, codesign, relaunch against :1447 (or port), with the
                                                       # gpui-agent control plane ON (GPUI_AGENT=1, token dev-secret): a dev build only
OPENGROK_BASE_URL=http://127.0.0.1:1447 cargo run -p nativechat
cargo test --locked -p nativechat --all-features       # what CI runs; plain `cargo test` skips the gpui-agent host tests
cargo test --locked -p nativechat --all-features <name_filter>   # one test / module (without --all-features, host tests silently skip)
cargo clippy --locked -p nativechat --all-targets -- -D warnings                  # CI runs both of these
cargo clippy --locked -p nativechat --all-targets --all-features -- -D warnings
cargo fmt --all -- --check
cargo deny --locked check                              # advisories, licences, sources (deny.toml)
```

- Always sign dev builds (`scripts/sign-dev.sh`, done by `just run`). An unsigned build is a new program to the keychain each time and triggers the OS password sheet for saved logins.
- Env: `OPENGROK_BASE_URL`, `NATIVECHAT_DATA_DIR` (app data + sqlite), `DATABASE_URL`; `.env.local` / `.env` are loaded at startup.
- The dev profile builds the app at opt-level 1 and deps at 3, because GPUI at opt-level 0 is too slow to use.
- The toolchain is pinned in `rust-toolchain.toml` and `Cargo.lock` is committed; CI builds `--locked`.

## Verification

**CI gates every pull request** (`.github/workflows/pr.yml`): `fmt`; `migrations` (a shipped migration is never edited, renamed or deleted: the app runs every migration at launch and panics if one fails, so a schema change is always a new file); `deny` (`cargo deny`, macOS targets only, every ignore carries a reason); `release-features` (gpui-agent must not be reachable from the default build that `build.sh` ships); `test` on macOS (tests with `--all-features`, clippy `-D warnings` for the default build and for `--all-features`). A nightly job re-checks advisories. Dependabot proposes updates weekly; the `gpui` group is merged by a person after running the app.

Lints (`[lints]` in `Cargo.toml`): every `unsafe` block and impl carries a `// SAFETY:` comment that says what makes it sound, stated as it is (including what nothing enforces); nothing prints to stdout; `type_complexity`/`too_many_arguments` are allowed per item, never crate-wide.

**What CI cannot check, and a change still needs:**
- **UI:** a compile or a unit test does not close a UI change. Drive the live window with gpui-agent (`migration-v2/07-verification.md`), and say what you ran in the PR:

  ```sh
  GPUI_AGENT=1 GPUI_AGENT_TOKEN=dev-secret GPUI_AGENT_SCREENSHOT_DIR=/tmp/nativechat-agent \
    cargo run -p nativechat --features agent
  # then the gpui-agent CLI: hello / snapshot / click <stable-id> / type <id> <text> / screenshot --out x.png
  ```

  New surfaces register **stable ids** in `src/agent/host.rs` (catalogue in the `src/agent/mod.rs` doc comment). If a surface can't be clicked from a snapshot, it isn't done. If the in-process screenshot is empty, use shell `screencapture -l <CGWindowID>`.
- **Wire shapes:** a new or changed wire type names the opengrok-server file or PR it was transcribed from (see Conventions), checked against the server checkout.
- **Migrations:** `db::tests::every_past_schema_with_data_in_it_upgrades_to_the_current_one` upgrades every past schema, seeded with two rows in every table (foreign keys on, every column a real value), and requires every row to survive value for value, foreign keys to check clean, and the schema to equal a fresh install's. A migration that drops a table with data on purpose adds it to `INTENDED_DROPS` in the same change.
- **Secrets on disk** go through `private_file::write_private` (a new `0600` file renamed over the old), never `fs::write`; site-login secrets go to the Keychain.
- **A bug fix** comes with a test that fails without the fix; say in the PR that you checked it fails.

## Architecture

- **`src/opengrok/`**: the HTTP/AG-UI client, with no GPUI. `client.rs` has `OpenGrokClient` (cookie session, bearer for `/ag-ui`, all REST routes) and its wiremock tests. `types.rs` holds wire types. `gen_ui.rs` has `TurnAssembler`, which folds the AG-UI event stream into `ChatPart`s (text, tool calls, approval cards, forms, screenshots). `activity.rs` turns tool calls into "what the bot is doing" ticks. `user_form.rs` covers the user-form and computer-handoff HITL cards. `local_exec.rs` is reverse-exec: this Mac enrolled as a machine that runs `user_machine_shell` commands for the server. `pending.rs` covers queued/offline sends.
- **`src/state.rs`**: `AppState`, a single very large GPUI model (~20k lines) owning conversations, coworkers, the running turn, queued sends, approvals, routines, recipes and the computer pane. UI components read it and call its methods, and it spawns the async client calls. Search it by function name rather than reading it top to bottom.
- **`src/components/`**: GPUI views. Parent views pass callbacks into `RenderOnce` children instead of dispatching actions (`docs/state_management.md`).
- **`src/root.rs`**: `RootView`, the top-level window, which also drains the gpui-agent mailbox.
- **`src/send_policy.rs`**: what a send does while the coworker is busy: idle posts; parked (a card waiting on the person) steers, because the server settles the card on the next message; running queues unless the person asked to interrupt.
- **Local persistence**: sqlite via sqlx (`src/db`, `src/services/database.rs`, `migrations/`), run at startup. It is a cache and preferences only; coworkers and transcripts live on the server. Site-login secrets go to the macOS Keychain (`src/site_login/`), never sqlite.
- **`src/agent/`**: behind the `agent` feature; the in-process gpui-agent control plane.
- `main.rs`: tokio runtime, config, migrations, key bindings, window.

Not part of the build: `chat/` (the old multi-provider app), `zed/`, `gpui-component/`, `speechify/` (gitignored references), and `gpui-docs/` (GPUI docs). `migration-v2/` holds the design docs for the move to OpenGrok (vocabulary, phases, what's out of scope).

## Conventions

- **Don't invent wire shapes.** Wire types copy the server's shapes. Add a provenance comment naming the server file or PR the shape came from, and verify it against the `opengrok-server` checkout. A settings control that only lives in local state and doesn't change server behaviour is a bug, not a stub. Disable it until the server route exists.
- Issues are tracked in hexuria/nativechat, each as the "client half" of an hexuria/opengrok-server issue. Server "evidence" requirements (captures in the server's `docs/verification/`) are part of closing such issues.
- Branches are `gol/<topic>` and go through PRs to `main`. Commit subjects are lowercase sentences describing the behaviour from the person's point of view (e.g. "an edited queued send goes back where it was").
- Code comments explain *why* in full sentences, often in product terms. Match that density and voice.
- Tests are inline `#[cfg(test)]` modules next to the code. HTTP behaviour is tested against `wiremock`.
