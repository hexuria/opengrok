import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(dir) {
  const outfile = path.join(dir, "transcript-deletion.mjs");
  await build({ entryPoints: [path.join(repoRoot, "source/shared/transcript-deletion.ts")], outfile, bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "silent" });
  return import(`${pathToFileURL(outfile).href}?${Date.now()}`);
}

test("deleting a message is offered on the routes that keep a transcript we can reach, and not on Cursor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "transcript-deletion-"));
  try {
    const mod = await loadModule(dir);
    assert.deepEqual(mod.transcriptDeletionFor("opengrok", "cursor"), { available: true, route: "opengrok", reason: null }, "the OpenGrok server, whatever provider is remembered");
    for (const provider of ["claude-code", "codex", "openrouter"]) assert.equal(mod.transcriptDeletionFor("remote", provider).route, "local", provider);
    const cursor = mod.transcriptDeletionFor("remote", "cursor");
    assert.equal(cursor.available, false);
    assert.match(cursor.reason, /Cursor keeps its own transcripts/);
    assert.equal(mod.transcriptDeletionFor(undefined, undefined).available, false, "unknown is not available");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the server is sent `ids`, the desktop's `entryIds` kept, duplicates and non-strings dropped", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "transcript-deletion-"));
  try {
    const mod = await loadModule(dir);
    assert.deepEqual(mod.serverDeletionArgs({ agentId: "cw_1", entryIds: ["e1", 7, "e1", "e2"] }), { agentId: "cw_1", ids: ["e1", "e2"], entryIds: ["e1", "e2"] });
    assert.deepEqual(mod.serverDeletionArgs({ agentId: "cw_1", ids: ["e9"] }), { agentId: "cw_1", ids: ["e9"], entryIds: ["e9"] });
    assert.deepEqual(mod.serverDeletionArgs(null), { ids: [], entryIds: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
