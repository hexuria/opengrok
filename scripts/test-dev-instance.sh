#!/usr/bin/env bash
# Checks scripts/dev-instance.sh against the real Docker and opengrok-postgres it drives, without a
# server or app: what `down` removes and keeps, and what `finish` and `abort` refuse and do. Needs
# Docker, the `opengrok-postgres` container and the `grok-box:local` image. Cleans up after itself,
# interrupted or not. GitHub is a stand-in `gh` on PATH; nothing reaches github.com.
#
#   scripts/test-dev-instance.sh
#
# No `set -e`: a failing check is counted and the rest still run, so one run shows every failure.
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
# The baseline's database is `og_inst_<name>` in the shared Postgres: never the real one's name.
export DEV_BASELINE="$RUN-base"
# No seed unless a check gives one, so a seed file on this Mac doesn't change what is checked.
export OG_SEED_FILE="$TMP/no-seed.env"
FAILS=0
# What this run made, one per line. Files, not arrays: `container` and `database` run inside
# $(...), and a subshell's array changes never reach the cleanup.
MADE="$(mktemp -d)"
touch "$MADE/containers" "$MADE/databases"

pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
sql() { docker exec "$PG" sh -c 'psql -X -U "$POSTGRES_USER" -d "$1" -qAt -c "$2"' sh "$1" "$2"; }
exists() { docker inspect "$1" >/dev/null 2>&1; }
vol() { docker volume inspect "$1" >/dev/null 2>&1; }
db_exists() { [ "$(sql postgres "select count(*) from pg_database where datname='$1'")" = 1 ]; }
container() { local c; c=$(docker create "$@" "$IMG") && echo "$c" >> "$MADE/containers" && echo "$c"; }
database() { sql postgres "create database $1" >/dev/null && echo "$1" >> "$MADE/databases"; }

cleanup() {
  local c d f
  # Stand-in servers and apps a failed check left running.
  for f in "$NATIVECHAT_INSTANCES"/*/server.pid "$NATIVECHAT_INSTANCES"/*/app.pid; do
    [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null
  done
  while read -r c; do docker rm -f "$c" >/dev/null 2>&1; done < "$MADE/containers"
  docker volume ls -q | grep "^ogbox-$RUN-" | xargs -r docker volume rm >/dev/null 2>&1
  while read -r d; do sql postgres "drop database if exists $d with (force)" >/dev/null 2>&1; done < "$MADE/databases"
  docker images --format '{{.Repository}}:{{.Tag}}' | grep -E "^grok-box-(inst-)?$RUN" | xargs -r docker rmi >/dev/null 2>&1
  rm -rf "$TMP" "$MADE"
}
trap cleanup EXIT

docker image inspect "$IMG" >/dev/null 2>&1 || { echo "needs the $IMG image"; exit 2; }

# An instance dir and database as `up` leaves them, without a server: the database records the
# given containers in the given table.
fake_instance() {
  local name=$1 db; db="og_inst_$(echo "$name" | tr - _)"
  mkdir -p "$NATIVECHAT_INSTANCES/$name"
  docker tag "$IMG" "grok-box-inst-$name:local"
  echo "grok-box-inst-$name:local" > "$NATIVECHAT_INSTANCES/$name/image"
  database "$db"
  echo "$db"
}

# --- down removes the computers its own database records, and nothing else ----------------------
# Every container here comes from one image, the one every server's computers share, and the
# instance's tag points at it too: the situation in which picking by image took other servers'
# computers on 11 Oct 2026.
name="$RUN-down"
db=$(fake_instance "$name")
other="og_${RUN}_elsewhere"
database "$other"
sql "$db" "create table scoped_computer (box_id text); create table account_computer (box_id text); create table coworker_view (box_id text)" >/dev/null
sql "$other" "create table scoped_computer (box_id text)" >/dev/null
ours=$(container -v "ogbox-$RUN-a-home:/home/box")
ours_account=$(container)
ours_coworker=$(container)
lookalike=$(container -v "ogbox-$RUN-b-home:/home/box")
foreign=$(container)
shared=$(container)
sql "$db" "insert into scoped_computer values ('$ours'), ('$shared'); insert into account_computer values ('$ours_account'); insert into coworker_view values ('${ours_coworker:0:12}')" >/dev/null
sql "$other" "insert into scoped_computer values ('$foreign'), ('$shared')" >/dev/null

"$DI" down "$name" > "$TMP/down.out" 2>&1
check "down removes the computer its scoped_computer records" "! exists $ours"
check "down removes that computer's own volume" "! vol ogbox-$RUN-a-home"
check "down removes the computer its account_computer records" "! exists $ours_account"
check "down removes the computer its coworker_view records by short id" "! exists $ours_coworker"
check "down keeps a computer from the same image that nothing records" "exists $lookalike && vol ogbox-$RUN-b-home"
check "down keeps a computer only another server's database records" "exists $foreign"
check "down keeps a computer another server's database records too" "exists $shared && grep -q 'kept computer ${shared:0:12}' $TMP/down.out"
check "down untags its image and leaves $IMG" "! docker image inspect grok-box-inst-$name:local >/dev/null 2>&1 && docker image inspect $IMG >/dev/null 2>&1"
check "down drops its database and dir" "! db_exists $db && [ ! -d $NATIVECHAT_INSTANCES/$name ]"
sql postgres "drop database if exists $other with (force)" >/dev/null

# --- down fails closed: a database it can't check stops it, with everything kept -----------------
# Another server's table whose box_id isn't text: the query errors, as a broken or locked database
# would. Before, an error read as "nobody else records it" and the computer went.
name="$RUN-closed"
db=$(fake_instance "$name")
broken="og_${RUN}_broken"
database "$broken"
sql "$db" "create table scoped_computer (box_id text)" >/dev/null
sql "$broken" "create table scoped_computer (box_id integer)" >/dev/null
mine=$(container)
sql "$db" "insert into scoped_computer values ('$mine')" >/dev/null
"$DI" down "$name" > "$TMP/closed.out" 2>&1
code=$?
check "down refuses when it can't check another server's database" "[ $code != 0 ] && grep -q 'could not check' $TMP/closed.out"
check "a refused down keeps the computer, its database and its dir" "exists $mine && db_exists $db && [ -d $NATIVECHAT_INSTANCES/$name ]"
sql postgres "drop database if exists $broken with (force)" >/dev/null
"$DI" down "$name" > "$TMP/closed2.out" 2>&1
check "down goes through once the other databases can be checked" "! exists $mine && ! db_exists $db"

# --- up starts the server and app it names, and down stops exactly those ----------------------
# Stand-ins: a "server" that answers HTTP on OG_BIND, an "app" that sleeps. A backgrounded
# `cd && …` once recorded the shell around the app, not the app, and held up's output open.
mkdir -p "$TMP/fake"
cat > "$TMP/fake/server" <<'EOF'
#!/usr/bin/env bash
# A stand-in opengrok: `admin` commands log their arguments and answer the way the server prints
# them (an account goes into account_view, as the real one does); otherwise it creates
# account_view, as migrations would, and answers every request 200, so sign-ins succeed.
db=$(printf %s "$OG_DATABASE_URL" | sed -E 's#.*/([^/?]+).*#\1#')
q() { docker exec opengrok-postgres sh -c 'psql -X -U "$POSTGRES_USER" -d "$1" -qAt -c "$2"' sh "$db" "$1"; }
if [ "${1:-}" = admin ]; then
  echo "$*" >> "$FAKE_ADMIN_LOG"
  email=""; prev=""
  for a in "$@"; do [ "$prev" = --email ] && email=$a; prev=$a; done
  case "$2 $3" in
    "org create") echo "org created"; echo "  org id:   org_$db" ;;
    "account create")
      [ "$(q "select count(*) from account_view where email = '$email'")" = 0 ] || { echo "error: $email exists"; exit 1; }
      q "insert into account_view values ('acc_$RANDOM$RANDOM', '$email', 'free', false, 0)" >/dev/null
      echo "account created" ;;
  esac
  exit 0
fi
q "create table if not exists account_view (id text primary key, email text not null unique, plan text not null, trial boolean not null, updated_at_ms bigint not null)" >/dev/null
exec python3 -I -c '
import http.server, os
class OK(http.server.BaseHTTPRequestHandler):
    def answer(self):
        self.send_response(200); self.send_header("content-length", "0"); self.end_headers()
    do_GET = do_POST = answer
h, p = os.environ["OG_BIND"].rsplit(":", 1)
http.server.HTTPServer((h, int(p)), OK).serve_forever()'
EOF
printf '#!/usr/bin/env bash\nexec sleep 300\n' > "$TMP/fake/app"
chmod +x "$TMP/fake/server" "$TMP/fake/app"
echo "OG_DATABASE_URL=postgres://u:p@127.0.0.1:5455/unused" > "$TMP/fake/env"
export OG_BASE_ENV="$TMP/fake/env" OG_BASELINE_SERVER="$TMP/fake/server" OG_BASELINE_IMAGE="$IMG" FAKE_ADMIN_LOG="$TMP/admin.log"
touch "$FAKE_ADMIN_LOG"
name="$RUN-up"
echo "og_inst_$(echo "$name" | tr - _)" >> "$MADE/databases"
("$DI" up "$name" --server "$TMP/fake/server" --app "$TMP/fake/app" | cat > "$TMP/up.out" 2>&1) &
upper=$!
for _ in $(seq 1 90); do kill -0 "$upper" 2>/dev/null || break; sleep 1; done
if kill -0 "$upper" 2>/dev/null; then fail "up returns once the app is started"; pkill -P "$upper"; kill "$upper"
else pass "up returns once the app is started"; fi
d="$NATIVECHAT_INSTANCES/$name"
srv=$(cat "$d/server.pid" 2>/dev/null); app=$(cat "$d/app.pid" 2>/dev/null)
check "up records the app's own pid" "ps -o command= -p ${app:-0} | grep -q 'sleep 300'"
check "up records the server's own pid" "ps -o command= -p ${srv:-0} | grep -q 'http.server'"
"$DI" down "$name" > "$TMP/up-down.out" 2>&1
check "down stops that server and app" "! kill -0 ${srv:-0} 2>/dev/null && ! kill -0 ${app:-0} 2>/dev/null"

# --- a fresh database is seeded from the seed file, or gets a random account without one --------
cat > "$TMP/seed.env" <<'EOF'
OG_SEED_ORG_NAME=SeedOrg
OG_SEED_DOMAIN=seed.test
OG_SEED_EMAIL=ceo@seed.test
OG_SEED_PASSWORD='Pw$12345x'
EOF
name="$RUN-seeded"; d="$NATIVECHAT_INSTANCES/$name"
echo "og_inst_$(echo "$name" | tr - _)" >> "$MADE/databases"
OG_SEED_FILE="$TMP/seed.env" "$DI" up "$name" --server "$TMP/fake/server" --gateway http://127.0.0.1:39999 > "$TMP/seeded.out" 2>&1
check "a fresh database's org is the seed's" "grep -q -- '--name SeedOrg --admin-email ceo@seed.test --domain seed.test --password Pw\$12345x' $FAKE_ADMIN_LOG"
check "the instance signs in as the seed's admin" "[ \"\$(cat $d/email)\" = ceo@seed.test ] && [ \"\$(cat $d/org)\" = org_og_inst_$(echo "$name" | tr - _) ]"
check "up never prints the seed's password" "! grep -q 'Pw\$12345x' $TMP/seeded.out"
check "--gateway points the instance's server at that gateway" "grep -qx 'export OG_GATEWAY_URL=http://127.0.0.1:39999' $d/server.env"
"$DI" down "$name" >/dev/null 2>&1

name="$RUN-plain"; d="$NATIVECHAT_INSTANCES/$name"
echo "og_inst_$(echo "$name" | tr - _)" >> "$MADE/databases"
"$DI" up "$name" --server "$TMP/fake/server" > "$TMP/plain.out" 2>&1
check "without a seed file the instance gets an account of its own" "[ \"\$(cat $d/email)\" = $name@instance.test ] && grep -q -- '--admin-email $name@instance.test --domain instance.test' $FAKE_ADMIN_LOG"
"$DI" down "$name" >/dev/null 2>&1

# --- an app-only instance shares the baseline, with an account and computers of its own ---------
base="$NATIVECHAT_INSTANCES/$DEV_BASELINE"; bdb="og_inst_$(echo "$DEV_BASELINE" | tr - _)"
echo "$bdb" >> "$MADE/databases"
name="$RUN-app"; d="$NATIVECHAT_INSTANCES/$name"
"$DI" up "$name" --image "$IMG" > "$TMP/attach-image.out" 2>&1
code=$?
check "an instance without its own server refuses --image" "[ $code != 0 ] && grep -q 'add --server' $TMP/attach-image.out"
OG_SEED_FILE="$TMP/seed.env" "$DI" up "$name" > "$TMP/attach.out" 2>&1
check "the first app-only instance starts the baseline" "[ -f $base/server.pid ] && kill -0 \$(cat $base/server.pid) 2>/dev/null"
check "the baseline's computers come from main's image" "grep -qx 'export OG_COMPUTER=docker OG_DOCKER_IMAGE=grok-box-inst-$DEV_BASELINE:local' $base/server.env"
check "the app-only instance talks to the baseline's server" "[ \"\$(cat $d/server_port)\" = \"\$(cat $base/port)\" ] && [ \"\$(cat $d/port)\" != \"\$(cat $base/port)\" ]"
check "it has an account of its own in the baseline's org" "[ \"\$(cat $d/email)\" = $name@seed.test ] && grep -q -- 'account create --email $name@seed.test --org org_$bdb' $FAKE_ADMIN_LOG && [ -s $d/account ]"
check "it makes no database of its own" "! db_exists og_inst_$(echo "$name" | tr - _)"

acct=$(cat "$d/account")
sql "$bdb" "create table scoped_computer (scope text, scope_id text, box_id text); create table account_computer (account_id text, box_id text); create table coworker_view (account_id text, box_id text)" >/dev/null
own=$(container); bots=$(container); org_box=$(container); others=$(container); both=$(container)
sql "$bdb" "insert into scoped_computer values ('account', '$acct', '$own'), ('org', 'org_x', '$org_box'), ('account', 'acc_other', '$others'); insert into coworker_view values ('$acct', '$bots'), ('$acct', '$both'), ('acc_other', '$both')" >/dev/null

"$DI" down "$DEV_BASELINE" > "$TMP/base-busy.out" 2>&1
code=$?
check "the baseline refuses to go down while an instance uses it" "[ $code != 0 ] && grep -q $name $TMP/base-busy.out && kill -0 \$(cat $base/server.pid) 2>/dev/null"

"$DI" down "$name" > "$TMP/attach-down.out" 2>&1
check "down removes its account's computer and its Bots' boxes" "! exists $own && ! exists $bots"
check "down keeps the org's computer and another account's" "exists $org_box && exists $others"
check "down keeps a box another account shares" "exists $both && grep -q 'kept computer ${both:0:12}' $TMP/attach-down.out"
check "the baseline and its database stay up" "db_exists $bdb && kill -0 \$(cat $base/server.pid) 2>/dev/null && [ ! -d $d ]"

OG_SEED_FILE="$TMP/seed.env" "$DI" up "$name" > "$TMP/attach-again.out" 2>&1
check "made again under the same name, it gets its account back with a new password" "grep -q -- 'account password --email $name@seed.test' $FAKE_ADMIN_LOG && [ \"\$(cat $d/account)\" = $acct ]"
"$DI" down "$name" >/dev/null 2>&1
"$DI" down "$DEV_BASELINE" > "$TMP/base-down.out" 2>&1
check "with no instance on it, the baseline goes down" "! db_exists $bdb && [ ! -d $base ]"

# --- finish and abort -------------------------------------------------------------------------
# A stand-in gh: `pr list` prints $FAKE_GH_DIR/<repo dir name> if there is one, else $FAKE_GH_PRS
# ("number state head ci url" lines); `pr close` is logged.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "pr list")
    if [ -f "${FAKE_GH_DIR:-/nonexistent}/$(basename "$PWD")" ]; then cat "$FAKE_GH_DIR/$(basename "$PWD")"
    elif [ -n "${FAKE_GH_PRS:-}" ]; then printf '%s\n' "$FAKE_GH_PRS"; fi ;;
  "pr close") echo "close $3" >> "$FAKE_GH_LOG" ;;
esac
exit 0
EOF
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH" FAKE_GH_LOG="$TMP/gh.log" FAKE_GH_PRS=""
: > "$FAKE_GH_LOG"

repo="$TMP/repo"
git init -q --bare "$TMP/origin.git"
git init -q -b main "$repo"
git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$repo" remote add origin "$TMP/origin.git"
git -C "$repo" push -q origin main
export DEV_REPOS="$repo"
commit() { git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "$2"; }

# A topic: its worktree with one commit, pushed.
topic_with_worktree() {
  local topic=$1 wt="$TMP/repo-$1"
  git -C "$repo" worktree add -q -b "gol/$topic" "$wt"
  commit "$wt" "work on $topic"
  git -C "$wt" push -q origin "gol/$topic"
  echo "$wt"
}

topic="$RUN-finish"
wt=$(topic_with_worktree "$topic")
head=$(git -C "$wt" rev-parse HEAD)

touch "$wt/unsaved"
FAKE_GH_PRS="7 MERGED $head green https://pr/7" "$DI" finish "$topic" --yes > "$TMP/f1.out" 2>&1
code=$?
check "finish refuses a worktree with uncommitted changes" "[ $code = 1 ] && grep -q 'uncommitted changes' $TMP/f1.out"
check "a refused finish leaves the worktree and branch" "[ -d $wt ] && git -C $repo show-ref --quiet refs/heads/gol/$topic"
rm "$wt/unsaved"

FAKE_GH_PRS="" "$DI" finish "$topic" --yes > "$TMP/f2.out" 2>&1
code=$?
check "finish refuses a branch with no merged PR" "[ $code = 1 ] && grep -q 'no merged PR' $TMP/f2.out && [ -d $wt ]"

FAKE_GH_PRS="8 OPEN $head green https://pr/8" "$DI" finish "$topic" --yes > "$TMP/f3.out" 2>&1
code=$?
check "finish refuses while a PR is still open" "[ $code = 1 ] && grep -q 'still open' $TMP/f3.out && [ -d $wt ]"

commit "$wt" "made after the merge"
FAKE_GH_PRS="7 MERGED $head green https://pr/7" "$DI" finish "$topic" --yes > "$TMP/f4.out" 2>&1
code=$?
check "finish refuses a branch with commits its merged PR doesn't have" "[ $code = 1 ] && grep -q \"commits its merged PR doesn't\" $TMP/f4.out && [ -d $wt ]"

head=$(git -C "$wt" rev-parse HEAD)
docker tag "$IMG" "grok-box-$topic:local"
FAKE_GH_PRS="7 MERGED $head green https://pr/7" "$DI" finish "$topic" --yes > "$TMP/f5.out" 2>&1
code=$?
check "finish --yes on a merged topic removes the worktree and branch" "[ $code = 0 ] && [ ! -d $wt ] && ! git -C $repo show-ref --quiet refs/heads/gol/$topic"
check "finish untags the topic's own box image and leaves $IMG" "! docker image inspect grok-box-$topic:local >/dev/null 2>&1 && docker image inspect $IMG >/dev/null 2>&1"
check "finish leaves the remote branch (the merge is the record)" "git -C $repo ls-remote --exit-code --heads origin gol/$topic >/dev/null"

topic="$RUN-abort"
wt=$(topic_with_worktree "$topic")
head=$(git -C "$wt" rev-parse HEAD)
export FAKE_GH_PRS="9 OPEN $head green https://pr/9"

"$DI" abort "$topic" > "$TMP/a1.out" 2>&1
code=$?
check "abort without --yes lists the plan and changes nothing" "[ $code = 0 ] && grep -q 'dry run' $TMP/a1.out && [ -d $wt ] && [ ! -s $FAKE_GH_LOG ]"

(cd "$wt" && exec sleep 30) &
holder=$!
sleep 1
"$DI" abort "$topic" --yes > "$TMP/a2.out" 2>&1
code=$?
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
check "abort refuses a worktree a running process started in" "[ $code = 1 ] && grep -q 'running process' $TMP/a2.out && [ -d $wt ]"

"$DI" abort "$topic" --yes > "$TMP/a3.out" 2>&1
check "abort --yes closes the open PR" "grep -qx 'close 9' $FAKE_GH_LOG"
check "abort --yes removes the worktree and both branches" "[ ! -d $wt ] && ! git -C $repo show-ref --quiet refs/heads/gol/$topic && ! git -C $repo ls-remote --exit-code --heads origin gol/$topic >/dev/null"

FAKE_GH_PRS="" "$DI" finish "$RUN-none" --yes > "$TMP/n.out" 2>&1
code=$?
check "finish on a topic with nothing left says so and succeeds" "[ $code = 0 ] && grep -q 'nothing of' $TMP/n.out"

# --- group: a topic's PRs across repos merge together or not at all -----------------------------
repo2="$TMP/repo2"
git init -q -b main "$repo2"
git -C "$repo2" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$repo2" remote add origin "$TMP/origin.git"
export DEV_REPOS="$repo
$repo2" FAKE_GH_DIR="$TMP/ghprs"
mkdir -p "$FAKE_GH_DIR"
group_says() { printf '%s\n' "$2" > "$FAKE_GH_DIR/repo"; printf '%s\n' "$3" > "$FAKE_GH_DIR/repo2"; FAKE_GH_PRS="" "$DI" group "$1" > "$TMP/group.out" 2>&1; echo $?; }
code=$(group_says g1 "1 MERGED aaa green https://pr/1" "2 OPEN bbb green https://pr/2")
check "group calls one merged and one open PR incomplete" "[ $code = 1 ] && grep -q INCOMPLETE $TMP/group.out"
code=$(group_says g2 "1 OPEN aaa green https://pr/1" "2 OPEN bbb green https://pr/2")
check "group calls every PR open with green CI ready" "[ $code = 0 ] && grep -q '^ready' $TMP/group.out"
code=$(group_says g3 "1 OPEN aaa green https://pr/1" "2 OPEN bbb pending https://pr/2")
check "group calls a PR without green CI not ready" "[ $code = 1 ] && grep -q 'not ready' $TMP/group.out"
code=$(group_says g4 "1 MERGED aaa green https://pr/1" "2 MERGED bbb green https://pr/2")
check "group calls every PR merged fully merged" "[ $code = 0 ] && grep -q 'fully merged' $TMP/group.out"
git -C "$repo2" branch -q gol/g5
code=$(group_says g5 "1 OPEN aaa green https://pr/1" "")
check "group calls a branch with no PR not ready" "[ $code = 1 ] && grep -q 'no PR' $TMP/group.out"

# --- a copy of the script outside any checkout says it can't find the repos ---------------------
# Run from a copy with no checkout around it and no DEV_REPOS, `finish` once answered "nothing to
# finish": the repos were never found, and it looked like there was nothing to clear.
mkdir -p "$TMP/loose"
cp "$DI" "$TMP/loose/dev-instance.sh"
for cmd in finish abort group; do
  (cd "$TMP/loose" && env -u DEV_REPOS ./dev-instance.sh $cmd "$RUN-loose" > "$TMP/loose/$cmd.out" 2>&1)
  code=$?
  check "$cmd outside a checkout without DEV_REPOS refuses, saying why" "[ $code != 0 ] && grep -q DEV_REPOS $TMP/loose/$cmd.out"
done

echo
[ "$FAILS" = 0 ] && echo "all passed" || { echo "$FAILS failed"; exit 1; }
