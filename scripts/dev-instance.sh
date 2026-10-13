#!/usr/bin/env bash
# A server, an app and (optionally) a computer image of your own, next to everyone else's.
#
# Several agents work on this Mac at once, each launching opengrok-server and NativeChat to check
# a change. They used to clash: one `pkill -x nativechat` closed every agent's window, two servers
# wanted :1447, two apps shared one sqlite, a retagged `grok-box:local` changed the owner's real
# computers, and nobody could tell whose Docker containers were whose. An instance here owns,
# under one name, everything it starts: a server port, a database, a copy of each binary, an app
# data dir, a gpui-agent port, an image tag, a test account and an AeroSpace workspace. `down`
# takes all of it away again and touches nothing else.
#
# A branch gets its own copy only of what it changes. One that changes the server gets its own
# server and database (`--server`); one that only changes the app shares the `baseline` instance,
# a server built from main, with an account of its own there. Never the owner's :1447.
#
#   scripts/dev-instance.sh up <name> [--app <nativechat bin>]          # on the shared baseline
#   scripts/dev-instance.sh up <name> --server <opengrok bin> [--app <nativechat bin>]
#                                     [--image <docker image>] [--gateway <url>] [--mock]
#   scripts/dev-instance.sh status [<name>]
#   scripts/dev-instance.sh env <name>       # exports for gpui-agent and the og() curl helper
#   scripts/dev-instance.sh down <name>
#   scripts/dev-instance.sh group <topic>            # the topic's PRs across every repo, and whether to merge
#   scripts/dev-instance.sh finish <topic> [--yes]   # after the merge: instance, worktrees, branch
#   scripts/dev-instance.sh abort <topic> [--yes]    # drop it: the same, plus open PRs and remote branches
#
# The guide is .claude/skills/dev-instance/SKILL.md.
set -euo pipefail
# Everything an instance writes is private to this user: its server env holds the main server's
# keys, and its cookie jar and test password sign in to it.
umask 077

REPO="$(cd "$(dirname "$0")/.." && pwd)"

ROOT="${NATIVECHAT_INSTANCES:-$HOME/.cache/nativechat-instances}"
# The main server's env (gateway, keys). Each instance overrides what would clash and keeps the
# rest. Values are sourced, never printed.
BASE_ENV="${OG_BASE_ENV:-$HOME/.config/opengrok-pr139/env}"
PG_CONTAINER="${OG_PG_CONTAINER:-opengrok-postgres}"
# Ports the owner's own stack holds; an instance never takes them even while they are down.
RESERVED_PORTS=" 1447 1448 "
FIRST_PORT=1460
LAST_PORT=1499
# Where a server records the computers it made (opengrok-server crates/opengrok-store/src/schema.sql:
# the only tables with a `box_id`).
COMPUTER_TABLES="scoped_computer account_computer coworker_view"
TAB=$'\t'
# The shared server app-only branches attach to, started from main's build.
# Its database is `og_inst_<name>` in the shared Postgres, so tests give it a name of their own.
BASELINE="${DEV_BASELINE:-baseline}"
BASELINE_SERVER="${OG_BASELINE_SERVER:-$HOME/bin/opengrok-pr139}"
# Its computers come from main's image, so app-only branches can use theirs.
BASELINE_IMAGE="${OG_BASELINE_IMAGE-grok-box:local}"
# The org and admin a fresh database is seeded with, so everyone signs in the same way. Private to
# this Mac and never committed: OG_SEED_ORG_NAME, OG_SEED_DOMAIN, OG_SEED_EMAIL, OG_SEED_PASSWORD.
# Without it, each instance makes a random account of its own.
SEED_FILE="${OG_SEED_FILE:-$HOME/.config/opengrok-dev/seed.env}"

die() { echo "dev-instance: $*" >&2; exit 1; }
say() { echo "dev-instance: $*"; }

valid_name() { [[ "$1" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "name must be lowercase letters, digits and dashes: '$1'"; }
dir_of() { echo "$ROOT/$1"; }
db_of() { echo "og_inst_$(echo "$1" | tr - _)"; }
tag_of() { echo "grok-box-inst-$1:local"; }
# The gpui-agent port that goes with a server port: 16000 + it, the convention the agents here
# already used (1485 -> 17485).
agent_port_of() { echo $((16000 + $1)); }
# The SSH door to a Bot's screen that goes with it (opengrok-server#386): 20000 + it
# (1460 -> 21460), so an instance's server never takes the owner's 2222.
ssh_port_of() { echo $((20000 + $1)); }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
read_or_empty() { [ -f "$1" ] && cat "$1" || true; }
# The port of the server an instance talks to: its own, or the baseline's for one attached there.
server_port_of() { if [ -f "$1/server_port" ]; then cat "$1/server_port"; else cat "$1/port"; fi; }
attached() { [ -f "$1/attached" ]; }

# One value from the seed file, read as text (it is never sourced): KEY=value, quotes stripped.
seed_value() {
  [ -f "$SEED_FILE" ] || return 0
  sed -n "s/^$1=//p" "$SEED_FILE" | tail -1 | sed -E "s/^'(.*)'\$/\1/; s/^\"(.*)\"\$/\1/"
}
has_seed() { [ -n "$(seed_value OG_SEED_EMAIL)" ] && [ -n "$(seed_value OG_SEED_DOMAIN)" ] && [ -n "$(seed_value OG_SEED_PASSWORD)" ]; }

port_free() {
  ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# A server port no listener and no other instance (running or stopped) holds, with its
# gpui-agent and SSH ports free too.
pick_port() {
  local p taken
  for ((p = FIRST_PORT; p <= LAST_PORT; p++)); do
    [[ "$RESERVED_PORTS" == *" $p "* ]] && continue
    taken=$(cat "$ROOT"/*/port 2>/dev/null | grep -cx "$p" || true)
    [ "$taken" = 0 ] || continue
    port_free "$p" && port_free "$(agent_port_of "$p")" && port_free "$(ssh_port_of "$p")" \
      && { echo "$p"; return; }
  done
  die "no free port between $FIRST_PORT and $LAST_PORT"
}

# One statement in one database of the shared Postgres. Fails, rather than printing nothing, when
# the statement errors.
pg() {
  docker exec "$PG_CONTAINER" sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -qAt -c "$2"' sh "$1" "$2"
}
psql_admin() { pg postgres "$1"; }

server_env() {
  local d=$1 name=$2 port=$3
  {
    echo "# $name: the main server's env with what would clash replaced."
    echo "set -a"
    echo ". \"$BASE_ENV\""
    echo "set +a"
    echo "export OG_BIND=127.0.0.1:$port"
    echo "export OG_DATABASE_URL=\"\$(printf %s \"\$OG_DATABASE_URL\" | sed -E 's#/[^/?]+(\\?|\$)#/$(db_of "$name")\\1#')\""
    echo "export OG_OAUTH_REDIRECT_URI=http://127.0.0.1:$port/connections/callback"
    # The egress tunnel is host-wide: a second server running it would fight the main one.
    echo "export OG_EGRESS_TUNNEL_ENABLED=0 SAND_EGRESS_TUNNEL_ENABLED=0"
    # Its own SSH door to a Bot's screen, and its own host key in the instance's dir.
    echo "export OG_SSH_PORT=$(ssh_port_of "$port") OG_SSH_HOST_KEY=$d/ssh_host_key"
    echo "export PATH=\"/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:/opt/homebrew/bin:\$HOME/.cargo/bin:\$PATH\""
    if [ -s "$d/image" ]; then
      echo "export OG_COMPUTER=docker OG_DOCKER_IMAGE=$(cat "$d/image")"
    else
      echo "export OG_COMPUTER=none"
    fi
    [ -f "$d/mock" ] && echo "export OG_MODEL_DOOR=mock"
    # A branch's own gateway, started from the gateway repo on ports of its own (`just serve`).
    [ -s "$d/gateway" ] && echo "export OG_GATEWAY_URL=$(cat "$d/gateway")"
    true
  } > "$d/server.env"
}

wait_http() {
  local url=$1 tries=${2:-60}
  for ((i = 0; i < tries; i++)); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" != 000 ] && return 0
    sleep 1
  done
  return 1
}

# The password goes to curl on stdin (printf is a shell builtin), never on a command line `ps`
# can read.
login() {
  local d=$1 port; port=$(server_port_of "$1")
  printf '{"email":"%s","password":"%s"}' "$(cat "$d/email")" "$(cat "$d/password")" |
    curl -s -c "$d/jar.txt" -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
      --data-binary @- "http://127.0.0.1:$port/auth/login"
}

agent() {
  local d=$1; shift
  GPUI_AGENT_ADDR="127.0.0.1:$(agent_port_of "$(cat "$d/port")")" GPUI_AGENT_TOKEN=dev-secret \
    GPUI_AGENT_RUNTIME_DIR="$d/gpui-agent" gpui-agent "$@"
}

up() {
  local name="" server="" app="" image="" gateway="" mock=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --server) server=$2; shift 2 ;;
      --app) app=$2; shift 2 ;;
      --image) image=$2; shift 2 ;;
      --gateway) gateway=$2; shift 2 ;;
      --mock) mock=1; shift ;;
      -*) die "unknown flag $1" ;;
      *) name=$1; shift ;;
    esac
  done
  valid_name "$name"
  local d; d=$(dir_of "$name")
  # The baseline is main's server unless told otherwise.
  if [ "$name" = "$BASELINE" ] && [ -z "$server" ] && [ ! -x "$d/opengrok-$name" ]; then
    server=$BASELINE_SERVER
    if [ -z "$image" ] && [ -n "$BASELINE_IMAGE" ]; then image=$BASELINE_IMAGE; fi
  fi
  local own=0
  if [ -n "$server" ] || [ -x "$d/opengrok-$name" ]; then own=1; fi
  if [ "$own" = 0 ] && { [ -n "$image" ] || [ -n "$gateway" ] || [ "$mock" = 1 ]; }; then
    die "--image, --gateway and --mock belong to a server of the instance's own; add --server"
  fi
  mkdir -p "$d/logs" "$d/app-data" "$d/shots"

  # The instance's own slot: its gpui-agent port and, when it has a server, that server's port.
  local port; port=$(read_or_empty "$d/port")
  [ -n "$port" ] || { port=$(pick_port); echo "$port" > "$d/port"; }
  local agent_port; agent_port=$(agent_port_of "$port")

  if [ -n "$app" ]; then
    [ -x "$app" ] || die "no app binary at $app"
    stop_pid "$d/app.pid"
    # cp keeps the dev signature, so saved logins don't bring up the keychain sheet.
    cp "$app" "$d/nativechat-$name"
  fi

  if [ "$own" = 1 ]; then
    up_server "$d" "$name" "$port" "$server" "$image" "$gateway" "$mock"
  else
    attach "$d" "$name"
  fi
  [ "$(login "$d")" = 200 ] || die "$(cat "$d/email") could not sign in on :$(server_port_of "$d")"

  if [ -x "$d/nativechat-$name" ] && ! alive "$(read_or_empty "$d/app.pid")"; then
    port_free "$agent_port" || die "gpui-agent port $agent_port is taken"
    local server_port; server_port=$(server_port_of "$d")
    # GPUI_AGENT_BACKGROUND keeps the window from taking focus from whoever is at the keyboard.
    # Its own gpui-agent discovery dir and connect id, so its records and the CLI's saved
    # `--connect last` are its own (hexuria/gpui-agent#48). The app finds its themes and assets relative to where it starts,
    # so it starts in this repo.
    # One simple command goes into the background, so `$!` is the app itself: backgrounding a
    # `cd && …` list recorded the shell around it, which `down` would stop instead of the app.
    (cd "$REPO" || exit 1
      # An instance's app is there to be driven, a release build too (one that must outlive its
      # worktree): gpui-agent refuses a release build unless this says so.
      GPUI_AGENT=1 GPUI_AGENT_ALLOW_RELEASE=1 GPUI_AGENT_BACKGROUND=1 GPUI_AGENT_TOKEN=dev-secret \
        GPUI_AGENT_CONNECT_ID="nativechat-$name" GPUI_AGENT_RUNTIME_DIR="$d/gpui-agent" \
        GPUI_AGENT_ADDR="127.0.0.1:$agent_port" GPUI_AGENT_SCREENSHOT_DIR="$d/shots" \
        NATIVECHAT_DATA_DIR="$d/app-data" OPENGROK_BASE_URL="http://127.0.0.1:$server_port" \
        nohup "$d/nativechat-$name" >> "$d/logs/app.log" 2>&1 < /dev/null &
      echo $! > "$d/app.pid")
    # Signing in and placing the window go through the app's gpui-agent; an app that never
    # answers is left running as it is. Either step failing leaves an app that runs, and `up`
    # still reports it.
    if agent "$d" wait --timeout-ms 60000 >/dev/null 2>&1; then
      sign_in_app "$d" || true
      place_window "$d" || true
    else
      say "the app's gpui-agent did not answer; it is not signed in or placed"
    fi
    say "app up (pid $(cat "$d/app.pid"), gpui-agent :$agent_port)"
  fi
  status "$name"
}

# A server and database of the instance's own, its org seeded on first start.
up_server() {
  local d=$1 name=$2 port=$3 server=$4 image=$5 gateway=$6 mock=$7
  # Copies, so a `cargo clean` or another agent's rebuild in that worktree cannot pull the binary
  # out from under a running instance, and so `ps` names whose process it is.
  if [ -n "$server" ]; then
    [ -x "$server" ] || die "no server binary at $server (build it with: cargo build -p opengrok)"
    stop_pid "$d/server.pid"
    cp "$server" "$d/opengrok-$name"
    codesign -f -s - "$d/opengrok-$name" 2>/dev/null || true
  fi
  [ -x "$d/opengrok-$name" ] || die "first up needs --server <path to target/…/opengrok>"

  # The image gets this instance's own tag, so the server never pulls it (a `:local` tag) and the
  # owner's `grok-box:local` stays as it is. A tag says nothing about whose a container is; `down`
  # goes by the instance's database for that.
  [ "$mock" = 1 ] && touch "$d/mock"
  [ -n "$gateway" ] && echo "$gateway" > "$d/gateway"
  if [ -n "$image" ]; then
    docker image inspect "$image" >/dev/null 2>&1 || die "no docker image $image"
    docker tag "$image" "$(tag_of "$name")"
    tag_of "$name" > "$d/image"
  fi
  server_env "$d" "$name" "$port"

  local db; db=$(db_of "$name")
  if [ "$(psql_admin "select count(*) from pg_database where datname='$db'")" = 0 ]; then
    psql_admin "create database $db" >/dev/null
    say "database $db created"
  fi

  if ! alive "$(read_or_empty "$d/server.pid")"; then
    port_free "$port" || die "port $port is taken by something else; run down and up again"
    (set -a; . "$d/server.env"; nohup "$d/opengrok-$name" >> "$d/logs/server.log" 2>&1 < /dev/null & echo $! > "$d/server.pid")
    # A fresh database migrates first, and a slow gateway holds up the boot probe.
    wait_http "http://127.0.0.1:$port/" 180 || die "server did not answer on :$port; see $d/logs/server.log"
    say "server :$port up (pid $(cat "$d/server.pid"))"
  fi
  [ -f "$d/account-made" ] || seed_org "$d" "$name"
}

# The database's org and its admin, whom the app signs in as: the seed file's when there is one,
# so every fresh database is signed in to the same way, else a random account of the instance's
# own. The server's admin command takes the password as an argument; it is a test credential for
# a loopback server, there for the moment the command runs.
seed_org() {
  local d=$1 name=$2 org_name domain
  if has_seed; then
    org_name=$(seed_value OG_SEED_ORG_NAME); domain=$(seed_value OG_SEED_DOMAIN)
    [ -n "$org_name" ] || org_name=$domain
    seed_value OG_SEED_EMAIL > "$d/email"
    seed_value OG_SEED_PASSWORD > "$d/password"
  else
    org_name=$name; domain=instance.test
    echo "$name@instance.test" > "$d/email"
    openssl rand -hex 12 > "$d/password"
  fi
  (set -a; . "$d/server.env"; "$d/opengrok-$name" admin org create --name "$org_name" \
    --admin-email "$(cat "$d/email")" --domain "$domain" --password "$(cat "$d/password")") \
    > "$d/logs/account.log" 2>&1 || die "could not make the org; see $d/logs/account.log"
  sed -n 's/^ *org id: *//p' "$d/logs/account.log" | head -1 > "$d/org"
  echo "$domain" > "$d/domain"
  [ -s "$d/org" ] || die "the server made the org but named no org id; see $d/logs/account.log"
  touch "$d/account-made"
}

# An app-only instance on the shared baseline: an account of its own in the baseline's org, so its
# Bots, chats and computers are its own.
attach() {
  local d=$1 name=$2 b; b=$(dir_of "$BASELINE")
  if [ ! -d "$b" ] || ! alive "$(read_or_empty "$b/server.pid")"; then
    say "starting the shared baseline from $BASELINE_SERVER"
    "$0" up "$BASELINE" >/dev/null || die "could not start the baseline; see $b/logs/server.log"
  fi
  echo "$BASELINE" > "$d/attached"
  cat "$b/port" > "$d/server_port"
  [ -f "$d/account-made" ] && return 0
  echo "$name@$(cat "$b/domain")" > "$d/email"
  openssl rand -hex 12 > "$d/password"
  # The baseline outlives its instances, and the server has no command that removes an account, so
  # an instance made again under the same name gets its account back with a new password.
  if ! (set -a; . "$b/server.env"; "$b/opengrok-$BASELINE" admin account create --email "$(cat "$d/email")" \
      --org "$(cat "$b/org")" --name "$name" --password "$(cat "$d/password")") > "$d/logs/account.log" 2>&1; then
    (set -a; . "$b/server.env"; "$b/opengrok-$BASELINE" admin account password --email "$(cat "$d/email")" \
      --password "$(cat "$d/password")") >> "$d/logs/account.log" 2>&1 ||
      die "could not make or reset $(cat "$d/email") on the baseline; see $d/logs/account.log"
  fi
  pg "$(db_of "$BASELINE")" "select id from account_view where lower(email) = lower('$(cat "$d/email")')" > "$d/account"
  [ -s "$d/account" ] || die "the baseline has no account $(cat "$d/email")"
  touch "$d/account-made"
}

# The test account is a local test credential on a loopback server, so the app is signed in for
# you; a real password never goes through here.
sign_in_app() {
  local d=$1 tree
  for _ in $(seq 1 20); do
    tree=$(agent "$d" snapshot 2>/dev/null || true)
    if grep -q '"login-email"' <<<"$tree"; then
      agent "$d" set-value login-email "$(cat "$d/email")" >/dev/null || return 1
      agent "$d" set-value login-password "$(cat "$d/password")" >/dev/null || return 1
      agent "$d" click login-submit >/dev/null || return 1
      return 0
    fi
    grep -q '"nav-new-chat"' <<<"$tree" && return 0
    sleep 1
  done
  say "the app did not show its sign-in screen; sign in with $(cat "$d/email") and the password in $d/password"
}

# The window on an empty AeroSpace workspace of its own, without switching to it.
place_window() {
  local d=$1 pid wid="" ws
  command -v aerospace >/dev/null || return 0
  pid=$(cat "$d/app.pid")
  # The window can take a minute to reach AeroSpace on a busy Mac.
  for _ in $(seq 1 90); do
    wid=$(aerospace list-windows --all --format '%{window-id} %{app-pid}' | awk -v p="$pid" '$2==p{print $1; exit}')
    [ -n "$wid" ] && break
    sleep 1
  done
  [ -n "$wid" ] || { say "the window never reached AeroSpace; it stays where it opens"; return 0; }
  echo "$wid" > "$d/window"
  ws=$(aerospace list-workspaces --monitor all --empty | awk '/^[0-9]+$/{print; exit}')
  [ -n "$ws" ] || { say "no empty workspace; the window stays where it opened"; return 0; }
  if aerospace move-node-to-workspace --window-id "$wid" "$ws"; then
    echo "$ws" > "$d/workspace"
  else
    say "could not move the window to workspace $ws; it stays where it opened"
  fi
}

status() {
  local names name d port s a
  if [ -n "${1:-}" ]; then names=$1; else names=$(ls "$ROOT" 2>/dev/null || true); fi
  [ -n "$names" ] || { echo "no instances"; return; }
  for name in $names; do
    d=$(dir_of "$name")
    [ -f "$d/port" ] || continue
    port=$(cat "$d/port")
    s="down"; a="none"
    alive "$(read_or_empty "$d/server.pid")" && s="up pid $(cat "$d/server.pid")"
    [ -x "$d/nativechat-$name" ] && a="down"
    alive "$(read_or_empty "$d/app.pid")" && a="up pid $(cat "$d/app.pid")"
    echo "$name"
    if attached "$d"; then
      echo "  server   http://127.0.0.1:$(server_port_of "$d") (the shared $BASELINE), database $(db_of "$BASELINE")"
    else
      echo "  server   http://127.0.0.1:$port ($s), database $(db_of "$name")$(if [ -s "$d/gateway" ]; then echo ", gateway $(cat "$d/gateway")"; fi)"
    fi
    echo "  app      $a, gpui-agent 127.0.0.1:$(agent_port_of "$port") (--connect nativechat-$name), workspace $(read_or_empty "$d/workspace")"
    echo "  account  $(read_or_empty "$d/email") (password in $d/password)"
    local img_dir=$d
    if attached "$d"; then img_dir=$(dir_of "$(cat "$d/attached")"); fi
    echo "  computer $(if [ -s "$img_dir/image" ]; then cat "$img_dir/image"; else echo "none (OG_COMPUTER=none)"; fi)"
    echo "  dir      $d"
  done
}

env_of() {
  local name=$1 d port; valid_name "$name"; d=$(dir_of "$name")
  [ -f "$d/port" ] || die "no instance $name"
  port=$(cat "$d/port")
  local server_port; server_port=$(server_port_of "$d")
  echo "export GPUI_AGENT_ADDR=127.0.0.1:$(agent_port_of "$port") GPUI_AGENT_TOKEN=dev-secret GPUI_AGENT_RUNTIME_DIR=$d/gpui-agent"
  echo "# or, without GPUI_AGENT_ADDR: gpui-agent --connect nativechat-$name <command>"
  echo "export OG_INSTANCE_URL=http://127.0.0.1:$server_port"
  echo "og() { local tok; tok=\$(awk '\$6==\"og_access\"{print \$7}' $d/jar.txt); curl -s -X \"\$1\" -H \"authorization: Bearer \$tok\" -H 'content-type: application/json' \${3:+-d \"\$3\"} \"http://127.0.0.1:$server_port\$2\"; }"
}

stop_pid() {
  local pid; pid=$(read_or_empty "$1")
  alive "$pid" || return 0
  kill "$pid"
  for _ in $(seq 1 10); do alive "$pid" || return 0; sleep 1; done
  # A server holding an open event stream can outlive TERM; this pid is ours alone.
  kill -9 "$pid" 2>/dev/null || true
}

# Whether `db` has table `t`: prints 1 or 0, and fails when it can't tell.
has_table() {
  pg "$1" "select count(*) from pg_tables where schemaname = 'public' and tablename = '$2'"
}

# The computers this instance made, by the box ids a database records. Nothing else identifies
# them: Docker names are random, and every server's computers share an image, so picking
# containers by image or tag takes other servers' computers (11 Oct 2026, three were lost that
# way, the owner's among them). With an account, only that account's: its own computers, its
# account-scoped one and its Bots' boxes, never an org's. Fails when a table it should read can't
# be read.
own_boxes() {
  local db=$1 acct=${2:-} t n out where
  for t in $COMPUTER_TABLES; do
    n=$(has_table "$db" "$t") || return 1
    [ "$n" = 0 ] && continue
    where="box_id is not null and box_id <> ''"
    if [ -n "$acct" ]; then
      case "$t" in
        scoped_computer) where="$where and scope = 'account' and scope_id = '$acct'" ;;
        *) where="$where and account_id = '$acct'" ;;
      esac
    fi
    out=$(pg "$db" "select box_id from $t where $where") || return 1
    [ -z "$out" ] || echo "$out"
  done
}

# Whether another account in the same database records this box (an org's computer, or a box two
# accounts share). Answers like `claimed_elsewhere`: 0 yes, 1 no, 2 couldn't look.
claimed_by_another_account() {
  local db=$1 box=$2 acct=$3 t n hit other
  for t in $COMPUTER_TABLES; do
    n=$(has_table "$db" "$t") || return 2
    [ "$n" = 0 ] && continue
    case "$t" in
      scoped_computer) other="not (scope = 'account' and scope_id = '$acct')" ;;
      *) other="account_id <> '$acct'" ;;
    esac
    hit=$(pg "$db" "select count(*) from $t where $other and box_id is not null and box_id <> '' and (box_id like '$box%' or '$box' like box_id || '%')") || return 2
    [ "$hit" != 0 ] && return 0
  done
  return 1
}

# Whether another server's database records this box too. Answers 0 (and the database's name)
# when one does, 1 when none does, and 2 when it couldn't look: a box it couldn't check is
# treated as someone else's. Test databases (named `*_gate`, which opengrok-server's test guard
# requires) are skipped; there are over a thousand and no server runs on them.
claimed_elsewhere() {
  local box=$1 own=$2 dbs db t n hit
  dbs=$(psql_admin "select datname from pg_database where not datistemplate and datname not in ('$own', 'postgres') and datname not like '%\\_gate'") || return 2
  for db in $dbs; do
    for t in $COMPUTER_TABLES; do
      n=$(has_table "$db" "$t") || return 2
      [ "$n" = 0 ] && continue
      hit=$(pg "$db" "select count(*) from $t where box_id is not null and box_id <> '' and (box_id like '$box%' or '$box' like box_id || '%')") || return 2
      [ "$hit" != 0 ] && { echo "$db"; return 0; }
    done
  done
  return 1
}

down() {
  local name=$1 d db acct="" boxes box other rc unsure=0 vols v users
  valid_name "$name"; d=$(dir_of "$name")
  [ -d "$d" ] || die "no instance $name"
  if [ "$name" = "$BASELINE" ]; then
    users=$(grep -lx "$BASELINE" "$ROOT"/*/attached 2>/dev/null | sed "s#^$ROOT/##; s#/attached\$##" | tr '\n' ' ' || true)
    [ -z "$users" ] || die "instances still use the baseline: $users; take them down first"
  fi
  stop_pid "$d/app.pid"
  stop_pid "$d/server.pid"
  if attached "$d"; then
    # Only this instance's account's computers, in the baseline's database, which stays.
    db=$(db_of "$(cat "$d/attached")"); acct=$(read_or_empty "$d/account")
    [ -n "$acct" ] || { rm -rf "$d"; say "$name is gone (it never got an account)"; return 0; }
  else
    db=$(db_of "$name")
  fi
  # Without its record the instance can't tell its computers from anyone's, so it stops here
  # with the record kept.
  boxes=$(own_boxes "$db" "$acct") || die "could not read $db's computers; nothing removed, $db and $d kept"
  for box in $(sort -u <<<"$boxes"); do
    [[ "$box" =~ ^[0-9a-f]{12,64}$ ]] || { say "skipped box id '$box': not a container id"; continue; }
    docker inspect "$box" >/dev/null 2>&1 || continue
    if [ -n "$acct" ]; then
      rc=0; claimed_by_another_account "$db" "$box" "$acct" || rc=$?
      if [ "$rc" = 0 ]; then say "kept computer ${box:0:12}: another account on the $BASELINE uses it"; continue; fi
      if [ "$rc" = 2 ]; then say "kept computer ${box:0:12}: could not check the $BASELINE's other accounts"; unsure=1; continue; fi
    fi
    rc=0; other=$(claimed_elsewhere "$box" "$db") || rc=$?
    if [ "$rc" = 0 ]; then
      say "kept computer ${box:0:12}: database $other records it too"
      continue
    elif [ "$rc" = 2 ]; then
      say "kept computer ${box:0:12}: could not check the other servers' databases"
      unsure=1
      continue
    fi
    vols=$(docker inspect --format '{{range .Mounts}}{{if .Name}}{{.Name}} {{end}}{{end}}' "$box")
    docker rm -f "$box" >/dev/null
    # Only the computer's own volumes, which the server names ogbox-<id>-home / -ws.
    for v in $vols; do
      if [[ "$v" == ogbox-* ]]; then docker volume rm "$v" >/dev/null; fi
    done
    say "computer ${box:0:12} removed with its volumes"
  done
  [ "$unsure" = 0 ] || die "a computer was kept because it couldn't be checked; $db and $d are kept, run down again once Postgres answers"
  if attached "$d"; then
    rm -rf "$d"
    say "$name is gone: its app, its account's computers and $d (the account stays on the $BASELINE, which keeps running)"
    return 0
  fi
  # Untag only: `docker rmi` without -f never removes a container, and an image other tags or
  # containers use stays.
  if [ -s "$d/image" ]; then docker rmi "$(cat "$d/image")" >/dev/null 2>&1 || true; fi
  psql_admin "drop database if exists $db with (force)" >/dev/null
  rm -rf "$d"
  say "$name is gone: processes, its own computers, image tag, database and $d"
}

# The repos a topic can span: the main checkouts next to this one, unless DEV_REPOS names them.
# Fails when it can find neither: a copy of this script outside any checkout once found no repos
# and answered "nothing to finish", which looked like there was nothing to clear. Callers read it
# with `repos=$(dev_repos) || exit 1`, since a failure inside $(…) stops only the subshell.
dev_repos() {
  if [ -n "${DEV_REPOS:-}" ]; then echo "$DEV_REPOS"; return; fi
  local main oss r
  main=$(git -C "$REPO" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p') || true
  [ -n "$main" ] || die "can't find the repos: $REPO is not a checkout. Run the script from one, or set DEV_REPOS"
  oss=$(dirname "$main")
  for r in nativechat opengrok-server box open-ai-gateway; do
    if [ -d "$oss/$r" ]; then echo "$oss/$r"; fi
  done
}

# The PRs of branch `branch` in `repo`, one per line: number, state, head commit, CI (green,
# failing, pending or none) and URL. Nothing when the repo has no GitHub remote.
topic_prs() {
  local repo=$1 branch=$2
  git -C "$repo" remote get-url origin >/dev/null 2>&1 && command -v gh >/dev/null || return 0
  (cd "$repo" && gh pr list --head "$branch" --state all --json number,state,headRefOid,url,statusCheckRollup \
    -q '.[] | "\(.number) \(.state) \(.headRefOid) \(
      [.statusCheckRollup[]? | (.conclusion // .state // "") | ascii_upcase] as $c
      | if ($c | length) == 0 then "none"
        elif any($c[]; test("^(FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE)$")) then "failing"
        elif all($c[]; test("^(SUCCESS|SKIPPED|NEUTRAL)$")) then "green"
        else "pending" end) \(.url)"' 2>/dev/null) || true
}

# Worktrees of `repo` on branch gol/<topic>, one per line.
topic_worktrees() {
  git -C "$1" worktree list --porcelain | awk -v b="branch refs/heads/gol/$2" '
    /^worktree /{w=substr($0,10)} $0==b{print w}'
}

# Whether a running process lives in `dir`: started there, or running a binary from there. The
# listings are read whole before matching, so an early-exiting match can't break the pipe and
# read as "nobody".
in_use() {
  local dir=$1 cwds cmds
  cwds=$(lsof -d cwd -Fn 2>/dev/null | sed -n 's/^n//p') || true
  cmds=$(ps -axo command=) || true
  printf '%s\n%s\n' "$cwds" "$cmds" | awk -v d="$dir" '$0 == d || index($0, d "/") == 1 {found = 1} END {exit !found}'
}

# finish: the topic is merged; clear away everything it left. abort: drop the topic, merged or
# not, including its open PRs and remote branches. Both list everything first, refuse on anything
# that might be someone's work, and act only with --yes.
wrap_up() {
  local mode=$1; shift
  local topic="" yes=0
  while [ $# -gt 0 ]; do
    case "$1" in --yes) yes=1; shift ;; -*) die "unknown flag $1" ;; *) topic=$1; shift ;; esac
  done
  [[ "$topic" =~ ^[a-z0-9][a-z0-9._-]{1,50}$ ]] || die "topic must be the gol/<topic> branch name: '$topic'"
  local branch="gol/$topic" plan=() refuse=() acts=()
  local repo wt wts main prs n state head url merged open merged_heads has_branch tip lost repos
  repos=$(dev_repos) || exit 1

  if [ -d "$(dir_of "$topic")" ]; then plan+=("instance $topic: down"); acts+=("down$TAB$topic"); fi

  while IFS= read -r repo; do
    [ -n "$repo" ] || continue
    main=$(git -C "$repo" worktree list --porcelain | sed -n '1s/^worktree //p')
    prs=$(topic_prs "$repo" "$branch")
    merged=0; open=""; merged_heads=""
    while read -r n state head _ url; do
      [ -n "$n" ] || continue
      if [ "$state" = MERGED ]; then merged=1; merged_heads="$merged_heads $head"; fi
      if [ "$state" = OPEN ]; then open="$open $n"; fi
      plan+=("$repo: PR #$n is $state ($url)")
    done <<<"$prs"

    has_branch=0
    if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then has_branch=1; fi
    wts=$(topic_worktrees "$repo" "$topic")
    [ "$has_branch" = 0 ] && [ -z "$wts" ] && [ -z "$prs" ] && continue

    if [ "$mode" = finish ] && [ "$merged" = 0 ]; then
      refuse+=("$repo: $branch has no merged PR; use abort to drop it")
    fi
    for n in $open; do
      if [ "$mode" = finish ]; then
        refuse+=("$repo: PR #$n is still open")
      else
        plan+=("$repo: close PR #$n"); acts+=("close$TAB$repo$TAB$n")
      fi
    done
    while IFS= read -r wt; do
      [ -n "$wt" ] || continue
      if [ "$wt" = "$main" ]; then refuse+=("$wt is $repo's main checkout"); continue; fi
      if [ "$wt" = "$REPO" ]; then refuse+=("$wt is where this script runs from; run it from another checkout"); continue; fi
      if [ -n "$(git -C "$wt" status --porcelain)" ]; then refuse+=("$wt has uncommitted changes"); fi
      if in_use "$wt"; then refuse+=("$wt has a running process (an app or server started there)"); fi
      plan+=("$wt: cargo clean, git worktree remove"); acts+=("worktree$TAB$repo$TAB$wt")
    done <<<"$wts"
    if [ "$has_branch" = 1 ]; then
      tip=$(git -C "$repo" rev-parse "refs/heads/$branch")
      if [ "$mode" = finish ]; then
        # Merged means the branch as the PR had it. A commit made after that exists only here,
        # and deleting the branch would lose it.
        local covered=0
        for head in $merged_heads; do
          if git -C "$repo" merge-base --is-ancestor "$tip" "$head" 2>/dev/null; then covered=1; fi
        done
        if [ "$covered" = 0 ] && [ "$merged" = 1 ]; then
          refuse+=("$repo: $branch has commits its merged PR doesn't (fetch, or push and merge them first)")
        fi
      else
        lost=$(git -C "$repo" rev-list --count "$tip" --not --remotes 2>/dev/null || echo "?")
        [ "$lost" = 0 ] || plan+=("$repo: $lost commit(s) on $branch are on no remote and will be lost")
      fi
      plan+=("$repo: delete local branch $branch"); acts+=("branch$TAB$repo")
    fi
    if [ "$mode" = abort ] && git -C "$repo" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
      plan+=("$repo: delete remote branch $branch"); acts+=("remote$TAB$repo")
    fi
  done <<<"$repos"

  # Your own build of the box for this topic, and an instance tag `down` didn't get to.
  local tag
  for tag in "grok-box-$topic:local" "$(tag_of "$topic")"; do
    if docker image inspect "$tag" >/dev/null 2>&1; then plan+=("image tag $tag: untag"); acts+=("untag$TAB$tag"); fi
  done

  [ ${#plan[@]} -gt 0 ] || { say "nothing of $topic to $mode"; return 0; }
  echo "$mode $topic:"; printf '  - %s\n' "${plan[@]}"
  if [ ${#refuse[@]} -gt 0 ]; then
    echo "refused, nothing done:"; printf '  ! %s\n' "${refuse[@]}"; return 1
  fi
  [ "$yes" = 1 ] || { echo "dry run; run again with --yes to do it"; return 0; }
  [ ${#acts[@]} -gt 0 ] || return 0

  local act kind a b
  for act in "${acts[@]}"; do
    IFS="$TAB" read -r kind a b <<<"$act"
    case "$kind" in
      down) down "$a" ;;
      close) (cd "$a" && gh pr close "$b" --comment "Dropped: the topic was aborted.") >/dev/null && say "closed PR #$b" ;;
      worktree)
        if [ -f "$b/Cargo.toml" ]; then cargo clean --manifest-path "$b/Cargo.toml" 2>&1 | tail -1; fi
        git -C "$a" worktree remove "$b" && say "removed worktree $b" ;;
      branch) git -C "$a" branch -D "$branch" >/dev/null && say "deleted $branch in $a" ;;
      remote) git -C "$a" push -q origin --delete "$branch" && say "deleted origin/$branch in $a" ;;
      untag) docker rmi "$a" >/dev/null 2>&1 && say "untagged $a" ;;
    esac
  done
}

# A change that spans repos merges as a group, all of it in one sitting, or none of it: one PR
# merged without its siblings leaves main broken. This lists the topic's PRs in every repo and
# says which of those the group is.
group() {
  local topic=${1:-} branch repo prs n state head ci url
  local total=0 merged=0 open=0 green=0 noted=()
  [[ "$topic" =~ ^[a-z0-9][a-z0-9._-]{1,50}$ ]] || die "topic must be the gol/<topic> branch name: '$topic'"
  branch="gol/$topic"
  local repos; repos=$(dev_repos) || exit 1
  echo "gol/$topic:"
  while IFS= read -r repo; do
    [ -n "$repo" ] || continue
    prs=$(topic_prs "$repo" "$branch")
    if [ -z "$prs" ]; then
      if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch" ||
        git -C "$repo" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
        echo "  $(basename "$repo"): branch $branch, no PR"
        noted+=("$(basename "$repo") has the branch but no PR")
      fi
      continue
    fi
    while read -r n state head ci url; do
      [ -n "$n" ] || continue
      total=$((total + 1))
      case "$state" in
        MERGED) merged=$((merged + 1)); echo "  $(basename "$repo") #$n merged  $url" ;;
        OPEN) open=$((open + 1)); [ "$ci" = green ] && green=$((green + 1)); echo "  $(basename "$repo") #$n open, CI $ci  $url" ;;
        *) echo "  $(basename "$repo") #$n $(echo "$state" | tr '[:upper:]' '[:lower:]')  $url" ;;
      esac
    done <<<"$prs"
  done <<<"$repos"
  if [ "$total" = 0 ]; then
    echo "no PRs"
  elif [ "$merged" -gt 0 ] && [ "$open" -gt 0 ]; then
    echo "INCOMPLETE: $merged merged, $open still open. Merge the rest now, in order, or main is broken."
    return 1
  elif [ "$open" = 0 ]; then
    echo "fully merged"
  elif [ "$green" = "$open" ] && [ ${#noted[@]} = 0 ]; then
    echo "ready: every PR is open with green CI. Merge them all in one sitting, in the order their descriptions give."
  else
    echo "not ready: $((open - green)) of $open open PRs without green CI${noted[0]+; ${noted[*]}}"
    return 1
  fi
}

case "${1:-}" in
  up) shift; up "$@" ;;
  status) shift; status "${1:-}" ;;
  env) shift; env_of "${1:-}" ;;
  down) shift; down "${1:-}" ;;
  group) shift; group "${1:-}" ;;
  finish) shift; wrap_up finish "$@" ;;
  abort) shift; wrap_up abort "$@" ;;
  *) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 2 ;;
esac
