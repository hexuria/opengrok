import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-hold-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/agent-character/state-hold.ts")], outfile, bundle: true, format: "esm", platform: "node" });
  return { loaded: await import(`${pathToFileURL(outfile).href}?${Date.now()}`), cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// Measured on the packaged app: a fixture turn's tool round is on screen for
// about 250ms, which is less than one beat, so the bounce-and-spin never drew.
test("a state too brief to play is held, and the one behind it waits its turn", async () => {
  const { loaded, cleanup } = await load();
  try {
    let hold = loaded.EMPTY_STATE_HOLD;
    hold = loaded.advanceStateHold(hold, "thinking", 0);
    assert.equal(hold.shown, "thinking", "the first state after idle shows at once");
    hold = loaded.advanceStateHold(hold, "working", 1400);
    assert.equal(hold.shown, "working");
    hold = loaded.advanceStateHold(hold, "thinking", 1650);
    assert.equal(hold.shown, "working", "the 250ms tool round is not cut off mid-beat");
    assert.equal(hold.pending, "thinking");
    assert.equal(loaded.stateHoldDelayMs(hold, 1650), 950);
    hold = loaded.flushStateHold(hold, 2600);
    assert.equal(hold.shown, "thinking");
    assert.equal(hold.pending, null);
  } finally { await cleanup(); }
});

test("settling is immediate, and a repeat of the shown state clears anything waiting", async () => {
  const { loaded, cleanup } = await load();
  try {
    let hold = loaded.advanceStateHold(loaded.EMPTY_STATE_HOLD, "working", 0);
    hold = loaded.advanceStateHold(hold, "idle", 100);
    assert.equal(hold.shown, "idle", "a coworker that has stopped settles at once, however brief the run");
    assert.equal(hold.pending, null);

    hold = loaded.advanceStateHold(loaded.EMPTY_STATE_HOLD, "writing", 0);
    hold = loaded.advanceStateHold(hold, "working", 200);
    assert.equal(hold.pending, "working");
    hold = loaded.advanceStateHold(hold, "writing", 300);
    assert.equal(hold.shown, "writing");
    assert.equal(hold.pending, null, "the server changed its mind back; nothing is waiting");
    assert.equal(loaded.stateHoldDelayMs(hold, 300), 0);
  } finally { await cleanup(); }
});
