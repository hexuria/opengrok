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

die() { echo "dev-instance: $*" >&2; exit 1; }
say() { echo "dev-instance: $*"; }

valid_name() { [[ "$1" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "name must be lowercase letters, digits and dashes: '$1'"; }
dir_of() { echo "$ROOT/$1"; }
db_of() { echo "og_inst_$(echo "$1" | tr - _)"; }
tag_of() { echo "grok-box-inst-$1:local"; }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
read_file() { [ -f "$1" ] && cat "$1" || true; }

port_free() {
  ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# A server port no listener and no other instance (running or stopped) holds, and its gpui-agent
# port: 16000 + the server port, the convention the agents here already used (1485 -> 17485).
pick_port() {
  local p taken
  for ((p = FIRST_PORT; p <= LAST_PORT; p++)); do
    [[ "$RESERVED_PORTS" == *" $p "* ]] && continue
    taken=$(cat "$ROOT"/*/port 2>/dev/null | grep -cx "$p" || true)
    [ "$taken" = 0 ] || continue
    port_free "$p" && port_free $((16000 + p)) && { echo "$p"; return; }
  done
  die "no free port between $FIRST_PORT and $LAST_PORT"
}

psql_admin() {
  docker exec "$PG_CONTAINER" sh -c 'psql -U "$POSTGRES_USER" -d postgres -qAt -c "$1"' sh "$1"
}

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
  chmod 600 "$d/server.env"
}

wait_http() {
  local url=$1 tries=${2:-60}
  for ((i = 0; i < tries; i++)); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" != 000 ] && return 0
    sleep 1
  done
  return 1
}

login() {
  local d=$1 port=$2
  curl -s -c "$d/jar.txt" -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
    -d "{\"email\":\"$(cat "$d/email")\",\"password\":\"$(cat "$d/password")\"}" \
    "http://127.0.0.1:$port/auth/login"
  chmod 600 "$d/jar.txt"
}

agent() {
  local d=$1; shift
  GPUI_AGENT_ADDR="127.0.0.1:$((16000 + $(cat "$d/port")))" GPUI_AGENT_TOKEN=dev-secret \
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
  chmod 700 "$d"

  local port; port=$(read_file "$d/port")
  [ -n "$port" ] || { port=$(pick_port); echo "$port" > "$d/port"; }
  local agent_port=$((16000 + port))

  # Copies, so a `cargo clean` or another agent's rebuild in that worktree cannot pull the binary
  # out from under a running instance, and so `ps` names whose process it is.
  if [ -n "$server" ]; then
    [ -x "$server" ] || die "no server binary at $server (build it with: cargo build -p opengrok)"
    alive "$(read_file "$d/server.pid")" && kill "$(cat "$d/server.pid")" && sleep 2
    cp "$server" "$d/opengrok-$name" && codesign -f -s - "$d/opengrok-$name" 2>/dev/null
  fi
  [ -x "$d/opengrok-$name" ] || die "first up needs --server <path to target/…/opengrok>"
  if [ -n "$app" ]; then
    [ -x "$app" ] || die "no app binary at $app"
    alive "$(read_file "$d/app.pid")" && kill "$(cat "$d/app.pid")" && sleep 2
    # cp keeps the dev signature, so saved logins don't bring up the keychain sheet.
    cp "$app" "$d/nativechat-$name"
  fi

  # The image gets this instance's own tag: the server never pulls a `:local` tag, the owner's
  # `grok-box:local` stays as it is, and `down` finds this instance's containers by that tag.
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

  if ! alive "$(read_file "$d/server.pid")"; then
    port_free "$port" || die "port $port is taken by something else; run down and up again"
    (set -a; . "$d/server.env"; nohup "$d/opengrok-$name" >> "$d/logs/server.log" 2>&1 & echo $! > "$d/server.pid")
    wait_http "http://127.0.0.1:$port/" 180 || die "server did not answer on :$port; see $d/logs/server.log"
    say "server :$port up (pid $(cat "$d/server.pid"))"
  fi

  # A test account of the instance's own: generated, kept 0600 in the instance dir, never echoed.
  if [ ! -f "$d/account-made" ]; then
    echo "$name@instance.test" > "$d/email"
    openssl rand -hex 12 > "$d/password"
    chmod 600 "$d/password"
    (set -a; . "$d/server.env"; "$d/opengrok-$name" admin org create --name "$name" \
      --admin-email "$(cat "$d/email")" --domain instance.test --password "$(cat "$d/password")") \
      > "$d/logs/account.log" 2>&1 || die "could not make the test account; see $d/logs/account.log"
    touch "$d/account-made"
  fi
  [ "$(login "$d" "$port")" = 200 ] || die "the test account could not sign in on :$port"

  if [ -x "$d/nativechat-$name" ] && ! alive "$(read_file "$d/app.pid")"; then
    port_free "$agent_port" || die "gpui-agent port $agent_port is taken"
    # GPUI_AGENT_BACKGROUND keeps the window from taking focus from whoever is at the keyboard.
    # The app finds its themes and assets relative to where it starts, so it starts in this repo.
    cd "$REPO"
    # Its own gpui-agent discovery dir and connect id: the CLI saves its last `--connect` choice
    # there, and in the shared per-user dir one agent's choice would steer another's commands.
    GPUI_AGENT=1 GPUI_AGENT_BACKGROUND=1 GPUI_AGENT_TOKEN=dev-secret \
      GPUI_AGENT_CONNECT_ID="nativechat-$name" GPUI_AGENT_RUNTIME_DIR="$d/gpui-agent" \
      GPUI_AGENT_ADDR="127.0.0.1:$agent_port" GPUI_AGENT_SCREENSHOT_DIR="$d/shots" \
      NATIVECHAT_DATA_DIR="$d/app-data" OPENGROK_BASE_URL="http://127.0.0.1:$port" \
      nohup "$d/nativechat-$name" >> "$d/logs/app.log" 2>&1 &
    echo $! > "$d/app.pid"
    agent "$d" wait >/dev/null 2>&1 || true
    sign_in_app "$d"
    place_window "$d"
    say "app up (pid $(cat "$d/app.pid"), gpui-agent :$agent_port)"
  fi
  status "$name"
}

# The test account is a local test credential on a loopback server, so the app is signed in for
# you; a real password never goes through here.
sign_in_app() {
  local d=$1
  for _ in $(seq 1 20); do
    local tree; tree=$(agent "$d" snapshot 2>/dev/null || true)
    if grep -q '"login-email"' <<<"$tree"; then
      agent "$d" set-value login-email "$(cat "$d/email")" >/dev/null
      agent "$d" set-value login-password "$(cat "$d/password")" >/dev/null
      agent "$d" click login-submit >/dev/null
      return
    fi
    grep -q '"nav-new-chat"' <<<"$tree" && return
    sleep 1
  done
  say "the app did not show its sign-in screen; sign in with: $(cat "$d/email") and the password in $d/password"
}

# The window on an empty AeroSpace workspace of its own, without switching to it.
place_window() {
  local d=$1 pid wid ws
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
  ws=$(aerospace list-workspaces --monitor all --empty | grep -E '^[0-9]+$' | head -1 || true)
  [ -n "$ws" ] || { say "no empty workspace; the window stays where it opened"; return 0; }
  aerospace move-node-to-workspace --window-id "$wid" "$ws" && echo "$ws" > "$d/workspace"
}

status() {
  local names
  if [ -n "${1:-}" ]; then names=$1; else names=$(ls "$ROOT" 2>/dev/null || true); fi
  [ -n "$names" ] || { echo "no instances"; return; }
  for name in $names; do
    local d; d=$(dir_of "$name")
    [ -f "$d/port" ] || continue
    local port; port=$(cat "$d/port")
    local s="down" a="none"
    alive "$(read_file "$d/server.pid")" && s="up pid $(cat "$d/server.pid")"
    [ -x "$d/nativechat-$name" ] && a="down"
    alive "$(read_file "$d/app.pid")" && a="up pid $(cat "$d/app.pid")"
    echo "$name"
    echo "  server   http://127.0.0.1:$port ($s), database $(db_of "$name")"
    echo "  app      $a, gpui-agent 127.0.0.1:$((16000 + port)) (--connect nativechat-$name), workspace $(read_file "$d/workspace")"
    echo "  account  $(read_file "$d/email") (password in $d/password)"
    echo "  computer $(if [ -s "$d/image" ]; then cat "$d/image"; else echo "none (OG_COMPUTER=none)"; fi)"
    echo "  dir      $d"
  done
}

env_of() {
  local name=$1 d; valid_name "$name"; d=$(dir_of "$name")
  [ -f "$d/port" ] || die "no instance $name"
  local port; port=$(cat "$d/port")
  echo "export GPUI_AGENT_ADDR=127.0.0.1:$((16000 + port)) GPUI_AGENT_TOKEN=dev-secret GPUI_AGENT_RUNTIME_DIR=$d/gpui-agent"
  echo "# or, without GPUI_AGENT_ADDR: gpui-agent --connect nativechat-$name <command>"
  echo "export OG_INSTANCE_URL=http://127.0.0.1:$port"
  echo "og() { local tok; tok=\$(awk '\$6==\"og_access\"{print \$7}' $d/jar.txt); curl -s -X \"\$1\" -H \"authorization: Bearer \$tok\" -H 'content-type: application/json' \${3:+-d \"\$3\"} \"http://127.0.0.1:$port\$2\"; }"
}

stop_pid() {
  local pid; pid=$(read_file "$1")
  alive "$pid" || return 0
  kill "$pid"
  for _ in $(seq 1 10); do alive "$pid" || return 0; sleep 1; done
  # A server holding an open event stream can outlive TERM; this pid is ours alone.
  kill -9 "$pid" 2>/dev/null || true
}

# The computers this instance's server made, by the box ids its own database records. Nothing
# else identifies them: Docker names are random, and every server's computers share an image, so
# picking containers by image or tag takes other servers' computers (11 Oct 2026, three were lost
# that way, the owner's among them).
own_boxes() {
  local db=$1 t
  for t in "scoped_computer" "account_computer" "coworker_view"; do
    docker exec "$PG_CONTAINER" sh -c 'psql -U "$POSTGRES_USER" -d "$1" -qAt -c "$2"' sh "$db" \
      "select box_id from $t where box_id is not null and box_id <> ''" 2>/dev/null || true
  done | sort -u
}

# Whether another server's database (not a test one) records this box too. Such a box is never
# ours to remove, whatever our own record says.
claimed_elsewhere() {
  local box=$1 own=$2 db t hit
  for db in $(psql_admin "select datname from pg_database where not datistemplate and datname <> '$own' and datname not like '%gate%' and datname not like '%test%'"); do
    for t in "scoped_computer" "account_computer" "coworker_view"; do
      hit=$(docker exec "$PG_CONTAINER" sh -c 'psql -U "$POSTGRES_USER" -d "$1" -qAt -c "$2"' sh "$db" \
        "select count(*) from $t where box_id is not null and box_id <> '' and (box_id like '$box%' or '$box' like box_id || '%')" 2>/dev/null || echo 0)
      [ "${hit:-0}" != 0 ] && { echo "$db"; return 0; }
    done
  done
  return 1
}

down() {
  local name=$1 d; valid_name "$name"; d=$(dir_of "$name")
  [ -d "$d" ] || die "no instance $name"
  stop_pid "$d/app.pid"
  stop_pid "$d/server.pid"
  local db box other; db=$(db_of "$name")
  for box in $(own_boxes "$db"); do
    [[ "$box" =~ ^[0-9a-f]{12,64}$ ]] || { say "skipped box id '$box': not a container id"; continue; }
    docker inspect "$box" >/dev/null 2>&1 || continue
    if other=$(claimed_elsewhere "$box" "$db"); then
      say "kept computer ${box:0:12}: database $other records it too"
      continue
    fi
    local vols; vols=$(docker inspect --format '{{range .Mounts}}{{if .Name}}{{.Name}} {{end}}{{end}}' "$box")
    docker rm -f "$box" >/dev/null
    # Only the computer's own volumes, which the server names ogbox-<id>-home / -ws.
    for v in $vols; do [[ "$v" == ogbox-* ]] && docker volume rm "$v" >/dev/null; done
    say "computer ${box:0:12} removed with its volumes"
  done
  # Untag only: `docker rmi` without -f never removes a container, and an image other tags or
  # containers use stays.
  [ -s "$d/image" ] && { docker rmi "$(cat "$d/image")" >/dev/null 2>&1 || true; }
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
  for r in nativechat opengrok-server box; do [ -d "$oss/$r" ] && echo "$oss/$r"; done
}

# Worktrees of `repo` on branch gol/<topic>.
topic_worktrees() {
  git -C "$1" worktree list --porcelain | awk -v b="branch refs/heads/gol/$2" '
    /^worktree /{w=substr($0,10)} $0==b{print w}'
}

# Whether a running process lives in `dir`: started there or running a binary from there.
in_use() {
  local dir=$1
  lsof -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | grep -qE "^$dir(/|\$)" && return 0
  ps -axo command= | grep -q "^$dir/" && return 0
  return 1
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
  local repo wt main prs n state url

  [ -d "$(dir_of "$topic")" ] && { plan+=("instance $topic: down"); acts+=("down $topic"); }

  for repo in $(dev_repos); do
    main=$(git -C "$repo" worktree list --porcelain | sed -n '1s/^worktree //p')
    prs=""
    if git -C "$repo" remote get-url origin >/dev/null 2>&1 && command -v gh >/dev/null; then
      prs=$(cd "$repo" && gh pr list --head "$branch" --state all --json number,state,url \
        -q '.[] | "\(.number) \(.state) \(.url)"' 2>/dev/null || true)
    fi
    local merged=0 open=""
    while read -r n state url; do
      [ -n "$n" ] || continue
      [ "$state" = MERGED ] && merged=1
      [ "$state" = OPEN ] && open="$open $n"
      plan+=("$repo: PR #$n is $state ($url)")
    done <<<"$prs"

    local has_branch=0
    git -C "$repo" show-ref --verify --quiet "refs/heads/$branch" && has_branch=1
    local wts; wts=$(topic_worktrees "$repo" "$topic")
    [ "$has_branch" = 0 ] && [ -z "$wts" ] && [ -z "$prs" ] && continue

    if [ "$mode" = finish ] && [ "$merged" = 0 ]; then
      refuse+=("$repo: $branch has no merged PR; use abort to drop it")
    fi
    for n in $open; do
      if [ "$mode" = finish ]; then refuse+=("$repo: PR #$n is still open")
      else plan+=("$repo: close PR #$n"); acts+=("close $repo $n"); fi
    done
    for wt in $wts; do
      [ "$wt" = "$main" ] && { refuse+=("$wt is $repo's main checkout"); continue; }
      [ "$wt" = "$REPO" ] && { refuse+=("$wt is where this script runs from; run it from another checkout"); continue; }
      [ -n "$(git -C "$wt" status --porcelain)" ] && refuse+=("$wt has uncommitted changes")
      in_use "$wt" && refuse+=("$wt has a running process (an app or server started there)")
      plan+=("$wt: cargo clean, git worktree remove"); acts+=("worktree $repo $wt")
    done
    if [ "$has_branch" = 1 ]; then plan+=("$repo: delete local branch $branch"); acts+=("branch $repo"); fi
    if [ "$mode" = abort ] && git -C "$repo" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
      plan+=("$repo: delete remote branch $branch"); acts+=("remote $repo")
    fi
  done

  local tag="grok-box-$topic:local"
  docker image inspect "$tag" >/dev/null 2>&1 && { plan+=("image tag $tag: untag"); acts+=("untag $tag"); }

  [ ${#plan[@]} -gt 0 ] || { say "nothing of $topic to $mode"; return 0; }
  echo "$mode $topic:"; printf '  - %s\n' "${plan[@]}"
  if [ ${#refuse[@]} -gt 0 ]; then
    echo "refused, nothing done:"; printf '  ! %s\n' "${refuse[@]}"; return 1
  fi
  [ "$yes" = 1 ] || { echo "dry run; run again with --yes to do it"; return 0; }

  local a
  for a in "${acts[@]}"; do
    set -- $a
    case "$1" in
      down) down "$2" ;;
      close) (cd "$2" && gh pr close "$3" --comment "Dropped: the topic was aborted.") >/dev/null && say "closed PR #$3" ;;
      worktree)
        [ -f "$3/Cargo.toml" ] && cargo clean --manifest-path "$3/Cargo.toml" 2>&1 | tail -1
        git -C "$2" worktree remove "$3" && say "removed worktree $3" ;;
      branch) git -C "$2" branch -D "$branch" >/dev/null && say "deleted $branch in $2" ;;
      remote) git -C "$2" push -q origin --delete "$branch" && say "deleted origin/$branch in $2" ;;
      untag) docker rmi "$2" >/dev/null 2>&1 && say "untagged $2" ;;
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
  *) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
