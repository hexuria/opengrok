import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "project-agent-comm-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    loader: { ".css": "empty", ".woff2": "empty", ".png": "empty", ".svg": "empty" },
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const PROJECTOR = "frontend/src/production/model.ts";
const GROUP = "frontend/src/recovered/features/conversation/system-event/agent-comm-group.ts";

test("inbound fromAgent survives projectTranscriptEntry", async () => {
  const { loaded, cleanup } = await load(PROJECTOR);
  try {
    const projected = loaded.projectTranscriptEntry({
      kind: "message",
      id: "in-1",
      role: "user",
      content: "hello from puck",
      timestampMs: 10,
      fromAgent: { id: "puck", name: "Puck" },
    }, 0, "Hex");
    assert.equal(projected.kind, "message");
    assert.equal(projected.role, "user");
    assert.deepEqual(projected.fromAgent, { id: "puck", name: "Puck" });
    assert.equal(projected.toAgent, undefined);
  } finally {
    await cleanup();
  }
});

test("outbound toAgent with kind survives projectTranscriptEntry", async () => {
  const { loaded, cleanup } = await load(PROJECTOR);
  try {
    const projected = loaded.projectTranscriptEntry({
      kind: "message",
      id: "out-1",
      role: "assistant",
      content: "hello hex",
      timestampMs: 11,
      toAgent: { id: "hex", name: "Hex", kind: "agent" },
    }, 0, "Puck");
    assert.equal(projected.kind, "message");
    assert.equal(projected.role, "assistant");
    assert.deepEqual(projected.toAgent, { id: "hex", name: "Hex", kind: "agent" });
    assert.equal(projected.fromAgent, undefined);
  } finally {
    await cleanup();
  }
});

test("ordinary user and assistant messages stay without hop fields", async () => {
  const { loaded, cleanup } = await load(PROJECTOR);
  try {
    const user = loaded.projectTranscriptEntry({
      kind: "message",
      id: "u1",
      role: "user",
      content: "hi",
      timestampMs: 1,
    }, 0, "Hex");
    assert.equal(user.fromAgent, undefined);
    assert.equal(user.toAgent, undefined);

    const assistant = loaded.projectTranscriptEntry({
      kind: "message",
      id: "a1",
      role: "assistant",
      content: "hello",
      timestampMs: 2,
    }, 1, "Hex");
    assert.equal(assistant.fromAgent, undefined);
    assert.equal(assistant.toAgent, undefined);
  } finally {
    await cleanup();
  }
});

test("invalid agent ref (missing id) is omitted", async () => {
  const { loaded, cleanup } = await load(PROJECTOR);
  try {
    const missingId = loaded.projectTranscriptEntry({
      kind: "message",
      id: "bad-1",
      role: "user",
      content: "hi",
      timestampMs: 1,
      fromAgent: { name: "Puck" },
    }, 0, "Hex");
    assert.equal(missingId.fromAgent, undefined);

    const emptyId = loaded.projectTranscriptEntry({
      kind: "message",
      id: "bad-2",
      role: "assistant",
      content: "hi",
      timestampMs: 2,
      toAgent: { id: "", name: "Hex", kind: "agent" },
    }, 1, "Puck");
    assert.equal(emptyId.toAgent, undefined);

    const nameless = loaded.projectTranscriptEntry({
      kind: "message",
      id: "ok-empty-name",
      role: "user",
      content: "hi",
      timestampMs: 3,
      fromAgent: { id: "puck" },
    }, 2, "Hex");
    assert.deepEqual(nameless.fromAgent, { id: "puck", name: "" });
  } finally {
    await cleanup();
  }
});

test("projected inbound and outbound entries group into the right summary kind", async () => {
  const projector = await load(PROJECTOR);
  const grouper = await load(GROUP);
  try {
    const inbound = projector.loaded.projectTranscriptEntry({
      kind: "message",
      id: "m1",
      role: "user",
      content: "from puck",
      timestampMs: 1,
      fromAgent: { id: "puck", name: "Puck" },
    }, 0, "Hex");
    const outbound = projector.loaded.projectTranscriptEntry({
      kind: "message",
      id: "m2",
      role: "assistant",
      content: "to hex",
      timestampMs: 2,
      toAgent: { id: "hex", name: "Hex", kind: "agent" },
    }, 1, "Puck");
    const ordinary = projector.loaded.projectTranscriptEntry({
      kind: "message",
      id: "m3",
      role: "user",
      content: "hello",
      timestampMs: 3,
    }, 2, "Hex");
    const outboundBarok = projector.loaded.projectTranscriptEntry({
      kind: "message",
      id: "m4",
      role: "assistant",
      content: "to barok",
      timestampMs: 4,
      toAgent: { id: "barok", name: "Barok", kind: "agent" },
    }, 3, "Puck");
    const outboundHex2 = projector.loaded.projectTranscriptEntry({
      kind: "message",
      id: "m5",
      role: "assistant",
      content: "to hex again",
      timestampMs: 5,
      toAgent: { id: "hex", name: "Hex", kind: "agent" },
    }, 4, "Puck");

    const mixed = grouper.loaded.groupAgentCommRows([inbound, outbound]);
    assert.equal(mixed.length, 1);
    assert.equal(mixed[0].kind, "agent-comm-group");
    assert.equal(mixed[0].id, "m1:agent-comm");
    assert.equal(mixed[0].summary.kind, "thread");

    const broken = grouper.loaded.groupAgentCommRows([inbound, ordinary, outbound]);
    assert.equal(broken.length, 3);
    assert.equal(broken[0].kind, "agent-comm-group");
    assert.deepEqual(broken[0].summary, { kind: "single", direction: "inbound", peer: { id: "puck", name: "Puck" } });
    assert.equal(broken[1].id, "m3");
    assert.deepEqual(broken[2].summary, { kind: "single", direction: "outbound", peer: { id: "hex", name: "Hex" } });

    const fanout = grouper.loaded.groupAgentCommRows([outbound, outboundBarok]);
    assert.equal(fanout[0].summary.kind, "fanout");
    assert.deepEqual(fanout[0].summary.peers, [
      { id: "hex", name: "Hex" },
      { id: "barok", name: "Barok" },
    ]);

    const singleOut = grouper.loaded.groupAgentCommRows([outboundHex2]);
    assert.deepEqual(singleOut[0].summary, {
      kind: "single",
      direction: "outbound",
      peer: { id: "hex", name: "Hex" },
    });
  } finally {
    await projector.cleanup();
    await grouper.cleanup();
  }
});
