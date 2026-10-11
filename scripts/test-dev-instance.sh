#!/usr/bin/env bash
# Checks scripts/dev-instance.sh against the real Docker and opengrok-postgres it drives, without a
# server or app: what `down` removes, and what `finish` and `abort` refuse. Needs Docker, the
# `opengrok-postgres` container and the `grok-box:local` image. Leaves nothing behind.
#
#   scripts/test-dev-instance.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DI="${DEV_INSTANCE:-$HERE/dev-instance.sh}"
PG="${OG_PG_CONTAINER:-opengrok-postgres}"
# The image every server's computers share. TEST_IMAGE swaps in a throwaway one, to run an older
# dev-instance.sh against this test without its bugs reaching anyone's computers.
IMG="${TEST_IMAGE:-grok-box:local}"
TMP="$(mktemp -d)"
export NATIVECHAT_INSTANCES="$TMP/instances"
RUN="t$(openssl rand -hex 3)"
FAILS=0

pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
sql() { docker exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$1" -qAt -c "$2"' sh "$1" "$2"; }
exists() { docker inspect "$1" >/dev/null 2>&1; }
vol() { docker volume inspect "$1" >/dev/null 2>&1; }

docker image inspect "$IMG" >/dev/null 2>&1 || { echo "needs the $IMG image"; exit 2; }

# --- down removes the computers its own database records, and nothing else ----------------------
# Every container here comes from grok-box:local, the image every server's computers share, and
# the instance's tag points at it too: the situation in which picking by image took other
# servers' computers.
name="$RUN-down"
db="og_inst_$(echo "$name" | tr - _)"
other="${db}_elsewhere"
mkdir -p "$NATIVECHAT_INSTANCES/$name"
docker tag "$IMG" "grok-box-inst-$name:local"
echo "grok-box-inst-$name:local" > "$NATIVECHAT_INSTANCES/$name/image"
sql postgres "create database $db" >/dev/null
sql postgres "create database $other" >/dev/null
sql "$db" "create table scoped_computer (box_id text)" >/dev/null
sql "$other" "create table scoped_computer (box_id text)" >/dev/null
ours=$(docker create -v "ogbox-$RUN-a-home:/home/box" "$IMG")
lookalike=$(docker create -v "ogbox-$RUN-b-home:/home/box" "$IMG")
shared=$(docker create "$IMG")
sql "$db" "insert into scoped_computer values ('$ours'), ('$shared')" >/dev/null
sql "$other" "insert into scoped_computer values ('$shared')" >/dev/null

"$DI" down "$name" > "$TMP/down.out" 2>&1
check "down removes the computer its database records" "! exists $ours"
check "down removes that computer's own volume" "! vol ogbox-$RUN-a-home"
check "down keeps a computer from the same image it never made" "exists $lookalike"
check "down keeps the look-alike's volume" "vol ogbox-$RUN-b-home"
check "down keeps a computer another server's database records" "exists $shared"
check "down says why it kept that one" "grep -q 'kept computer' $TMP/down.out"
check "down untags its image and leaves $IMG" "! docker image inspect grok-box-inst-$name:local >/dev/null 2>&1 && docker image inspect $IMG >/dev/null 2>&1"
check "down drops its database" "[ \"\$(sql postgres \"select count(*) from pg_database where datname='$db'\")\" = 0 ]"
docker rm -f "$lookalike" "$shared" >/dev/null 2>&1
docker volume rm "ogbox-$RUN-b-home" >/dev/null 2>&1
sql postgres "drop database if exists $other with (force)" >/dev/null

# --- finish and abort -------------------------------------------------------------------------
repo="$TMP/repo"
git init -q -b main "$repo"
git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
topic="$RUN-topic"
wt="$TMP/repo-$topic"
git -C "$repo" worktree add -q -b "gol/$topic" "$wt"
export DEV_REPOS="$repo"

touch "$wt/unsaved"
"$DI" finish "$topic" --yes > "$TMP/finish-dirty.out" 2>&1
code=$?
check "finish refuses a worktree with uncommitted changes" "[ $code = 1 ] && grep -q 'uncommitted changes' $TMP/finish-dirty.out"
check "a refused finish leaves the worktree and branch" "[ -d $wt ] && git -C $repo show-ref --quiet refs/heads/gol/$topic"
rm "$wt/unsaved"

"$DI" finish "$topic" --yes > "$TMP/finish-unmerged.out" 2>&1
code=$?
check "finish refuses a branch with no merged PR" "[ $code = 1 ] && grep -q 'no merged PR' $TMP/finish-unmerged.out && [ -d $wt ]"

"$DI" abort "$topic" > "$TMP/abort-dry.out" 2>&1
code=$?
check "abort without --yes lists the plan and changes nothing" "[ $code = 0 ] && grep -q 'dry run' $TMP/abort-dry.out && [ -d $wt ] && git -C $repo show-ref --quiet refs/heads/gol/$topic"

(cd "$wt" && exec sleep 30) &
holder=$!
sleep 1
"$DI" abort "$topic" --yes > "$TMP/abort-busy.out" 2>&1
code=$?
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
check "abort refuses a worktree a running process started in" "[ $code = 1 ] && grep -q 'running process' $TMP/abort-busy.out && [ -d $wt ]"

"$DI" abort "$topic" --yes > "$TMP/abort.out" 2>&1
check "abort --yes removes the worktree and the branch" "[ ! -d $wt ] && ! git -C $repo show-ref --quiet refs/heads/gol/$topic"

rm -rf "$TMP"
echo
[ "$FAILS" = 0 ] && echo "all passed" || { echo "$FAILS failed"; exit 1; }
