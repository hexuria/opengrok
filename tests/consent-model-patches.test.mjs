import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the daemon on/off helper maps enrolled legacy values to on, never to off", async () => {
  const { build } = await import("esbuild");
  const dir = await mkdtemp(path.join(os.tmpdir(), "daemon-onoff-"));
  try {
    const out = path.join(dir, "d.mjs");
    await build({ entryPoints: [path.join(repoRoot, "source/host/local-exec/local-exec-daemon.ts")], outfile: out, bundle: true, format: "esm", platform: "node", external: ["electron"] });
    const { isLocalToolPermissionOn } = await import(pathToFileURL(out).href);
    assert.equal(isLocalToolPermissionOn("always"), true);
    assert.equal(isLocalToolPermissionOn("ask"), true, "an enrolled machine at legacy 'ask' stays on");
    assert.equal(isLocalToolPermissionOn("never"), false, "only an explicit never is the off kill switch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the per-agent auto-review widget is valid JS", async () => {
  const { AGENT_AUTOREVIEW_HELPER } = await import("../scripts/lib/agent-autoreview-helper.mjs");
  const acorn = await import("acorn");
  acorn.parse(AGENT_AUTOREVIEW_HELPER, { ecmaVersion: "latest" });
  assert.match(AGENT_AUTOREVIEW_HELPER, /getAgentAutoReview/);
  assert.match(AGENT_AUTOREVIEW_HELPER, /setAgentAutoReview/);
  assert.match(AGENT_AUTOREVIEW_HELPER, /deleteAgentAutoReview/);
  assert.match(AGENT_AUTOREVIEW_HELPER, /\.sand-agent-settings/);
  assert.match(AGENT_AUTOREVIEW_HELPER, /aria-current/);
  assert.match(AGENT_AUTOREVIEW_HELPER, /Manage…/);
  assert.match(AGENT_AUTOREVIEW_HELPER, /Inherit from global/);
  assert.match(AGENT_AUTOREVIEW_HELPER, /sand-ar-scrim/);
  assert.match(AGENT_AUTOREVIEW_HELPER, /ROWS=10/);
  assert.match(AGENT_AUTOREVIEW_HELPER, /sand-ar-plus/);
  assert.match(AGENT_AUTOREVIEW_HELPER, /sand-ar-draft/);
  assert.doesNotMatch(AGENT_AUTOREVIEW_HELPER, /lp-ar-sum/);
});
