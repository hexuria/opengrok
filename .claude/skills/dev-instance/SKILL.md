---
name: dev-instance
description: Run your own opengrok-server, NativeChat app and Bot computer image to try a feature, without touching the owner's :1447 stack or another agent's instance. Use before any live check of a change in the app, the server or the box.
---

# Your own instance, next to everyone else's

Several agents work on this Mac at once. Each one launches a server and an app to check its
change. Without care they clash:
- one closes everyone's windows;
- two fight over a port or a database;
- one replaces the computer image the owner's real Bots run on.

The rule: **everything you start has your name on it, and nothing else is yours to stop.**

`scripts/dev-instance.sh` does the bookkeeping. This page says how to use it and why each part
is there.

## The owner's stack: never touch it without being asked

| What | Where |
|---|---|
| Main server | `:1447`, LaunchAgent `dev.hexuria.opengrok-pr139`, binary `~/bin/opengrok-pr139`, env `~/.config/opengrok-pr139/env` |
| E2E server | `:1448` |
| Owner's app | default data dir, gpui-agent `127.0.0.1:17426` |
| Bot computers | image `grok-box:local`, containers `ogbox-*` volumes |
| Postgres | container `opengrok-postgres` (port 5455), shared by every server, one database each |

Swap the main server binary, retag `grok-box:local` or restart the owner's app only when the
owner says to, usually after a merge. Keep the old binary to roll back to
(`~/bin/opengrok-pr139.pre-<topic>-<date>`).

## 1. Worktrees, one per repo per topic

```sh
cd /Volumes/goldcoders/OSS/nativechat
git fetch origin main && git worktree add -b gol/<topic> ../nativechat-<topic> origin/main
# the same for opengrok-server (../opengrok-server-<topic>) and box (../box-<topic>) if the change spans them
```

- Never build or edit in another agent's checkout, and never in the main checkout's uncommitted
  work.
- Check `git config user.email` is the hexuria noreply address before the first commit.

## 2. Build

- **Server:** `cargo build -p opengrok` (debug) or `--release`, in the server worktree.
  `-p opengrok-server` builds the library, not the binary.
- **App:** `cargo build -p nativechat --features agent && scripts/sign-dev.sh target/debug/nativechat`.
  Always sign: an unsigned build is a new program to the keychain and brings up the password
  sheet.
- **Computer image**, only if the box changed:
  `docker build -f docker/Dockerfile -t grok-box-<topic>:local .` in the box worktree, which takes
  about 6 minutes. Never `-t grok-box:local`.

No change to one of them? Use main's: `~/bin/opengrok-pr139` is the owner's server built from
main, and `grok-box:local` is main's image.

## 3. Up

**A branch gets its own copy only of what it changes**, and shares the rest:

| The branch changes… | Server | Database | Gateway | Computer image |
|---|---|---|---|---|
| only the app | the shared **baseline**, with an account of its own | the baseline's | shared :29080 | shared |
| the server | **its own** (`--server`) | **its own** | shared :29080 | shared |
| the gateway | its own (`--server`), to point it at the gateway | its own | **its own** (`--gateway`) | shared |
| the box | its own (`--server`) | its own | shared | **its own** (`--image`) |

- **A changed server gets its own database.** Its migrations would change the schema under main
  and every other agent, and two server versions can't share a database.
- **An unchanged one is shared.** Its schema is main's, and accounts keep agents' Bots, chats and
  computers apart.
- **The baseline is never the owner's :1447.** It's a dev server built from main
  (`~/bin/opengrok-pr139`, or `OG_BASELINE_SERVER`).

```sh
# only the app changed: on the shared baseline, started for you if it isn't running
scripts/dev-instance.sh up <name> --app target/debug/nativechat

# the server changed: a server and database of its own
scripts/dev-instance.sh up <name> \
  --server ../opengrok-server-<topic>/target/debug/opengrok \
  --app target/debug/nativechat \
  --image grok-box:local            # or grok-box-<topic>:local; leave it out for no computers
  # --gateway http://127.0.0.1:<port> to use a branch's own gateway; --mock for the stand-in model
```

For a gateway branch, start its gateway from the gateway worktree on ports of its own:
`just pub_port=<p> adm_port=<p+1> serve` (it also shifts on a clash and prints what it chose).
Its database is the gateway's dev Postgres on :5452; a gateway branch with migrations needs its
own there too.

It prints the instance. Everything lives in `~/.cache/nativechat-instances/<name>/`:

| Piece | Yours alone | Why |
|---|---|---|
| Slot | first free in 1460–1499 | Your server's port, when you have one. 1447 and 1448 are never picked. |
| gpui-agent port | 16000 + slot (1460 → 17460) | The owner's app holds 17426. |
| Database | `og_inst_<name>` in `opengrok-postgres`, or the baseline's | The server migrates it on start. |
| Binaries | copied to `opengrok-<name>`, `nativechat-<name>` | `cargo clean` or another rebuild can't pull them from under a running process, and `ps` says whose they are. |
| App data | `app-data/` | Two apps on one sqlite break each other. |
| Image tag | `grok-box-inst-<name>:local` | A `:local` tag is never pulled, and `grok-box:local` stays the owner's. A tag says nothing about whose a container is: see Down. |
| Account | see below | Signed in for you in the app. |
| Window | first empty AeroSpace workspace, no focus taken | The owner keeps working. |

**Accounts.** A fresh database is seeded with one org and its admin, and the app signs in as that
admin. The values come from `~/.config/opengrok-dev/seed.env` (0600, on this Mac only, **never
committed**):

```sh
OG_SEED_ORG_NAME=Goldcoders
OG_SEED_DOMAIN=goldcoders.dev
OG_SEED_EMAIL=ceo@goldcoders.dev
OG_SEED_PASSWORD='…'
```

The file is read as text, never run. Without it, each instance makes a random
`<name>@instance.test` account, with its password in `password`.

On the baseline, each instance gets `<name>@<seed domain>` in the baseline's org, with a password
of its own. So agents never share a login, and `down` can tell its computers apart. The server
has no command that removes an account, so the account stays on the baseline. An instance made
again under the same name gets it back, with a new password.

**A debug app shows its icons only while its worktree exists.** In a debug build, `rust-embed`
reads `assets/` from the checkout it was built in, at run time. Once that worktree is removed,
the copy shows no icons or logos. Keep the worktree until the instance is down (`finish` takes
the instance down first). For an app that must outlive its worktree, the owner's in particular,
use a release build (`cargo build --release -p nativechat --features agent`), which packs
`assets/` into the binary.

The server env is the main server's with `OG_BIND`, `OG_DATABASE_URL` and
`OG_OAUTH_REDIRECT_URI` replaced. The egress tunnel is off, because it is host-wide and a second
one fights the main server's.

Re-running `up <name>` with a new `--server` or `--app` swaps that binary and restarts only that
process. The database and account stay.

## 4. Check it

```sh
eval "$(scripts/dev-instance.sh env <name>)"   # GPUI_AGENT_ADDR/TOKEN/RUNTIME_DIR and og() for this instance
gpui-agent snapshot | grep '"id"'              # stable ids; click <id>, type <id> <text>
gpui-agent --connect nativechat-<name> hello   # the same app found by name instead of port
og GET /coworkers                              # the server as the instance's account
screencapture -x -o -l "$(cat ~/.cache/nativechat-instances/<name>/window)" shot.png
```

- **gpui-agent:** use the CLI from gpui-agent's main branch
  (`cargo install --git https://github.com/hexuria/gpui-agent gpui-agent-cli --force`). The app
  pins the same revision in `Cargo.toml`.
  - `--connect <id>` finds an app by its connect id, with no port to remember.
  - The CLI remembers the last `--connect` in `session.json`, in its runtime dir. In the shared
    per-user dir, one agent's choice would send another agent's bare `gpui-agent hello` to the
    wrong app. So each instance has its own dir (`GPUI_AGENT_RUNTIME_DIR`, set by `env`), and in
    shared shells you pass `--connect` or `--addr` every time.
- **The window:** capture it with `screencapture -l <window id>` (the id is in `window`). Don't
  raise it over the owner's work.
- **Hover:** gpui-agent has no hover. To see a hover-only state, make a throwaway build with that
  state always on, capture it, then rebuild the real one. Never commit the throwaway.
- **Computer screens:** to see one, open it in the app's Computer pane, or ask the server for it
  with `og`.
- **Server tests:** they need their own database whose name ends in `_gate`. The test guard
  refuses any other.
- **A Bot saying "Done":** that isn't proof. Look at the screen or the server's answer, for
  example an `open_url` that was waiting on an approval.

## 5. Down: the instance

```sh
scripts/dev-instance.sh down <name>
```

This:
- stops only the instance's own pids;
- removes the computers **its own database records** (`scoped_computer`, `account_computer`,
  `coworker_view` in `og_inst_<name>`), with their `ogbox-*` volumes;
- untags its image, drops its database and deletes the instance dir.

A computer that another server's database also records is kept, and `down` says so. When `down`
can't read its own record, or can't check another server's database, it removes nothing more
and stops, keeping its database and dir. Run it again once Postgres answers. Test databases
(`*_gate`) aren't checked.

Why the database, and never the image: every server's computers come from the same image, so a
tag points at that same image. `docker ps --filter ancestor=<tag>` matches the image underneath,
not the tag's name. An earlier `down` that picked containers that way deleted three computers on
11 Oct 2026: the owner's main server's, the office session's and the file-tax demo's, each with
its home and workspace volumes. They could not be recovered.

## 6. Done or abandoned: the whole topic

When the PRs are merged:

```sh
scripts/dev-instance.sh finish <topic>         # lists what it will do, changes nothing
scripts/dev-instance.sh finish <topic> --yes   # does it
```

`<topic>` is the branch name after `gol/`. Across the nativechat, opengrok-server, box and open-ai-gateway
checkouts (or `DEV_REPOS`), `finish`:
- takes down the instance named `<topic>`;
- runs `cargo clean`, then `git worktree remove` on each `gol/<topic>` worktree;
- deletes the local branch;
- untags `grok-box-<topic>:local`.

To drop the feature instead, use `abort` (needs `--yes`). It does the same, and also closes the
topic's open PRs and deletes its remote branches. Merged PRs stay.

Both refuse, and change nothing at all, when:
- a worktree has uncommitted changes;
- a process is running from a worktree, such as an app or server started there (the owner's app
  can be one of them);
- the worktree is a repo's main checkout, or the one the script runs from;
- for `finish` only: a branch has no merged PR, a PR is still open, or the local branch has
  commits its merged PR doesn't (they would be lost).

`abort` lists how many commits are on no remote before you say `--yes`.

`scripts/test-dev-instance.sh` checks all of this against the real Docker and Postgres:
- `down` next to a look-alike computer from the same image;
- `down` next to a computer another server records;
- `down` stopping when another database can't be checked;
- `finish` and `abort` on a throwaway repo with a stand-in `gh`: a dirty worktree, no merged PR,
  an open PR, commits after the merge, a busy worktree, `abort` without `--yes`, and both going
  through.

Run it after changing the script. Run an older version of the script against it only with
`TEST_IMAGE` set to a throwaway image.

## Merge groups: a change across repos

A change that spans repos (app, server, box, gateway) merges as a **group**: all of it, in one
sitting, in order, or none of it. One PR merged without its siblings leaves main broken.

- **Each PR's description opens with a "Merge group" block** naming every sibling (`repo#n`) and
  the order, for example box → server → app.
- **Each PR is safe on its own where it can be.** Changes are additive, and the newer side checks
  for what it needs. Then a missing sibling degrades a feature instead of breaking main.
- **`scripts/dev-instance.sh group <topic>`** lists the topic's PRs in every repo, and says
  whether the group is *ready* (every PR open, with green CI), *not ready*, *INCOMPLETE* (some
  merged, some open: merge the rest now), or *fully merged*.
- **Merge only when it says ready**, all in one sitting, in the order given, then run `group`
  again until it says fully merged.
- **If one won't merge, stop and fix it straight away.** Never leave a group half merged.
- `finish <topic>` refuses until every repo's branch has a merged PR.

## Don'ts, each from a real clash

- **`pkill -x nativechat`, `pkill -f target/debug/nativechat`:** these close every agent's app.
  `just run` now stops only the app its own checkout launched. `build.sh` and
  `scripts/install-nativechat-app.sh` still stop every `nativechat`, because the release app runs
  under that same name, so don't run them while others are working.
- **Picking containers by image, tag, name or `ancestor=`, or `docker container prune`,
  `docker volume prune`:** these take other servers' Bot computers and their data. Remove only
  the box ids your own instance's database records, which is what `down` does.
- **`docker tag … grok-box:local` before a merge:** the owner's next computer update would pick
  up your unmerged image.
- **Signing in to the owner's account, or reusing its cookie jar:** use your instance's test
  account.
- **Messaging other agents' sessions** about your instance: don't, unless the owner asks.
- **Testing on the owner's :1447:** use the baseline. Bots made there land on the owner's real
  account.
- **Committing the seed file, or putting its values in a script or this guide:** don't.
