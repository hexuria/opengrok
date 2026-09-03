import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry, outfileName) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-main-edge-rpc-"));
  const output = path.join(temporary, outfileName);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("every MAIN_METHOD_TABLE method has a main-edge handler, or serveEdge throws and the window never opens", async () => {
  const table = await loadModule("source/shared/rpc/main.ts", "main-rpc-table.mjs");
  const edge = await loadModule("source/electron-main/main-edge.ts", "main-edge.mjs");
  try {
    const handlers = edge.module.createMainEdgeHandlers({});
    const missing = Object.keys(table.module.MAIN_METHOD_TABLE).filter((name) => typeof handlers[name] !== "function");
    assert.deepEqual(missing, [], `missing handlers: ${missing.join(", ")}`);
  } finally {
    await table.dispose();
    await edge.dispose();
  }
});
