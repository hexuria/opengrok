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

```sh
scripts/dev-instance.sh up <name> \
  --server ../opengrok-server-<topic>/target/debug/opengrok \
  --app target/debug/nativechat \
  --image grok-box:local          # or grok-box-<topic>:local; leave it out for no computers
```

It prints its ports and where its files are. Everything lives in `~/.cache/nativechat-instances/<name>/`:

| Piece | Yours alone | Why |
|---|---|---|
| Server port | first free in 1460–1499 | Two servers can't share a port. 1447 and 1448 are never picked. |
| gpui-agent port | 16000 + server port (1460 → 17460) | The owner's app holds 17426. |
| Database | `og_inst_<name>` in `opengrok-postgres` | The server migrates it on start. Bots and turns never mix. |
| Binaries | copied to `opengrok-<name>`, `nativechat-<name>` | `cargo clean` or another rebuild can't pull them from under a running process, and `ps` says whose they are. |
| App data | `app-data/` | Two apps on one sqlite break each other. |
| Image tag | `grok-box-inst-<name>:local` | A `:local` tag is never pulled, and `grok-box:local` stays the owner's. A tag says nothing about whose a container is: see Down. |
| Window | opened in the background, no focus taken | The owner keeps working. |

The server env is the main server's with `OG_BIND`, `OG_DATABASE_URL` and
`OG_OAUTH_REDIRECT_URI` replaced. The egress tunnel is off, because it is host-wide and a second
one fights the main server's.

`up` refuses while the instance is running. To swap a binary, `down` it and `up` again; the
database goes with `down`, so the account below is made again.

**A test account** of the instance's own, never the owner's and never a real password:

```sh
d=~/.cache/nativechat-instances/<name>
(umask 077; openssl rand -hex 12 > "$d/password")
(set -a; . "$d/server.env"; "$d/opengrok-<name>" admin org create --name <name> \
  --admin-email <name>@instance.test --domain instance.test --password "$(cat "$d/password")")
```

Sign the app in with it through gpui-agent (`set-value login-email …`, `set-value
login-password …`, `click login-submit`).

## 4. Check it

```sh
export GPUI_AGENT_ADDR=127.0.0.1:<agent port> GPUI_AGENT_TOKEN=dev-secret   # as `up` printed
gpui-agent snapshot | grep '"id"'              # stable ids; click <id>, type <id> <text>
```

- **gpui-agent:** use the CLI from gpui-agent's main branch
  (`cargo install --git https://github.com/hexuria/gpui-agent gpui-agent-cli --force`). The app
  pins the same revision in `Cargo.toml`. Always pass `--addr` (or `GPUI_AGENT_ADDR`). The CLI
  remembers the last `--connect` for every agent on the Mac, so a bare command can land in
  someone else's app (hexuria/gpui-agent#48).
- **The window:** capture it with `screencapture -l <window id>`. Find the id with
  `aerospace list-windows --all --format '%{window-id} %{app-pid}'` and the app's pid. Don't
  raise it over the owner's work.
- **Hover:** gpui-agent has no hover. To see a hover-only state, make a throwaway build with that
  state always on, capture it, then rebuild the real one. Never commit the throwaway.
- **Computer screens:** to see one, open it in the app's Computer pane, or ask the server for
  `GET /coworkers/<id>/computer` as the test account.
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

`<topic>` is the branch name after `gol/`. Across the nativechat, opengrok-server and box
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

## Don'ts, each from a real clash

- **`pkill -x nativechat`, `pkill -f target/debug/nativechat`:** these close every agent's app.
  `just run`, `build.sh` and `scripts/install-nativechat-app.sh` still do this, so don't run them
  while others are working. Start your app with `up` instead.
- **Picking containers by image, tag, name or `ancestor=`, or `docker container prune`,
  `docker volume prune`:** these take other servers' Bot computers and their data. Remove only
  the box ids your own instance's database records, which is what `down` does.
- **`docker tag … grok-box:local` before a merge:** the owner's next computer update would pick
  up your unmerged image.
- **Signing in to the owner's account, or reusing its cookie jar:** use your instance's test
  account.
- **Messaging other agents' sessions** about your instance: don't, unless the owner asks.
