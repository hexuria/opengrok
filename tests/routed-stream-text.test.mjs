import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-routed-stream-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/inference/routed-stream-text.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
  });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

test("streamTextDelta keeps real tokens and ignores empty chunks", async () => {
  const { loaded, cleanup } = await load();
  try {
    assert.equal(loaded.streamTextDelta({ type: "text-delta", textDelta: "Hey" }), "Hey");
    assert.equal(loaded.streamTextDelta({ type: "text-delta", text: " there" }), " there");
    assert.equal(loaded.streamTextDelta({ type: "text-delta", delta: "!" }), "!");
    assert.equal(loaded.streamTextDelta({ type: "text-delta", textDelta: "" }), "");
    assert.equal(loaded.streamTextDelta({ type: "finish" }), "");
    assert.throws(() => loaded.streamTextDelta({ type: "error", error: new Error("rate limited") }), /rate limited/);
    assert.match(loaded.emptyRoutedReplyMessage("OpenRouter"), /OpenRouter returned no text/);
  } finally {
    await cleanup();
  }
});
