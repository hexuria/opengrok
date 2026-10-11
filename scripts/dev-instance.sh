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
#   scripts/dev-instance.sh up <name> --server <opengrok bin> [--app <nativechat bin>]
#                                     [--image <docker image>] [--mock]
#   scripts/dev-instance.sh status [<name>]
#   scripts/dev-instance.sh env <name>       # exports for gpui-agent and the og() curl helper
#   scripts/dev-instance.sh down <name>
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

die() { echo "dev-instance: $*" >&2; exit 1; }
say() { echo "dev-instance: $*"; }

valid_name() { [[ "$1" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "name must be lowercase letters, digits and dashes: '$1'"; }
dir_of() { echo "$ROOT/$1"; }
db_of() { echo "og_inst_$(echo "$1" | tr - _)"; }
tag_of() { echo "grok-box-inst-$1:local"; }
# The gpui-agent port that goes with a server port: 16000 + it, the convention the agents here
# already used (1485 -> 17485).
agent_port_of() { echo $((16000 + $1)); }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
read_or_empty() { [ -f "$1" ] && cat "$1" || true; }

port_free() {
  ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# A server port no listener and no other instance (running or stopped) holds, with its
# gpui-agent port free too.
pick_port() {
  local p taken
  for ((p = FIRST_PORT; p <= LAST_PORT; p++)); do
    [[ "$RESERVED_PORTS" == *" $p "* ]] && continue
    taken=$(cat "$ROOT"/*/port 2>/dev/null | grep -cx "$p" || true)
    [ "$taken" = 0 ] || continue
    port_free "$p" && port_free "$(agent_port_of "$p")" && { echo "$p"; return; }
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
    echo "export PATH=\"/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:/opt/homebrew/bin:\$HOME/.cargo/bin:\$PATH\""
    if [ -s "$d/image" ]; then
      echo "export OG_COMPUTER=docker OG_DOCKER_IMAGE=$(cat "$d/image")"
    else
      echo "export OG_COMPUTER=none"
    fi
    [ -f "$d/mock" ] && echo "export OG_MODEL_DOOR=mock"
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
  local d=$1 port=$2
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
  local name="" server="" app="" image="" mock=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --server) server=$2; shift 2 ;;
      --app) app=$2; shift 2 ;;
      --image) image=$2; shift 2 ;;
      --mock) mock=1; shift ;;
      -*) die "unknown flag $1" ;;
      *) name=$1; shift ;;
    esac
  done
  valid_name "$name"
  local d; d=$(dir_of "$name")
  mkdir -p "$d/logs" "$d/app-data" "$d/shots"

  local port; port=$(read_or_empty "$d/port")
  [ -n "$port" ] || { port=$(pick_port); echo "$port" > "$d/port"; }
  local agent_port; agent_port=$(agent_port_of "$port")

  # Copies, so a `cargo clean` or another agent's rebuild in that worktree cannot pull the binary
  # out from under a running instance, and so `ps` names whose process it is.
  if [ -n "$server" ]; then
    [ -x "$server" ] || die "no server binary at $server (build it with: cargo build -p opengrok)"
    stop_pid "$d/server.pid"
    cp "$server" "$d/opengrok-$name" && codesign -f -s - "$d/opengrok-$name" 2>/dev/null
  fi
  [ -x "$d/opengrok-$name" ] || die "first up needs --server <path to target/…/opengrok>"
  if [ -n "$app" ]; then
    [ -x "$app" ] || die "no app binary at $app"
    stop_pid "$d/app.pid"
    # cp keeps the dev signature, so saved logins don't bring up the keychain sheet.
    cp "$app" "$d/nativechat-$name"
  fi

  # The image gets this instance's own tag, so the server never pulls it (a `:local` tag) and the
  # owner's `grok-box:local` stays as it is. A tag says nothing about whose a container is; `down`
  # goes by the instance's database for that.
  [ "$mock" = 1 ] && touch "$d/mock"
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
    (set -a; . "$d/server.env"; nohup "$d/opengrok-$name" >> "$d/logs/server.log" 2>&1 & echo $! > "$d/server.pid")
    # A fresh database migrates first, and a slow gateway holds up the boot probe.
    wait_http "http://127.0.0.1:$port/" 180 || die "server did not answer on :$port; see $d/logs/server.log"
    say "server :$port up (pid $(cat "$d/server.pid"))"
  fi

  # A test account of the instance's own: generated, kept in the instance dir, never echoed. The
  # server's admin command takes the password as an argument; it is a test credential for a
  # loopback server, there for the moment the command runs.
  if [ ! -f "$d/account-made" ]; then
    echo "$name@instance.test" > "$d/email"
    openssl rand -hex 12 > "$d/password"
    (set -a; . "$d/server.env"; "$d/opengrok-$name" admin org create --name "$name" \
      --admin-email "$(cat "$d/email")" --domain instance.test --password "$(cat "$d/password")") \
      > "$d/logs/account.log" 2>&1 || die "could not make the test account; see $d/logs/account.log"
    touch "$d/account-made"
  fi
  [ "$(login "$d" "$port")" = 200 ] || die "the test account could not sign in on :$port"

  if [ -x "$d/nativechat-$name" ] && ! alive "$(read_or_empty "$d/app.pid")"; then
    port_free "$agent_port" || die "gpui-agent port $agent_port is taken"
    # GPUI_AGENT_BACKGROUND keeps the window from taking focus from whoever is at the keyboard.
    # Its own gpui-agent discovery dir and connect id: the CLI saves its last `--connect` choice
    # there, and in the shared per-user dir one agent's choice would steer another's commands
    # (hexuria/gpui-agent#48). The app finds its themes and assets relative to where it starts,
    # so it starts in this repo.
    (cd "$REPO" && GPUI_AGENT=1 GPUI_AGENT_BACKGROUND=1 GPUI_AGENT_TOKEN=dev-secret \
      GPUI_AGENT_CONNECT_ID="nativechat-$name" GPUI_AGENT_RUNTIME_DIR="$d/gpui-agent" \
      GPUI_AGENT_ADDR="127.0.0.1:$agent_port" GPUI_AGENT_SCREENSHOT_DIR="$d/shots" \
      NATIVECHAT_DATA_DIR="$d/app-data" OPENGROK_BASE_URL="http://127.0.0.1:$port" \
      nohup "$d/nativechat-$name" >> "$d/logs/app.log" 2>&1 & echo $! > "$d/app.pid")
    agent "$d" wait >/dev/null 2>&1 || true
    # Either of these failing leaves an app that runs; `up` still reports it.
    sign_in_app "$d" || true
    place_window "$d" || true
    say "app up (pid $(cat "$d/app.pid"), gpui-agent :$agent_port)"
  fi
  status "$name"
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
    echo "  server   http://127.0.0.1:$port ($s), database $(db_of "$name")"
    echo "  app      $a, gpui-agent 127.0.0.1:$(agent_port_of "$port") (--connect nativechat-$name), workspace $(read_or_empty "$d/workspace")"
    echo "  account  $(read_or_empty "$d/email") (password in $d/password)"
    echo "  computer $(if [ -s "$d/image" ]; then cat "$d/image"; else echo "none (OG_COMPUTER=none)"; fi)"
    echo "  dir      $d"
  done
}

env_of() {
  local name=$1 d port; valid_name "$name"; d=$(dir_of "$name")
  [ -f "$d/port" ] || die "no instance $name"
  port=$(cat "$d/port")
  echo "export GPUI_AGENT_ADDR=127.0.0.1:$(agent_port_of "$port") GPUI_AGENT_TOKEN=dev-secret GPUI_AGENT_RUNTIME_DIR=$d/gpui-agent"
  echo "# or, without GPUI_AGENT_ADDR: gpui-agent --connect nativechat-$name <command>"
  echo "export OG_INSTANCE_URL=http://127.0.0.1:$port"
  echo "og() { local tok; tok=\$(awk '\$6==\"og_access\"{print \$7}' $d/jar.txt); curl -s -X \"\$1\" -H \"authorization: Bearer \$tok\" -H 'content-type: application/json' \${3:+-d \"\$3\"} \"http://127.0.0.1:$port\$2\"; }"
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

# The computers this instance's server made, by the box ids its own database records. Nothing
# else identifies them: Docker names are random, and every server's computers share an image, so
# picking containers by image or tag takes other servers' computers (11 Oct 2026, three were lost
# that way, the owner's among them). Fails when a table it should read can't be read.
own_boxes() {
  local db=$1 t n out
  for t in $COMPUTER_TABLES; do
    n=$(has_table "$db" "$t") || return 1
    [ "$n" = 0 ] && continue
    out=$(pg "$db" "select box_id from $t where box_id is not null and box_id <> ''") || return 1
    [ -z "$out" ] || echo "$out"
  done
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
  local name=$1 d db boxes box other rc unsure=0 vols v
  valid_name "$name"; d=$(dir_of "$name")
  [ -d "$d" ] || die "no instance $name"
  stop_pid "$d/app.pid"
  stop_pid "$d/server.pid"
  db=$(db_of "$name")
  # Without its record the instance can't tell its computers from anyone's, so it stops here
  # with the record kept.
  boxes=$(own_boxes "$db") || die "could not read $db's computers; nothing removed, $db and $d kept"
  for box in $(sort -u <<<"$boxes"); do
    [[ "$box" =~ ^[0-9a-f]{12,64}$ ]] || { say "skipped box id '$box': not a container id"; continue; }
    docker inspect "$box" >/dev/null 2>&1 || continue
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
  # Untag only: `docker rmi` without -f never removes a container, and an image other tags or
  # containers use stays.
  if [ -s "$d/image" ]; then docker rmi "$(cat "$d/image")" >/dev/null 2>&1 || true; fi
  psql_admin "drop database if exists $db with (force)" >/dev/null
  rm -rf "$d"
  say "$name is gone: processes, its own computers, image tag, database and $d"
}

# The repos a topic can span: the main checkouts next to this one, unless DEV_REPOS names them.
dev_repos() {
  if [ -n "${DEV_REPOS:-}" ]; then echo "$DEV_REPOS"; return; fi
  local main oss r
  main=$(git -C "$REPO" worktree list --porcelain | sed -n '1s/^worktree //p')
  oss=$(dirname "$main")
  for r in nativechat opengrok-server box; do
    if [ -d "$oss/$r" ]; then echo "$oss/$r"; fi
  done
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
  local repo wt wts main prs n state head url merged open merged_heads has_branch tip lost

  if [ -d "$(dir_of "$topic")" ]; then plan+=("instance $topic: down"); acts+=("down$TAB$topic"); fi

  while IFS= read -r repo; do
    [ -n "$repo" ] || continue
    main=$(git -C "$repo" worktree list --porcelain | sed -n '1s/^worktree //p')
    prs=""
    if git -C "$repo" remote get-url origin >/dev/null 2>&1 && command -v gh >/dev/null; then
      prs=$(cd "$repo" && gh pr list --head "$branch" --state all --json number,state,headRefOid,url \
        -q '.[] | "\(.number) \(.state) \(.headRefOid) \(.url)"' 2>/dev/null) || prs=""
    fi
    merged=0; open=""; merged_heads=""
    while read -r n state head url; do
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
  done <<<"$(dev_repos)"

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

case "${1:-}" in
  up) shift; up "$@" ;;
  status) shift; status "${1:-}" ;;
  env) shift; env_of "${1:-}" ;;
  down) shift; down "${1:-}" ;;
  finish) shift; wrap_up finish "$@" ;;
  abort) shift; wrap_up abort "$@" ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
