import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-exchange-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, entry)], outfile, bundle: true, format: "esm", platform: "node", loader: { ".css": "empty" }, jsx: "automatic", define: { "process.env.NODE_ENV": "\"test\"", "import.meta.env": "{}" } });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// Official builds the exchange from the coworker's OWN transcript: an entry is
// part of it when either hop names the peer; outbound rows are authored by the
// coworker, inbound rows by the hop's fromAgent (bundle Uan @2276941).
test("projectAgentExchange keeps only hop messages with the peer and assigns authors per direction", async () => {
  const { loaded, cleanup } = await load("frontend/src/recovered/features/conversation/workspace/agent-exchange.tsx");
  try {
    const self = { id: "hex", name: "Hexuria" };
    const entries = [
      { kind: "message", id: "m1", role: "assistant", author: "Hexuria", text: "hello", timestampMs: 1000 },
      { kind: "message", id: "m2", role: "assistant", author: "Hexuria", text: "to firefly", timestampMs: 2000, toAgent: { id: "fire", name: "Firefly", kind: "agent" } },
      { kind: "message", id: "m3", role: "assistant", author: "Firefly", text: "from firefly", timestampMs: 3000, fromAgent: { id: "fire", name: "Firefly" }, images: [{ url: "x", alt: "" }] },
      { kind: "message", id: "m4", role: "assistant", author: "Other", text: "elsewhere", timestampMs: 4000, toAgent: { id: "other", name: "Other", kind: "agent" } },
      { kind: "notice", id: "n1", text: "ignored", timestampMs: 5000 },
    ];
    const rows = loaded.projectAgentExchange(entries, "fire", self);
    assert.deepEqual(rows.map((row) => [row.id, row.author.name, row.outbound, row.images?.length ?? 0]), [["m2", "Hexuria", true, 0], ["m3", "Firefly", false, 1]]);
    assert.deepEqual(loaded.projectAgentExchange(entries, "nobody", self), []);
  } finally { await cleanup(); }
});

// Adjacent routine changes fold per automationId to the last action, a create
// that is deleted in the same batch vanishes, and the head row carries the group
// (bundle _In @5127148).
test("automationChangedRun folds adjacent routine events and cancels create+delete", async () => {
  const { loaded, cleanup } = await load("frontend/src/recovered/features/conversation/cards/timeline-event-automation.tsx");
  try {
    const event = (id, automationId, action, name = automationId.toUpperCase()) => ({ kind: "timeline-event", id, event: { type: "automation-changed", action, automationId, automationName: name }, timestampMs: 0 });
    const rows = [
      { kind: "message", id: "m0" },
      event("e1", "a", "deleted"),
      event("e2", "b", "deleted"),
      event("e3", "c", "created"),
      event("e4", "c", "deleted"),
      { kind: "message", id: "m1" },
      event("e5", "d", "created"),
    ];
    const head = loaded.automationChangedRun(rows, 1);
    assert.equal(head.rowCount, 4);
    assert.equal(head.isHead, true);
    assert.deepEqual(head.events.map((entry) => [entry.automationId, entry.action]), [["a", "deleted"], ["b", "deleted"]], "c was created and deleted in the same run, so it is gone");
    assert.equal(loaded.automationChangedRun(rows, 2).isHead, false);
    assert.equal(loaded.automationChangedRun(rows, 3).events.length, 0, "a row whose action has no survivors renders nothing");
    const single = loaded.automationChangedRun(rows, 6);
    assert.equal(single.rowCount, 1);
    assert.deepEqual(single.events, [{ automationId: "d", automationName: "D", action: "created" }]);
    assert.equal(loaded.automationChangedRun(rows, 0), null);
  } finally { await cleanup(); }
});
