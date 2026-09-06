import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-upsert-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/production/model.ts")], outfile, bundle: true, format: "esm", platform: "node", loader: { ".css": "empty" }, jsx: "automatic", define: { "process.env.NODE_ENV": "\"test\"", "import.meta.env": "{}" } });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}
// The stream wraps the row (official ingestAgentUpserted reads payload.agent);
// projecting the envelope itself found no id and dropped every running push.
test("an agent-upserted envelope yields its row, and a bare row passes through", async () => {
  const { loaded, cleanup } = await load();
  try {
    const row = { id: "cw_1", name: "Bot", isRunning: true, currentActivity: { kind: "thinking" }, updatedAt: 5 };
    assert.equal(loaded.agentRowFromUpsert({ activeAgentId: null, agent: row, ordered: { seq: 3 } }), row);
    assert.equal(loaded.agentRowFromUpsert(row), row);
    assert.equal(loaded.agentRowFromUpsert(null), null);
    const projected = loaded.projectRendererAgent(loaded.agentRowFromUpsert({ agent: row, ordered: {} }));
    assert.equal(projected?.id, "cw_1");
    assert.equal(projected?.isRunning, true, "the running flag survives the unwrap");
    assert.equal(loaded.projectRendererAgent({ agent: row, ordered: {} }), null, "the envelope itself is not a row — this is the drop that hid the working dot");
  } finally { await cleanup(); }
});
