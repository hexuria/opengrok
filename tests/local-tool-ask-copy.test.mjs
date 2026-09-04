import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

test("every local tool action the gate enforces has consent copy", async () => {
  const loaded = await loadModule("source/shared/local-tool-permission.ts");
  try {
    const { SAND_LOCAL_TOOL_ACTIONS, SAND_LOCAL_TOOL_ASK_TITLES } = loaded.module;

    assert.ok(SAND_LOCAL_TOOL_ACTIONS.length > 0);
    for (const action of SAND_LOCAL_TOOL_ACTIONS) {
      const phrase = SAND_LOCAL_TOOL_ASK_TITLES[action];
      assert.equal(typeof phrase, "string", `no consent copy for the "${action}" action`);
      assert.ok(phrase.length > 0, `empty consent copy for the "${action}" action`);
      assert.doesNotMatch(phrase, /^[A-Z]/, `"${phrase}" should not start capitalised`);
      assert.doesNotMatch(phrase, /[.?]$/, `"${phrase}" should not end with punctuation`);
    }
  } finally {
    await loaded.dispose();
  }
});
