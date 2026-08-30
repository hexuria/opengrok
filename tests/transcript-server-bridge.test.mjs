import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry, outfileName) {
  return loadTogether([entry], outfileName);
}

async function loadTogether(entries, outfileName) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-transcript-server-"));
  const barrel = path.join(temporary, "barrel.mjs");
  const output = path.join(temporary, outfileName);
  await writeFile(
    barrel,
    entries
      .map((entry) => `export * from ${JSON.stringify(path.join(repoRoot, entry))};\n`)
      .join(""),
  );
  await build({
    entryPoints: [barrel],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function closedGates() {
  return { serverTail: false, storeRead: false, storeFirst: false, doubleWrite: false };
}

function serverEntry(id = "server-1", text = "from-server") {
  return {
    seq: 1n,
    entryKind: "message",
    entryId: id,
    body: new TextEncoder().encode(JSON.stringify({ id, kind: "message", text })),
    bodyOmitted: false,
    updatedSeq: 1n,
  };
}

test("a recovered flag in experiment-config.gen.ts is not moved by PORTED_FLAGS", async () => {
  const ported = await load(
    "source/shared/node/experiments/experiment-config.ported.ts",
    "experiment-config.ported.mjs",
  );
  const generated = await load(
    "source/shared/node/experiments/experiment-config.gen.ts",
    "experiment-config.gen.mjs",
  );
  try {
    const merged = ported.module.FLAGS;
    for (const name of [
      "sand_transcript_server_tail",
      "sand_transcript_store_read",
      "sand_transcript_store_first",
      "sand_transcript_double_write",
    ]) {
      assert.deepEqual(ported.module.PORTED_FLAGS[name], { client: true, default: false });
      assert.equal(Object.hasOwn(generated.module.FLAGS, name), false);
      assert.equal(merged[name].default, false);
    }
    for (const [name, flag] of Object.entries(generated.module.FLAGS)) {
      assert.deepEqual(merged[name], flag, `ported registry moved generated flag ${name}`);
    }
  } finally {
    await ported.dispose();
    await generated.dispose();
  }
});

test("with all transcript flags off the bridge never calls the server and returns local data", async () => {
  const loaded = await load(
    "source/host/transcript-server/transcript-server-bridge.ts",
    "transcript-server-bridge.mjs",
  );
  try {
    const calls = [];
    const client = {
      async listGrokBotTranscriptEntries(request) {
        calls.push(["list", request]);
        return { entries: [], generation: 1 };
      },
      watchGrokBotTranscripts(request) {
        calls.push(["watch", request]);
        return (async function* () {})();
      },
      async commitGrokBotTranscriptEntries(request) {
        calls.push(["commit", request]);
      },
    };
    const local = [{ id: "local-1", kind: "message", text: "hi" }];
    const bridge = new loaded.module.TranscriptServerBridge({
      gates: closedGates,
      client,
    });
    assert.deepEqual(await bridge.bootstrapRead("agent-1", local), local);
    assert.deepEqual(bridge.overlayEntries("agent-1", local), local);
    assert.deepEqual(await bridge.readTail("agent-1", { entries: local }, { limit: 10 }), {
      entries: local,
    });
    await bridge.commit("agent-1", local);
    bridge.ensureWatch("agent-1");
    assert.deepEqual(calls, []);
  } finally {
    await loaded.dispose();
  }
});

test("store_first alone is not a main-process read gate", async () => {
  const loaded = await load(
    "source/host/transcript-server/transcript-server-bridge.ts",
    "transcript-server-bridge.mjs",
  );
  try {
    const calls = [];
    const client = {
      async listGrokBotTranscriptEntries(request) {
        calls.push(["list", request.agentId]);
        return { entries: [serverEntry()], generation: 1 };
      },
      watchGrokBotTranscripts() {
        calls.push(["watch"]);
        return (async function* () {})();
      },
      async commitGrokBotTranscriptEntries() {
        calls.push(["commit"]);
      },
    };
    const local = [{ id: "local-1", kind: "message" }];
    const bridge = new loaded.module.TranscriptServerBridge({
      gates: () => ({ serverTail: false, storeRead: false, storeFirst: true, doubleWrite: false }),
      client,
    });
    assert.deepEqual(await bridge.bootstrapRead("agent-1", local), local);
    assert.deepEqual(await bridge.readTail("agent-1", { entries: local }), { entries: local });
    bridge.ensureWatch("agent-1");
    assert.deepEqual(calls, []);
  } finally {
    await loaded.dispose();
  }
});

test("store_read / server_tail use List as the live read path and do not start Watch", async () => {
  const loaded = await load(
    "source/host/transcript-server/transcript-server-bridge.ts",
    "transcript-server-bridge.mjs",
  );
  try {
    const calls = [];
    const client = {
      async listGrokBotTranscriptEntries(request) {
        calls.push(["list", request.agentId, request.limit]);
        return { entries: [serverEntry()], generation: 4 };
      },
      watchGrokBotTranscripts(request) {
        calls.push(["watch", request.cursors?.[0]?.agentId]);
        return (async function* () {})();
      },
      async commitGrokBotTranscriptEntries(request) {
        calls.push(["commit", request.agentId, request.entries.map((entry) => entry.entryId)]);
      },
    };

    const readBridge = new loaded.module.TranscriptServerBridge({
      gates: () => ({ serverTail: true, storeRead: true, storeFirst: false, doubleWrite: false }),
      client,
    });
    const local = [{ id: "local-1", kind: "message", text: "hi" }];
    const listed = await readBridge.bootstrapRead("agent-1", local);
    assert.deepEqual(listed.map((entry) => entry.id), ["server-1"]);
    const tailed = await readBridge.readTail("agent-1", { entries: local }, { limit: 20 });
    assert.deepEqual(tailed.entries.map((entry) => entry.id), ["server-1"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      calls.filter(([name]) => name === "list"),
      [
        ["list", "agent-1", 5_000],
        ["list", "agent-1", 20],
      ],
    );
    assert.deepEqual(calls.filter(([name]) => name === "watch"), []);
    assert.equal(calls.some(([name]) => name === "commit"), false);

    const writeBridge = new loaded.module.TranscriptServerBridge({
      gates: () => ({ serverTail: false, storeRead: false, storeFirst: false, doubleWrite: true }),
      client,
    });
    await writeBridge.commit("agent-1", local);
    assert.deepEqual(
      calls.filter(([name]) => name === "commit"),
      [["commit", "agent-1", ["local-1"]]],
    );
  } finally {
    await loaded.dispose();
  }
});

test("Watch helper exists and is invoked only when explicitly started", async () => {
  const loaded = await load(
    "source/host/transcript-server/transcript-server-bridge.ts",
    "transcript-server-bridge.mjs",
  );
  try {
    const calls = [];
    let watchResolve;
    const watchStarted = new Promise((resolve) => {
      watchResolve = resolve;
    });
    const client = {
      async listGrokBotTranscriptEntries() {
        return { entries: [serverEntry()], generation: 4 };
      },
      watchGrokBotTranscripts(request) {
        calls.push(["watch", request.cursors?.[0]?.agentId]);
        watchResolve();
        return (async function* () {
          yield {
            frame: {
              case: "rows",
              value: {
                agentId: "agent-1",
                generation: 4,
                entries: [serverEntry("watched-1", "watched")],
                deletes: [],
                replay: true,
              },
            },
          };
        })();
      },
      async commitGrokBotTranscriptEntries() {},
    };
    const bridge = new loaded.module.TranscriptServerBridge({
      gates: () => ({ serverTail: true, storeRead: false, storeFirst: false, doubleWrite: false }),
      client,
    });
    await bridge.bootstrapRead("agent-1", [{ id: "local-1", kind: "message" }]);
    assert.deepEqual(calls, []);
    bridge.ensureWatch("agent-1");
    await watchStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, [["watch", "agent-1"]]);
    assert.deepEqual(bridge.cachedEntries("agent-1")?.map((entry) => entry.id), ["watched-1"]);
  } finally {
    await loaded.dispose();
  }
});

test("server failures fail closed and do not replace local data", async () => {
  const loaded = await load(
    "source/host/transcript-server/transcript-server-bridge.ts",
    "transcript-server-bridge.mjs",
  );
  try {
    const client = {
      async listGrokBotTranscriptEntries() {
        throw new Error("list down");
      },
      watchGrokBotTranscripts() {
        throw new Error("watch down");
      },
      async commitGrokBotTranscriptEntries() {
        throw new Error("commit down");
      },
    };
    const local = [{ id: "local-1", kind: "message" }];
    const diagnostics = [];
    const bridge = new loaded.module.TranscriptServerBridge({
      gates: () => ({ serverTail: true, storeRead: true, storeFirst: true, doubleWrite: true }),
      client,
      log: (message) => diagnostics.push(message),
    });
    assert.deepEqual(await bridge.bootstrapRead("agent-1", local), local);
    assert.deepEqual(await bridge.readTail("agent-1", { entries: local }), { entries: local });
    await bridge.commit("agent-1", local);
    assert.ok(diagnostics.some((line) => line.includes("ListGrokBotTranscriptEntries")));
    assert.ok(diagnostics.some((line) => line.includes("CommitGrokBotTranscriptEntries")));
  } finally {
    await loaded.dispose();
  }
});

test("conversation-state sync reads stay local when the bridge is not installed", async () => {
  const loaded = await load(
    "source/host/extensions/session/session-conversation-state.ts",
    "session-conversation-state.mjs",
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-conversation-state-"));
  try {
    const state = new loaded.module.SandSessionConversationState({
      rootDir: root,
      ctx: {},
      openSession: async () => {
        throw new Error("should not open");
      },
      deriveOutline: () => [],
      deriveState: async () => ({ turns: [] }),
    });
    assert.deepEqual(state.readAgentTranscriptEntries("missing-agent"), []);
    assert.deepEqual(state.readAgentTranscriptTail("missing-agent", { limit: 10 }), { entries: [] });
  } finally {
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("agent-db transcript pages overlay a List cache and stay local when flags are off", async () => {
  const loaded = await loadTogether(
    [
      "source/host/extensions/session/agent-db-transcript-pages.ts",
      "source/host/transcript-server/transcript-server-bridge.ts",
    ],
    "pages-and-bridge.mjs",
  );
  try {
    const localRow = { id: "local-1", kind: "message", content: "hi" };
    const statements = {
      listTranscriptPage: { all: () => [{ seq: 1, entry: JSON.stringify(localRow) }] },
      listTranscriptWindow: { all: () => [{ seq: 1, entry: JSON.stringify(localRow) }] },
      listTranscriptTail: { all: () => [{ seq: 1, entry: JSON.stringify(localRow) }] },
    };
    const localTail = loaded.module.readTranscriptTail(statements, { limit: 10 }, "agent-1");
    assert.deepEqual(localTail.entries.map((entry) => entry.id), ["local-1"]);

    const bridge = new loaded.module.TranscriptServerBridge({
      gates: () => ({ serverTail: true, storeRead: true, storeFirst: false, doubleWrite: false }),
      client: {
        async listGrokBotTranscriptEntries() {
          return { entries: [serverEntry("server-page")], generation: 2 };
        },
        watchGrokBotTranscripts() {
          return (async function* () {})();
        },
        async commitGrokBotTranscriptEntries() {},
      },
    });
    loaded.module.installTranscriptServerBridge(bridge);
    await bridge.list("agent-1", { limit: 10 });
    const overlaid = loaded.module.readTranscriptTail(statements, { limit: 10 }, "agent-1");
    assert.deepEqual(overlaid.entries.map((entry) => entry.id), ["server-page"]);
  } finally {
    loaded.module.installTranscriptServerBridge(undefined);
    await loaded.dispose();
  }
});

test("host initial load Lists after the local SQLite read when a main-process gate is on", async () => {
  const loaded = await loadTogether(
    [
      "source/host/host-initial-transcript-load.ts",
      "source/host/transcript-server/transcript-server-bridge.ts",
    ],
    "initial-load-and-bridge.mjs",
  );
  try {
    const calls = [];
    const bridge = new loaded.module.TranscriptServerBridge({
      gates: () => ({ serverTail: false, storeRead: true, storeFirst: false, doubleWrite: false }),
      client: {
        async listGrokBotTranscriptEntries(request) {
          calls.push(request.agentId);
          return { entries: [serverEntry()], generation: 1 };
        },
        watchGrokBotTranscripts() {
          return (async function* () {})();
        },
        async commitGrokBotTranscriptEntries() {},
      },
    });
    loaded.module.installTranscriptServerBridge(bridge);
    const count = await loaded.module.loadInitialTranscriptResiliently({
      ensureLoaded: async () => [{ id: "local-1", kind: "message" }],
      getActiveAgentId: () => "agent-1",
    });
    assert.equal(count, 1);
    assert.deepEqual(calls, ["agent-1"]);
  } finally {
    loaded.module.installTranscriptServerBridge(undefined);
    await loaded.dispose();
  }
});

test("List/Watch encode-decode keeps user-attachment path and name", async () => {
  const loaded = await load(
    "source/host/transcript-server/transcript-server-bridge.ts",
    "transcript-server-bridge.mjs",
  );
  try {
    const local = {
      kind: "user-attachment",
      id: "optimistic:n1:a0",
      file_path: "/tmp/screenshot.png",
      file_name: "Screenshot 1.png",
      timestampMs: 1_700_000_000_000,
      clientNonce: "n1",
      batchId: "optimistic:n1:batch",
      byteSize: 2048,
    };
    const encoded = loaded.module.encodeLocalTranscriptEntry(local);
    assert.equal(encoded.entryKind, "user-attachment");
    assert.equal(encoded.entryId, "optimistic:n1:a0");
    const decoded = loaded.module.decodeServerTranscriptEntry(encoded);
    assert.deepEqual(decoded, local);
  } finally {
    await loaded.dispose();
  }
});

test("SAND_FEATURE_GATE_OVERRIDES is documented for the closed transcript flags", async () => {
  const port = await readFile(path.join(repoRoot, "docs/0.27-PORT.md"), "utf8");
  const gates = await readFile(path.join(repoRoot, "source/shared/transcript-server-gates.ts"), "utf8");
  assert.match(port, /sand_transcript_server_tail/);
  assert.match(port, /SAND_FEATURE_GATE_OVERRIDES/);
  assert.match(port, /List is the 0\.27-shaped read path/);
  assert.match(gates, /SAND_FEATURE_GATE_OVERRIDES/);
  assert.match(gates, /[Rr]enderer-only/);
});
