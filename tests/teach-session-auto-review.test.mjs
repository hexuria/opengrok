import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadTeachSessionModule() {
  const source = await readFile(path.join(repoRoot, "source/packages/agent/tools/core/shell/teach-session-auto-review.ts"), "utf8");
  const { code: output } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

const claimScript = `scope="c5774817cb15d1d4f2dee11b03c273ccec68fb38d271c51fe1660eb24dfba323"
queue_dir="/workspace/teach-sessions/queues/$scope"
pending_dir="$queue_dir/pending"
claimed_dir="$queue_dir/claimed"
lease_minutes=720
legacy_claim_minutes=1440
mkdir -p "$pending_dir" "$claimed_dir"
exec 9>"$queue_dir/.claim.lock"
flock 9
for claimed in "$claimed_dir"/*.json; do
  [ -e "$claimed" ] || break
  lease="$claimed.lease"
  stale_claim=""
  if [ -e "$lease" ] && [ -n "$(find "$lease" -mmin +"$lease_minutes" -print -quit)" ]; then
    stale_claim="$claimed"
  elif [ ! -e "$lease" ] && [ -n "$(find "$claimed" -mmin +"$legacy_claim_minutes" -print -quit)" ]; then
    stale_claim="$claimed"
  fi
  if [ -n "$stale_claim" ]; then
    mv "$stale_claim" "$pending_dir/$(basename "$stale_claim")"
    rm -f "$lease"
  fi
done
claim=""
for pending in "$pending_dir"/*.json; do
  [ -e "$pending" ] || break
  candidate="$claimed_dir/$(basename "$pending")"
  if mv "$pending" "$candidate" 2>/dev/null; then
    claim="$candidate"
    break
  fi
done
if [ -n "$claim" ]; then
  touch "$claim.lease"
fi
flock -u 9
[ -n "$claim" ] || { echo "no recording is queued"; exit 1; }
session_dir=$(jq -er '.sessionDir | select(type == "string") | select(startswith("/workspace/teach-sessions/teach-"))' "$claim") || exit 1
video=$(jq -er --arg prefix "$session_dir/" '.videoPath | select(type == "string") | select(startswith($prefix))' "$session_json") || exit 1
pid=$(jq -er '.ffmpegPid | select(type == "number" or type == "string")' "$session_json") || exit 1
tr '\\0' ' ' < /proc/"$pid"/cmdline 2>/dev/null | grep -qF "$video"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$video"
ffmpeg -y -ss 1 -i "$video" -frames:v 1 /tmp/teach_frame_a.png
`;

test("teach-session shell commands stay inside the recording queue", async () => {
  const mod = await loadTeachSessionModule();
  assert.equal(mod.isSandTeachSessionShellCommand("ls /workspace/teach-sessions/queues"), true);
  assert.equal(mod.isSandTeachSessionShellCommand("ls /workspace/teach-sessions"), true);
  assert.equal(mod.isSandTeachSessionShellCommand(claimScript), true);
  assert.equal(mod.isSandTeachSessionShellCommand("ls /tmp"), false);
  assert.equal(mod.isSandTeachSessionShellCommand("rm -rf / && echo /workspace/teach-sessions/x"), false);
  assert.equal(mod.isSandTeachSessionShellCommand("cat /etc/passwd; ls /workspace/teach-sessions"), false);
  assert.equal(mod.failOpenIsolatedBoxClassifierError("isolated_box"), true);
  assert.equal(mod.failOpenIsolatedBoxClassifierError("host_machine"), false);
});

test("box shell skips Auto-review for teach recordings and classifier errors", async () => {
  const source = await readFile(path.join(repoRoot, "source/packages/agent/tools/core/shell/create-shell-tool.ts"), "utf8");
  assert.match(source, /isSandTeachSessionShellCommand\(command, workingDirectory\)/);
  assert.match(source, /failOpenIsolatedBoxClassifierError\(surface\)/);
  const computer = await readFile(path.join(repoRoot, "source/host/runner/sand-computer-auto-review.ts"), "utf8");
  assert.match(computer, /if \(decision\.kind === "reject"\) return;/);
});
