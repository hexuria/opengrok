import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(sourcePath) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-transcript-forward-compat-"));
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

// The store wire, the coordinator RPC and the renderer feed all pass an
// unrecognised entry through untouched. The local DB read was the one lossy
// hop, so a kind introduced by a newer build vanished from this device's
// history the moment it was read back.
test("an entry kind this build does not know survives the local DB round trip", async () => {
  const loaded = await loadModule("source/host/extensions/session/agent-db-serde.ts");
  try {
    const { parseTranscriptEntry } = loaded.module;

    const future = { kind: "voice-call", id: "t9v0", callee: "Ada", durationMs: 42_000 };
    assert.deepEqual(parseTranscriptEntry(JSON.stringify(future)), future);

    const feedback = { kind: "feedback", id: "t9f0", rating: "up" };
    assert.deepEqual(parseTranscriptEntry(JSON.stringify(feedback)), feedback);

    // The known kinds keep their shape assertions, so a malformed entry of a
    // kind we do render is still rejected rather than reaching the renderer.
    assert.equal(parseTranscriptEntry(JSON.stringify({ kind: "message", id: "t0u" })), null);
    assert.equal(parseTranscriptEntry(JSON.stringify({ kind: "tool-call", id: "t0c0" })), null);
    assert.equal(parseTranscriptEntry(JSON.stringify({ kind: "notice", id: "t0n0", text: 7 })), null);

    // An error row is still not a transcript entry, and an unknown kind with no
    // identity cannot be threaded, replied to or deleted — both stay dropped.
    assert.equal(parseTranscriptEntry(JSON.stringify({ kind: "error", id: "t0e0" })), null);
    assert.equal(parseTranscriptEntry(JSON.stringify({ kind: "voice-call" })), null);
    assert.equal(parseTranscriptEntry(JSON.stringify({ id: "t9x0" })), null);
    assert.equal(parseTranscriptEntry("not json"), null);
  } finally {
    await loaded.dispose();
  }
});

test("a card type this build predates renders a placeholder instead of a hole", async () => {
  const loaded = await loadModule("frontend/src/production/model.ts");
  try {
    const { projectTranscriptEntry } = loaded.module;

    const future = projectTranscriptEntry(
      { kind: "send-message", id: "t9s0", message: { type: "user-form", formRequest: { title: "Deploy" } }, timestampMs: 1 },
      0,
      "Ada",
    );
    assert.equal(future?.kind, "notice");
    assert.equal(future?.id, "t9s0");
    assert.match(future?.text ?? "", /can’t be shown/);

    // A known card still projects as a card, not as the placeholder.
    const known = projectTranscriptEntry(
      { kind: "send-message", id: "t9s1", message: { type: "text", content: "hi" }, timestampMs: 1 },
      0,
      "Ada",
    );
    assert.notEqual(known, null);
    assert.notEqual(known?.kind, "notice");

    // Entries that are not cards at all keep falling through to null.
    assert.equal(projectTranscriptEntry({ kind: "send-message", id: "t9s2", timestampMs: 1 }, 0, "Ada"), null);
    assert.equal(projectTranscriptEntry({ kind: "tool-call", id: "t9c0", timestampMs: 1 }, 0, "Ada"), null);
  } finally {
    await loaded.dispose();
  }
});
