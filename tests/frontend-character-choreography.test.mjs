import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-choreo-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/agent-character/choreography.ts")], outfile, bundle: true, format: "esm", platform: "node" });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const sample = (loaded, state, everyMs = 20) => {
  const beats = loaded.beatsFor(state);
  const total = loaded.cycleMs(beats);
  const out = [];
  for (let t = 0; t < total; t += everyMs) out.push(loaded.characterPose(beats, t));
  return out;
};

// One mapping for every bot: the shape says who it is, the beats say what it is
// doing. A verb that produced no movement at all is the bug the operator saw.
test("every verb a coworker can report has motion, and each is distinguishable", async () => {
  const { loaded, cleanup } = await load();
  try {
    for (const state of ["thinking", "working", "writing", "searching", "sending", "idle", "loading", "orbit"]) {
      const poses = sample(loaded, state);
      const gazes = new Set(poses.map((p) => `${p.gaze.x},${p.gaze.y}`));
      const spun = Math.max(...poses.map((p) => p.yaw));
      const hopped = Math.max(...poses.map((p) => p.hop));
      const blinked = poses.some((p) => p.blink > .5);
      assert.ok(gazes.size > 1 || spun > 0 || hopped > 0 || blinked, `${state} must do something`);
    }
    const thinking = sample(loaded, "thinking");
    const working = sample(loaded, "working");
    assert.equal(Math.max(...thinking.map((p) => p.yaw)), 0, "thinking is stillness: no spin");
    assert.equal(Math.max(...thinking.map((p) => p.hop)), 0, "thinking does not hop");
    assert.ok(thinking.every((p) => p.gaze.x > 0 && p.gaze.y < 0), "thinking looks up and to the right");
    assert.ok(Math.max(...working.map((p) => p.hop)) > 19, "working reaches the high bounce");
    assert.ok(Math.max(...working.map((p) => p.yaw)) >= Math.PI * 2 * 2.9, "working turns three times over its cycle");
  } finally { await cleanup(); }
});

test("writing looks left, comes back to the middle, then blinks", async () => {
  const { loaded, cleanup } = await load();
  try {
    const beats = loaded.beatsFor("writing");
    const at = (ms) => loaded.characterPose(beats, ms);
    assert.ok(at(200).gaze.x < -.5, "it glances left first");
    assert.ok(Math.abs(at(700).gaze.x) < .2, "then back to the middle");
    const blinkWindow = [];
    for (let t = 940; t < 1200; t += 10) blinkWindow.push(at(t).blink);
    assert.ok(Math.max(...blinkWindow) > .9, "and blinks once it is back");
  } finally { await cleanup(); }
});

// A blink has to READ as a blink: shut fast, hold as two dashes, open again.
test("a blink closes, holds, and opens", async () => {
  const { loaded, cleanup } = await load();
  try {
    assert.equal(loaded.blinkAmount(-5), 0);
    assert.equal(loaded.blinkAmount(loaded.BLINK_MS + 1), 0);
    assert.ok(loaded.blinkAmount(loaded.BLINK_MS * .15) > 0 && loaded.blinkAmount(loaded.BLINK_MS * .15) < 1, "closing");
    assert.equal(loaded.blinkAmount(loaded.BLINK_MS * .45), 1, "held shut");
    assert.ok(loaded.blinkAmount(loaded.BLINK_MS * .85) < 1, "opening again");
  } finally { await cleanup(); }
});

// Position-from-time, like the mascot's loop: a stalled frame cannot leave a
// coworker mid-turn, and a spin always lands facing forward.
test("the pose is a pure function of time and every spin lands facing forward", async () => {
  const { loaded, cleanup } = await load();
  try {
    const beats = loaded.beatsFor("working");
    const total = loaded.cycleMs(beats);
    assert.deepEqual(loaded.characterPose(beats, 1234), loaded.characterPose(beats, 1234), "same time, same pose");
    assert.deepEqual(loaded.characterPose(beats, 500), loaded.characterPose(beats, 500 + total), "the cycle repeats");
    const end = loaded.characterPose(beats, total - 1);
    const turns = end.yaw / (Math.PI * 2);
    assert.ok(Math.abs(turns - Math.round(turns)) < .01, `a cycle ends on a whole number of turns, got ${turns}`);
    assert.equal(loaded.characterPose(beats, -50).beat, 0, "a negative clock is treated as the start");
    assert.equal(loaded.characterPose(beats, Number.NaN).beat, 0);
  } finally { await cleanup(); }
});
