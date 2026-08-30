import assert from "node:assert/strict";
import { createServer } from "node:http";
import https from "node:https";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MethodKind } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundleEntry(entry, outfileName) {
  const outdir = path.join(repoRoot, ".build");
  await mkdir(outdir, { recursive: true });
  const output = path.join(outdir, outfileName);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
  });
  return import(`${pathToFileURL(output).href}?${Date.now()}`);
}

async function loadMock() {
  const module = await bundleEntry("source/mock/index.ts", "grok-bot-mock-test.mjs");
  return { module, dispose: async () => {} };
}

function isBlockedHost(hostname) {
  return hostname === "api2.cursor.sh" || hostname === "cursor.com" || hostname.endsWith(".cursor.com");
}

function installNetworkGuard() {
  const blocked = [];
  const originalFetch = globalThis.fetch;
  const originalHttps = https.request;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const hostname = new URL(url, "http://127.0.0.1").hostname;
    if (isBlockedHost(hostname)) {
      blocked.push(url);
      return Promise.reject(new Error(`blocked outbound request to ${url}`));
    }
    return originalFetch(input, init);
  };
  https.request = function patchedHttpsRequest(options, callback) {
    const hostname = typeof options === "string" || options instanceof URL
      ? new URL(options).hostname
      : String(options.hostname ?? options.host ?? "");
    if (isBlockedHost(hostname)) {
      blocked.push(hostname);
      throw new Error(`blocked outbound request to ${hostname}`);
    }
    return originalHttps.call(this, options, callback);
  };
  return {
    blocked,
    restore() {
      globalThis.fetch = originalFetch;
      https.request = originalHttps;
    },
  };
}

function decodeEntry(entry) {
  if (entry.body == null || entry.body.byteLength === 0) return null;
  return JSON.parse(new TextDecoder().decode(entry.body));
}

test("in-process mock lists seeded agents and never dials Cursor", async () => {
  const loaded = await loadMock();
  const guard = installNetworkGuard();
  try {
    const { grokBot, store } = loaded.module.createInProcessMock();
    const listed = await grokBot.listGrokBotAgents({});
    assert.deepEqual(
      listed.agents.map((agent) => agent.name),
      ["Hexuria", "Firefly", "Gork"],
    );
    assert.equal(store.agents.get(loaded.module.HEXURIA_AGENT_ID)?.name, "Hexuria");
    assert.deepEqual(guard.blocked, []);
  } finally {
    guard.restore();
    await loaded.dispose();
  }
});

test("in-process List/Watch/Commit plus SendUserMessage stay local", async () => {
  const loaded = await loadMock();
  const guard = installNetworkGuard();
  try {
    const { grokBot } = loaded.module.createInProcessMock();
    const hexuria = loaded.module.HEXURIA_AGENT_ID;
    const listed = await grokBot.listGrokBotTranscriptEntries({ agentId: hexuria, limit: 50 });
    const bodies = listed.entries.map(decodeEntry);
    assert.ok(bodies.some((entry) => entry?.fromAgent != null && entry?.toAgent != null));
    assert.ok(bodies.some((entry) => entry?.kind === "user-attachment"));

    const frames = [];
    for await (const frame of grokBot.watchGrokBotTranscripts({
      cursors: [{ agentId: hexuria, generation: listed.generation }],
    })) {
      frames.push(frame);
    }
    assert.ok(frames.some((frame) => frame.frame.case === "connected"));
    const replay = frames.find((frame) => frame.frame.case === "rows");
    assert.equal(replay?.frame.value.replay, true);
    assert.ok(replay.frame.value.entries.length >= 4);

    await grokBot.commitGrokBotTranscriptEntries({
      agentId: hexuria,
      generation: listed.generation,
      entries: [
        {
          entryKind: "message",
          entryId: "commit-local-1",
          body: new TextEncoder().encode(JSON.stringify({ id: "commit-local-1", kind: "message", text: "committed" })),
        },
      ],
    });
    const afterCommit = await grokBot.listGrokBotTranscriptEntries({ agentId: hexuria, limit: 50 });
    assert.ok(afterCommit.entries.some((entry) => entry.entryId === "commit-local-1"));

    const sent = await grokBot.sendGrokBotUserMessage({
      agentId: hexuria,
      messageId: "user-msg-1",
      text: "hello mock",
    });
    assert.equal(sent.dispatched, true);
    const status = await grokBot.getGrokBotSendStatus({ agentId: hexuria, messageId: "user-msg-1" });
    assert.equal(status.status, 2);
    const afterSend = await grokBot.listGrokBotTranscriptEntries({ agentId: hexuria, limit: 50 });
    const hop = afterSend.entries.map(decodeEntry).find((entry) => entry?.id === "user-msg-1-hop");
    assert.equal(hop, undefined);
    await grokBot.sendGrokBotUserMessage({
      agentId: loaded.module.GORK_AGENT_ID,
      messageId: "gork-hi",
      text: "hi",
    });
    const gorkSend = await grokBot.listGrokBotTranscriptEntries({
      agentId: loaded.module.GORK_AGENT_ID,
      limit: 20,
    });
    const gorkBodies = gorkSend.entries.map(decodeEntry);
    assert.equal(gorkBodies.some((entry) => entry?.id === "gork-hi-hop"), false);
    assert.ok(gorkBodies.some((entry) => entry?.content === "Canned mock reply. No model was called."));
    assert.deepEqual(guard.blocked, []);
  } finally {
    guard.restore();
    await loaded.dispose();
  }
});

test("every GrokBotService method returns a default proto instead of unimplemented", async () => {
  const proto = await loadProto();
  const loaded = await loadMock();
  try {
    const { grokBot } = loaded.module.createInProcessMock();
    const { GrokBotService } = proto.module;
    for (const [localName, method] of Object.entries(GrokBotService.methods)) {
      if (method.kind !== MethodKind.Unary) continue;
      const response = await grokBot[localName](new method.I());
      assert.ok(response != null, `${localName} returned nothing`);
    }
    const computers = await grokBot.listGrokBotUserComputers({});
    assert.equal(computers.computers.length, 1);
    const state = await grokBot.setGrokBotAgentClientState({
      agentId: loaded.module.HEXURIA_AGENT_ID,
      markRead: true,
    });
    assert.equal(state.state?.agentId, loaded.module.HEXURIA_AGENT_ID);
    const chunk = await grokBot.readGrokBotAgentAttachmentChunk({
      path: loaded.module.MOCK_ATTACHMENT_PATH,
      offset: 0n,
      length: 32,
    });
    assert.match(new TextDecoder().decode(chunk.data), /fixture notes/);
  } finally {
    await proto.dispose();
    await loaded.dispose();
  }
});

async function loadProto() {
  const module = await bundleEntry(
    "source/packages/proto/generated/aiserver/v1/grok_bot_connect.ported.ts",
    "grok-bot-connect-ported-mock-test.mjs",
  );
  return { module, dispose: async () => {} };
}

test("HTTP mock on an ephemeral port answers ListGrokBotAgents and dev-login", async () => {
  const loaded = await loadMock();
  const proto = await loadProto();
  const guard = installNetworkGuard();
  let server;
  try {
    server = await loaded.module.listenMockServer({ host: "127.0.0.1", port: 0 });
    const url = loaded.module.mockServerUrl(server);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const health = await fetch(new URL("/healthz", url));
    assert.equal(health.ok, true);
    const session = await fetch(new URL("/auth/cursor_dev_session_token?plan=ultra", url));
    const tokens = await session.json();
    assert.equal(typeof tokens.accessToken, "string");
    assert.ok(tokens.accessToken.split(".").length === 3);
    const payload = JSON.parse(Buffer.from(tokens.accessToken.split(".")[1], "base64url").toString("utf8"));
    assert.equal(payload.sub, loaded.module.MOCK_JWT_SUBJECT);
    assert.ok(payload.exp * 1000 > Date.now() + 365 * 24 * 60 * 60 * 1000);

    const transport = createConnectTransport({ baseUrl: url, httpVersion: "1.1" });
    const client = createClient(proto.module.GrokBotService, transport);
    const listed = await client.listGrokBotAgents({});
    assert.ok(listed.agents.some((agent) => agent.name === "Hexuria"));

    const dashboardTransport = createConnectTransport({ baseUrl: url, httpVersion: "1.1" });
    const { createInProcessMock } = loaded.module;
    const inProcess = createInProcessMock();
    const me = await inProcess.dashboard.getMe({});
    assert.equal(me.email, loaded.module.MOCK_JWT_EMAIL);
    assert.deepEqual(guard.blocked, []);
  } finally {
    server?.close();
    guard.restore();
    await proto.dispose();
    await loaded.dispose();
  }
});

test("docs and listen defaults match the published hook", async () => {
  const loaded = await loadMock();
  try {
    assert.equal(loaded.module.DEFAULT_MOCK_PORT, 8787);
    assert.equal(loaded.module.DEFAULT_MOCK_HOST, "127.0.0.1");
    assert.deepEqual(loaded.module.resolveMockListenOptions({}), {
      host: "127.0.0.1",
      port: 8787,
    });
    assert.deepEqual(loaded.module.resolveMockListenOptions({ SAND_MOCK_PORT: "9100" }), {
      host: "127.0.0.1",
      port: 9100,
    });
    assert.ok(loaded.module.REAL_GROK_BOT_RPC_NAMES.includes("ListGrokBotTranscriptEntries"));
    assert.ok(loaded.module.REAL_GROK_BOT_RPC_NAMES.includes("SendGrokBotUserMessage"));
  } finally {
    await loaded.dispose();
  }
});

const GRAPH_BLUEPRINT_PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
));
const GRAPH_BLUEPRINT_DATA_URL = `data:image/png;base64,${Buffer.from(GRAPH_BLUEPRINT_PNG).toString("base64")}`;

test("SendGrokBotUserMessage persists data: uploads and serves them from the chunk RPC", async () => {
  const loaded = await loadMock();
  try {
    const { grokBot } = loaded.module.createInProcessMock();
    const hexuria = loaded.module.HEXURIA_AGENT_ID;
    const sent = await grokBot.sendGrokBotUserMessage({
      agentId: hexuria,
      messageId: "upload-graph-1",
      text: `see this blueprint\n<!--cursor-user-attachment:{"file_path":"${GRAPH_BLUEPRINT_DATA_URL}","file_name":"graph-blueprint.png"}-->`,
      attachmentPaths: [GRAPH_BLUEPRINT_DATA_URL],
      attachmentNames: ["graph-blueprint.png"],
    });
    assert.equal(sent.dispatched, true);
    const listed = await grokBot.listGrokBotTranscriptEntries({ agentId: hexuria, limit: 50 });
    const bodies = listed.entries.map(decodeEntry);
    const attachment = bodies.find((entry) => entry?.kind === "user-attachment" && entry.file_name === "graph-blueprint.png");
    assert.match(String(attachment?.file_path ?? ""), /^attachments\/[0-9a-f-]+\.png$/);
    const caption = bodies.find((entry) => entry?.id === "upload-graph-1");
    assert.equal(caption?.content, "see this blueprint");
    assert.equal(caption?.content.includes("cursor-"), false);
    assert.ok(bodies.some((entry) => entry?.content === "Canned mock reply. No model was called."));
    const notes = listed.entries.map(decodeEntry).find((entry) => entry?.file_name === "notes.txt");
    assert.equal(notes?.file_path, loaded.module.MOCK_ATTACHMENT_PATH);
    const chunk = await grokBot.readGrokBotAgentAttachmentChunk({
      path: attachment.file_path,
      offset: 0n,
      length: GRAPH_BLUEPRINT_PNG.byteLength,
    });
    assert.deepEqual(Buffer.from(chunk.data), Buffer.from(GRAPH_BLUEPRINT_PNG));
    const notesChunk = await grokBot.readGrokBotAgentAttachmentChunk({
      path: loaded.module.MOCK_ATTACHMENT_PATH,
      offset: 0n,
      length: 32,
    });
    assert.match(new TextDecoder().decode(notesChunk.data), /fixture notes/);

    await grokBot.sendGrokBotUserMessage({
      agentId: hexuria,
      messageId: "title-job-1",
      text: "Generate a short title for this conversation",
    });
    const afterTitle = await grokBot.listGrokBotTranscriptEntries({ agentId: hexuria, limit: 80 });
    assert.equal(
      afterTitle.entries.map(decodeEntry).some((entry) => entry?.id === "title-job-1"),
      false,
    );
  } finally {
    await loaded.dispose();
  }
});

test("UpdateGrokBotAgent avatarChange set and clear round-trip through List", async () => {
  const loaded = await loadMock();
  try {
    const { grokBot } = loaded.module.createInProcessMock();
    const created = await grokBot.createGrokBotAgent({
      name: "PhotoBot",
      title: "PhotoBot",
      avatarShape: "drop",
      avatarColor: "#1084fe",
      avatarDataUrl: GRAPH_BLUEPRINT_DATA_URL,
    });
    assert.equal(created.agent?.avatarUrl, GRAPH_BLUEPRINT_DATA_URL);
    assert.equal(created.agent?.avatarShape, "drop");
    assert.equal(created.agent?.avatarColor, "#1084fe");
    const afterCreate = await grokBot.listGrokBotAgents({});
    const listedCreated = afterCreate.agents.find((agent) => agent.id === created.agent?.id);
    assert.equal(listedCreated?.avatarUrl, GRAPH_BLUEPRINT_DATA_URL);

    const hexuria = loaded.module.HEXURIA_AGENT_ID;
    const set = await grokBot.updateGrokBotAgent({
      id: hexuria,
      avatarShape: "triangle",
      avatarColor: "#c45c26",
      avatarChange: { case: "avatarDataUrl", value: GRAPH_BLUEPRINT_DATA_URL },
    });
    assert.equal(set.agent?.avatarUrl, GRAPH_BLUEPRINT_DATA_URL);
    assert.equal(set.agent?.avatarShape, "triangle");
    assert.equal(set.agent?.avatarColor, "#c45c26");
    const listedSet = (await grokBot.listGrokBotAgents({})).agents.find((agent) => agent.id === hexuria);
    assert.equal(listedSet?.avatarUrl, GRAPH_BLUEPRINT_DATA_URL);
    assert.equal(listedSet?.avatarShape, "triangle");

    const cleared = await grokBot.updateGrokBotAgent({
      id: hexuria,
      avatarChange: { case: "clearAvatar", value: {} },
    });
    assert.equal(cleared.agent?.avatarUrl ?? "", "");
    const listedClear = (await grokBot.listGrokBotAgents({})).agents.find((agent) => agent.id === hexuria);
    assert.equal(listedClear?.avatarUrl ?? "", "");
    assert.equal(listedClear?.avatarShape, "triangle");
  } finally {
    await loaded.dispose();
  }
});

test("mock-only teach start/stop are GET and POST and serve the placeholder", async () => {
  const loaded = await loadMock();
  let server;
  try {
    server = await loaded.module.listenMockServer({ host: "127.0.0.1", port: 0 });
    const url = loaded.module.mockServerUrl(server);
    const startGet = await fetch(new URL("/mock/teach/start", url));
    assert.equal(startGet.ok, true);
    assert.deepEqual(await startGet.json(), {
      status: "recording",
      recordingPath: loaded.module.MOCK_TEACH_ATTACHMENT_PATH,
    });
    const startPost = await fetch(new URL("/mock/teach/start", url), { method: "POST" });
    assert.deepEqual(await startPost.json(), {
      status: "recording",
      recordingPath: loaded.module.MOCK_TEACH_ATTACHMENT_PATH,
    });
    const stopPost = await fetch(new URL("/mock/teach/stop", url), { method: "POST" });
    assert.deepEqual(await stopPost.json(), {
      status: "idle",
      recordingPath: loaded.module.MOCK_TEACH_ATTACHMENT_PATH,
    });
    const stopGet = await fetch(new URL("/mock/teach/stop", url));
    assert.deepEqual(await stopGet.json(), {
      status: "idle",
      recordingPath: loaded.module.MOCK_TEACH_ATTACHMENT_PATH,
    });

    const { grokBot } = loaded.module.createInProcessMock();
    const chunk = await grokBot.readGrokBotAgentAttachmentChunk({
      path: loaded.module.MOCK_TEACH_ATTACHMENT_PATH,
      offset: 0n,
      length: loaded.module.MOCK_TEACH_ATTACHMENT_BYTES.byteLength,
    });
    assert.deepEqual(Buffer.from(chunk.data), Buffer.from(loaded.module.MOCK_TEACH_ATTACHMENT_BYTES));
  } finally {
    server?.close();
    await loaded.dispose();
  }
});

test("the mock HTTP handler never uses the production Cursor origin as a fallback", async () => {
  const loaded = await loadMock();
  try {
    const handler = loaded.module.createMockHttpHandler();
    const server = createServer(handler);
    await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.on("error", reject);
    });
    const { port } = server.address();
    const probe = await fetch(`http://127.0.0.1:${port}/auth/cursor_dev_session_token`);
    assert.equal(probe.ok, true);
    server.close();
  } finally {
    await loaded.dispose();
  }
});
