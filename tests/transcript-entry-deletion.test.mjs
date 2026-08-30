import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(sourcePath) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-transcript-entry-deletion-"));
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

function userMessage(id) {
  return { kind: "message", id, role: "user", content: id, isStreaming: false };
}

test("entry id minting never re-mints a retired id", async () => {
  const loaded = await loadModule("source/host/extensions/transcript/transcript-entry-ids.ts");
  try {
    const entries = [userMessage("t0u"), { kind: "send-message", id: "t0s0", message: { type: "text", content: "hi" } }];
    assert.equal(loaded.module.nextEntryId(entries, "user-message"), "t1u");
    assert.equal(loaded.module.nextEntryId(entries, "user-message", new Set(["t1u"])), "t2u");
    assert.equal(loaded.module.nextEntryId(entries, "user-message", new Set(["t1u", "t2u"])), "t3u");
    assert.equal(loaded.module.nextEntryId(entries, "send-message", new Set(["t0s1"])), "t0s2");
    assert.equal(loaded.module.nextEntryId(entries, "user-attachment", new Set(["t1ua0"])), "t1ua1");
  } finally {
    await loaded.dispose();
  }
});

test("deletion policy blocks branch roots, pending entries, and unknown ids", async () => {
  const loaded = await loadModule("source/host/extensions/transcript/entry-deletion.ts");
  try {
    const { classifyEntryDeletion } = loaded.module;
    const entries = [
      userMessage("t0u"),
      { kind: "send-message", id: "t0s0", message: { type: "text", content: "root" } },
      { kind: "message", id: "t1u", role: "user", content: "reply", branched: true, replyTo: "t0s0" },
      { kind: "send-message", id: "t1s0", message: { type: "text", content: "nested" }, branched: true, replyTo: "t1u" },
      { kind: "send-message", id: "t2s0", message: { type: "text", content: "live" }, streaming: true },
      { kind: "send-message", id: "t2s1", message: { type: "auto-review-approval", approval: { requestId: "r1", status: "pending" } } },
      { kind: "message", id: "t3u", role: "assistant", content: "typing", isStreaming: true },
    ];

    assert.equal(classifyEntryDeletion("t0s0", entries).reason, "branch-root-with-children");
    // Mid-thread replies are not branch roots: the root is the nearest unbranched ancestor.
    assert.equal(classifyEntryDeletion("t1u", entries).reason, null);
    assert.equal(classifyEntryDeletion("t1s0", entries).reason, null);
    assert.equal(classifyEntryDeletion("t2s0", entries).reason, "pending");
    assert.equal(classifyEntryDeletion("t2s1", entries).reason, "pending");
    assert.equal(classifyEntryDeletion("t3u", entries).reason, "pending");
    assert.equal(classifyEntryDeletion("t0u", entries).reason, null);
    assert.equal(classifyEntryDeletion("nope", entries).reason, "not-found");
    assert.equal(classifyEntryDeletion("nope", entries).index, -1);

    // A branch root frees up once its live descendants are gone.
    const pruned = entries.filter((entry) => entry.id !== "t1u" && entry.id !== "t1s0");
    assert.equal(classifyEntryDeletion("t0s0", pruned).reason, null);
  } finally {
    await loaded.dispose();
  }
});

test("deleteTranscriptEntries tombstones deletable entries and reports blocked ones", async () => {
  const loaded = await loadModule("source/host/extensions/transcript/entry-deletion.ts");
  try {
    const entries = [
      userMessage("t0u"),
      { kind: "send-message", id: "t0s0", message: { type: "text", content: "root" } },
      { kind: "message", id: "t1u", role: "user", content: "reply", branched: true, replyTo: "t0s0" },
      { kind: "send-message", id: "t1s0", message: { type: "text", content: "live" }, streaming: true },
    ];
    const deletedFromDb = [];
    const retired = [];
    const emitted = [];
    let ensuredAgentId = null;
    const session = {
      id: "agent-a",
      db: {
        getTranscriptEntries: () => entries,
        deleteTranscriptEntry: (id) => { deletedFromDb.push(id); return true; },
        addRetiredEntryIds: (ids) => { retired.push(...ids); },
      },
    };
    const manager = {
      sessions: {
        activeSession: undefined,
        inMemoryTranscriptAgentId: null,
        liveSessions: new Map([["agent-a", session]]),
        ensureActionTarget: async (agentId) => { ensuredAgentId = agentId; },
      },
      roster: { emit: (event, agentId) => emitted.push({ event, agentId }) },
    };

    const domain = new loaded.module.TranscriptEntryDeletion(manager);
    const result = await domain.deleteTranscriptEntries({
      agentId: "agent-a",
      entryIds: ["t0u", "t0s0", "t1s0", "missing", "t1u"],
    });

    assert.equal(ensuredAgentId, "agent-a");
    assert.deepEqual(result.deleted, ["t0u", "t1u"]);
    assert.deepEqual(result.blocked, [
      { id: "t0s0", reason: "branch-root-with-children" },
      { id: "t1s0", reason: "pending" },
      { id: "missing", reason: "not-found" },
    ]);
    assert.deepEqual(deletedFromDb, ["t0u", "t1u"]);
    assert.deepEqual(retired, ["t0u", "t1u"]);
    assert.deepEqual(emitted, [
      { event: { type: "removed", id: "t0u" }, agentId: "agent-a" },
      { event: { type: "removed", id: "t1u" }, agentId: "agent-a" },
    ]);
  } finally {
    await loaded.dispose();
  }
});

test("deleteTranscriptEntries is served by the gateway and the coordinator main leg", async () => {
  const gateway = await loadModule("source/host/gateway-protocol.ts");
  const coordinatorMain = await loadModule("source/shared/rpc/coordinator-main.ts");
  try {
    assert.equal(typeof gateway.module.SAND_GATEWAY_COMMANDS.deleteTranscriptEntries, "function");
    assert.deepEqual(coordinatorMain.module.COORDINATOR_MAIN_METHOD_TABLE.deleteTranscriptEntries, { args: "object" });
    assert.equal(coordinatorMain.module.isCoordinatorMainMethod("deleteTranscriptEntries"), true);

    const calls = [];
    await gateway.module.SAND_GATEWAY_COMMANDS.deleteTranscriptEntries(
      { deleteTranscriptEntries: (args) => { calls.push(args); } },
      JSON.stringify({ agentId: "agent-a", entryIds: ["t0u"] }),
    );
    assert.deepEqual(calls, [{ agentId: "agent-a", entryIds: ["t0u"] }]);
  } finally {
    await gateway.dispose();
    await coordinatorMain.dispose();
  }
});
