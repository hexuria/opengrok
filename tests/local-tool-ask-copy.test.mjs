import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(sourcePath) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-tool-ask-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, sourcePath)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

// The consent prompt is the only place a person sees what they are agreeing
// to. An action the gate enforces but the prompt cannot name would be asked
// for under the generic "run commands" title, which is what this guards.
test("every local tool action the gate enforces has consent copy", async () => {
  const loaded = await loadModule("source/shared/local-tool-permission.ts");
  try {
    const { SAND_LOCAL_TOOL_ACTIONS } = loaded.module;
    const patch = await readFile(path.join(repoRoot, "scripts/lib/router-renderer-patch.mjs"), "utf8");
    const helper = /const LOCAL_TOOL_ASK_HELPER =([\s\S]*?)\n\n/.exec(patch)?.[1];
    assert.ok(helper != null, "LOCAL_TOOL_ASK_HELPER must exist in the renderer patch");

    assert.ok(SAND_LOCAL_TOOL_ACTIONS.length > 0);
    for (const action of SAND_LOCAL_TOOL_ACTIONS) {
      assert.match(helper, new RegExp(`"${action}":"[^"]+"`), `no consent copy for the "${action}" action`);
    }

    // The copy is a verb phrase completing "Allow Grok Bot and all agents to
    // …?", so a phrase that reads as a sentence would render as one.
    for (const [, phrase] of helper.matchAll(/"[a-z-]+":"([^"]+)"/g)) {
      assert.doesNotMatch(phrase, /^[A-Z]/, `"${phrase}" should not start capitalised`);
      assert.doesNotMatch(phrase, /[.?]$/, `"${phrase}" should not end with punctuation`);
    }
  } finally {
    await loaded.dispose();
  }
});
