import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-activity-hint-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/conversation/activity/activity-hint.ts")], outfile, bundle: true, format: "esm", platform: "node" });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// The transcript chip and the roster's verb line are gone by request, so this
// string is the only place the words survive. An idle coworker must return
// null: a tooltip that always says something is a tooltip nobody reads.
test("the avatar hint follows the roster's own marker precedence", async () => {
  const { loaded, cleanup } = await load();
  try {
    assert.equal(loaded.agentActivityHint({ descriptorText: "Reading the web", isRunning: true }), "Reading the web");
    assert.equal(loaded.agentActivityHint({ isRunning: true }), "Working", "running with no named verb still says something");
    assert.equal(loaded.agentActivityHint({ descriptorText: "Thinking", isRunning: true, awaitingUserResponse: { reason: "approval" } }), "Waiting for you", "waiting on the person outranks the activity");
    assert.equal(loaded.agentActivityHint({ awaitingUserResponse: {} }), "Waiting for you");
    assert.equal(loaded.agentActivityHint({ isRunning: false }), null, "an idle coworker says nothing");
    assert.equal(loaded.agentActivityHint({}), null);
    assert.equal(loaded.agentActivityHint({ descriptorText: "   ", isRunning: false }), null, "whitespace is not a label");
    assert.equal(loaded.agentActivityHint({ descriptorText: "  Writing  ", isRunning: true }), "Writing");
    assert.equal(loaded.agentActivityHint({ descriptorText: null, awaitingUserResponse: null, isRunning: true }), "Working");
  } finally { await cleanup(); }
});
