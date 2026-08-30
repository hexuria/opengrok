import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-transcript-"));
  const output = path.join(temporary, "inference-router.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("routed transcript preserves structured MCP mention rich text across reload", async () => {
  const loaded = await loadModule();
  try {
    const richText = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [
        { type: "mention", attrs: { id: "mcp:3213107", label: "Gmail" } },
        { type: "text", text: " what's new?" },
      ] }],
    });
    const store = loaded.module.parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{
          provider: "codex",
          role: "user",
          content: "@Gmail what's new?",
          richText,
          id: "t1u",
          clientNonce: "nonce-1",
          timestampMs: 123,
        }],
      },
    });
    const projected = loaded.module.projectInferenceRouterTranscriptEntry(store.agents.agent[0]);
    assert.equal(projected.richText, richText);
    assert.deepEqual(JSON.parse(projected.richText).content[0].content[0], {
      type: "mention",
      attrs: { id: "mcp:3213107", label: "Gmail" },
    });
  } finally {
    await loaded.dispose();
  }
});

test("routed send persists user-attachment rows and strips host-leak comments", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-inference-attach-"));
  try {
    const comment = `<!--cursor-user-attachment:${JSON.stringify({
      kind: "user-attachment",
      file_path: "data:image/png;base64,iVBORw0KGgo=",
      file_name: "Screenshot 1.png",
    })}-->`;
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
      version: 1,
      mcpBoxServers: [],
      autoUpdateWhenIdleOptIn: false,
      egressTunnelEnabled: false,
      webauthnProxyEnabled: true,
      mcpCustomInstructions: {},
      mcpCustomInstructionsByServerId: {},
      mcpDisabledToolsByServerId: {},
      conciergeConsent: "unset",
      settingsMigrations: ["downgrade-persisted-max-fast"],
      inferenceProvider: "openrouter",
    }));
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "agent" }];
        if (method === "listRoutedMcpTools") return [];
        throw new Error(`unexpected remote ${method}`);
      },
      now: () => 1_700_000_000_000,
    });
    const result = await router.dispatch("sendPrompt", {
      agentId: "agent",
      prompt: `look ${comment}`,
      attachmentPaths: ["/tmp/notes.pdf"],
      attachmentNames: ["notes.pdf"],
      clientNonce: "n1",
    });
    assert.equal(result.handled, true);
    const storePath = path.join(dataDir, "inference-router-transcript.json");
    let storeRaw = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        storeRaw = JSON.parse(await readFile(storePath, "utf8"));
        if (Array.isArray(storeRaw?.agents?.agent) && storeRaw.agents.agent.length > 0) break;
      } catch {
        storeRaw = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const store = loaded.module.parseInferenceRouterTranscriptStore(storeRaw);
    const rows = store.agents.agent ?? [];
    const attachments = rows.filter((row) => row.kind === "user-attachment");
    const user = rows.find((row) => row.role === "user");
    assert.equal(attachments.length >= 1, true);
    assert.ok(attachments.some((row) => row.file_name === "Screenshot 1.png" && row.file_path.startsWith("data:image/png")));
    assert.ok(attachments.some((row) => row.file_path === "/tmp/notes.pdf" && row.file_name === "notes.pdf"));
    assert.equal(user?.content.includes("cursor-user-attachment"), false);
    assert.equal(user?.content.trim(), "look");
    const projected = attachments.map((row) => loaded.module.projectInferenceRouterTranscriptEntry(row));
    assert.equal(projected.every((row) => row.kind === "user-attachment"), true);
    assert.equal(projected.every((row) => typeof row.file_path === "string" && row.file_path.length > 0), true);
    const listed = await router.dispatch("getAgentTranscriptTail", { id: "agent", limit: 50 });
    const listedAttachments = listed.value.entries.filter((entry) => entry.kind === "user-attachment");
    assert.equal(listedAttachments.length, attachments.length);
    assert.equal(listedAttachments.every((entry) => typeof entry.file_path === "string"), true);
    assert.equal(JSON.stringify(events).includes("cursor-user-attachment"), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("routed transcript rejects malformed rich text carriers", async () => {
  const loaded = await loadModule();
  try {
    const store = loaded.module.parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{ provider: "codex", role: "user", content: "@Gmail", richText: {}, id: "t1u", timestampMs: 123 }],
      },
    });
    assert.deepEqual(store.agents.agent, []);
  } finally {
    await loaded.dispose();
  }
});

test("Claude roster createAgent stays local and does not call Cursor", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-inference-roster-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
      version: 1,
      mcpBoxServers: [],
      autoUpdateWhenIdleOptIn: false,
      egressTunnelEnabled: false,
      webauthnProxyEnabled: true,
      mcpCustomInstructions: {},
      mcpCustomInstructionsByServerId: {},
      mcpDisabledToolsByServerId: {},
      conciergeConsent: "unset",
      settingsMigrations: ["downgrade-persisted-max-fast"],
      inferenceProvider: "claude-code",
    }));
    const remote = [];
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent(family, payload) { events.push({ family, payload }); },
      async dispatchRemote(method) {
        remote.push(method);
        throw new Error(`Cursor must not handle ${method}`);
      },
      subscriptionAuth: {
        async getStatus() { return { provider: "claude-code", installed: true, authenticated: true, executablePath: "/bin/claude", loginCommand: ["claude", "/login"], prompt: "signed in" }; },
        async startLogin() { throw new Error("roster must not login"); },
        async logout() { throw new Error("roster must not logout"); },
      },
    });
    const created = await router.dispatch("createAgent", { name: "New Bot", description: "", origin: "user", clientNonce: "n-create" });
    assert.equal(created.handled, true);
    assert.equal(created.value.agent.name, "New Bot");
    assert.equal(typeof created.value.agent.id, "string");
    const listed = await router.dispatch("listAgents", {});
    assert.equal(listed.handled, true);
    assert.equal(listed.value.length, 1);
    assert.equal(listed.value[0].id, created.value.agent.id);
    assert.equal(typeof listed.value[0].snapshotEpoch, "string");
    assert.equal(listed.value[0].snapshotEpoch.length > 0, true);
    assert.equal(typeof listed.value[0].snapshotSeq, "number");
    assert.equal(typeof listed.value[0].path, "string");
    assert.deepEqual(remote, []);
    assert.equal(events.some((event) => event.family === "agents"), true);
    const seed = events.find((event) => event.family === "agents");
    assert.equal(seed.payload.coverage.kind, "complete-roster");
    assert.equal(typeof seed.payload.agents[0].snapshotEpoch, "string");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("listAgents stamps snapshotEpoch so a persisted local roster loads on launch", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-inference-roster-seed-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
      version: 1,
      mcpBoxServers: [],
      autoUpdateWhenIdleOptIn: false,
      egressTunnelEnabled: false,
      webauthnProxyEnabled: true,
      mcpCustomInstructions: {},
      mcpCustomInstructionsByServerId: {},
      mcpDisabledToolsByServerId: {},
      conciergeConsent: "unset",
      settingsMigrations: ["downgrade-persisted-max-fast"],
      inferenceProvider: "claude-code",
    }));
    await writeFile(path.join(dataDir, "inference-router-roster.json"), JSON.stringify({
      schemaVersion: 1,
      agents: [
        { id: "claude-1", name: "Claude", description: "", title: "", createdAt: 1, updatedAt: 1, origin: "user" },
        { id: "bot-2", name: "New Bot", description: "", title: "", createdAt: 2, updatedAt: 2, origin: "user" },
      ],
    }));
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent(family, payload) { events.push({ family, payload }); },
      async dispatchRemote(method) { throw new Error(`Cursor must not handle ${method}`); },
    });
    const listed = await router.dispatch("listAgents", {});
    assert.equal(listed.handled, true);
    assert.equal(listed.value.length, 2);
    assert.equal(listed.value[0].name, "Claude");
    assert.equal(listed.value[1].name, "New Bot");
    assert.equal(typeof listed.value[0].snapshotEpoch, "string");
    assert.equal(listed.value[0].snapshotEpoch, listed.value[1].snapshotEpoch);
    assert.equal(listed.value[0].snapshotSeq, listed.value[1].snapshotSeq);
    const published = events.find((event) => event.family === "agents");
    assert.equal(published.payload.agents.length, 2);
    assert.equal(published.payload.coverage.kind, "complete-roster");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("Claude createAgentAutomation stays local and does not invent an OS timer", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-inference-routines-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
      version: 1,
      mcpBoxServers: [],
      autoUpdateWhenIdleOptIn: false,
      egressTunnelEnabled: false,
      webauthnProxyEnabled: true,
      mcpCustomInstructions: {},
      mcpCustomInstructionsByServerId: {},
      mcpDisabledToolsByServerId: {},
      conciergeConsent: "unset",
      settingsMigrations: ["downgrade-persisted-max-fast"],
      inferenceProvider: "claude-code",
    }));
    const remote = [];
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent(family, payload) { events.push({ family, payload }); },
      async dispatchRemote(method) {
        remote.push(method);
        throw new Error(`Cursor must not handle ${method}`);
      },
      subscriptionAuth: {
        async getStatus() { return { provider: "claude-code", installed: true, authenticated: true, executablePath: "/bin/claude", loginCommand: ["claude", "/login"], prompt: "signed in" }; },
        async startLogin() { throw new Error("routine must not login"); },
        async logout() { throw new Error("routine must not logout"); },
      },
    });
    const created = await router.dispatch("createAgent", { name: "Claude", origin: "user" });
    const agentId = created.value.agent.id;
    const listed = await router.dispatch("createAgentAutomation", {
      id: agentId,
      spec: { name: "Hourly quote", prompt: "Tell the user the time and a custom quote.", trigger: { type: "cron", schedule: "0 * * * *" }, isEnabled: true },
    });
    assert.equal(listed.handled, true);
    assert.equal(listed.value.length, 1);
    assert.equal(listed.value[0].name, "Hourly quote");
    assert.equal(listed.value[0].trigger.type, "cron");
    const fetched = await router.dispatch("getAgentAutomations", { id: agentId });
    assert.equal(fetched.value.length, 1);
    assert.deepEqual(remote, []);
    assert.equal(events.some((event) => event.family === "automations"), true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("local roster stores avatars from setAgentAvatarBytes and serves getAgentAvatar", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-avatar-roster-"));
  const cleanup = async () => { await rm(dataDir, { recursive: true, force: true }); await loaded.dispose(); };
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ version: 1, inferenceProvider: "openrouter" }));
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent: () => {},
      dispatchRemote: async (method) => { throw new Error(`unexpected remote ${method}`); },
      now: () => 1_700_000_000_000,
    });
    const created = await router.dispatch("createAgent", { name: "Avatar Bot" });
    assert.equal(created.handled, true);
    const agentId = created.value.agent.id;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const set = await router.dispatch("setAgentAvatarBytes", { id: agentId, pngBase64: png });
    assert.equal(set.handled, true);
    assert.equal(set.value.avatarDataUrl, `data:image/png;base64,${png}`);
    assert.equal(typeof set.value.avatarVersion, "number");
    const fetched = await router.dispatch("getAgentAvatar", { id: agentId });
    assert.equal(fetched.handled, true);
    assert.equal(fetched.value.dataUrl, `data:image/png;base64,${png}`);
    const listed = await router.dispatch("listAgents", {});
    assert.equal(listed.value.find((agent) => agent.id === agentId).avatarDataUrl, `data:image/png;base64,${png}`);
    const cleared = await router.dispatch("setAgentAvatarBytes", { id: agentId, pngBase64: null });
    assert.equal(cleared.value.avatarDataUrl, null);
    assert.equal((await router.dispatch("getAgentAvatar", { id: agentId })).value.dataUrl, null);
  } finally {
    await cleanup();
  }
});

test("routed send sniffs and persists image width/height for attachment rows", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-attachment-dims-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ version: 1, inferenceProvider: "openrouter" }));
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEJMDEgAwA+bQEQaNIfFgAAAABJRU5ErkJggg==";
    const pngBytes = Buffer.from(png, "base64");
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent: () => {},
      dispatchRemote: async (method, args) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "readAttachmentChunk") {
          if (args.length === 0) return { bytesBase64: "", totalSize: pngBytes.length };
          return { bytesBase64: pngBytes.subarray(args.offset, args.offset + args.length).toString("base64"), totalSize: pngBytes.length };
        }
        if (method === "listRoutedMcpTools") return [];
        throw new Error(`unexpected remote ${method}`);
      },
      now: () => 1_700_000_000_000,
    });
    const result = await router.dispatch("sendPrompt", {
      agentId: "agent",
      prompt: "look at this",
      attachmentPaths: ["/home/box/sand-data/agents/agent/attachments/pic.png"],
      attachmentNames: ["pic.png"],
      clientNonce: "n1",
    });
    assert.equal(result.handled, true);
    const storePath = path.join(dataDir, "inference-router-transcript.json");
    let row = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const store = JSON.parse(await readFile(storePath, "utf8"));
        row = (store?.agents?.agent ?? []).find((entry) => entry.kind === "user-attachment") ?? null;
        if (row != null) break;
      } catch { /* not yet written */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.notEqual(row, null);
    assert.equal(row.width, 2);
    assert.equal(row.height, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("deleting an agent evicts its roster row, transcript metadata, and routines", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-delete-metadata-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ version: 1, inferenceProvider: "openrouter" }));
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent: () => {},
      dispatchRemote: async (method) => { if (method === "getAgentTranscriptTail") return { entries: [] }; throw new Error(`unexpected remote ${method}`); },
      now: () => 1_700_000_000_000,
    });
    const created = await router.dispatch("createAgent", { name: "Doomed Bot" });
    const agentId = created.value.agent.id;
    await router.dispatch("setAgentAvatarBytes", { id: agentId, pngBase64: Buffer.from([1, 2, 3]).toString("base64") });
    await router.dispatch("updateAutomationsState", { agentId, state: { target: "routine", action: "create", name: "tick", prompt: "hi", schedule: "0 * * * *" } }).catch(() => {});
    const removed = await router.dispatch("deleteAgents", { ids: [agentId] });
    assert.equal(removed.handled, true);
    const roster = JSON.parse(await readFile(path.join(dataDir, "inference-router-roster.json"), "utf8"));
    assert.equal(roster.agents.some((agent) => agent.id === agentId), false);
    let automations = { agents: {} };
    try { automations = JSON.parse(await readFile(path.join(dataDir, "inference-automations.json"), "utf8")); } catch { /* store may not exist */ }
    assert.equal(Object.hasOwn(automations.agents ?? {}, agentId), false);
    let transcripts = { agents: {} };
    try { transcripts = JSON.parse(await readFile(path.join(dataDir, "inference-router-transcript.json"), "utf8")); } catch { /* store may not exist */ }
    assert.equal(Object.hasOwn(transcripts.agents ?? {}, agentId), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("first transcript load backfills missing image dimensions into the store", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-dims-backfill-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ version: 1, inferenceProvider: "openrouter" }));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEJMDEgAwA+bQEQaNIfFgAAAABJRU5ErkJggg==", "base64");
    await writeFile(path.join(dataDir, "inference-router-transcript.json"), JSON.stringify({
      schemaVersion: 2,
      agents: { agent: [
        { provider: "openrouter", kind: "user-attachment", id: "t0a0", file_path: "/home/box/sand-data/agents/agent/attachments/legacy.png", timestampMs: 1 },
        { provider: "openrouter", role: "user", content: "look", id: "t0u", timestampMs: 1 },
      ] },
    }));
    const chunkCalls = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent: () => {},
      dispatchRemote: async (method, args) => {
        if (method === "readAttachmentChunk") {
          chunkCalls.push(args.offset);
          if (args.length === 0) return { bytesBase64: "", totalSize: png.length };
          return { bytesBase64: png.subarray(args.offset, args.offset + args.length).toString("base64"), totalSize: png.length };
        }
        throw new Error(`unexpected remote ${method}`);
      },
      now: () => 1_700_000_000_000,
    });
    const served = await router.dispatch("getAgentTranscriptTail", { id: "agent" });
    assert.equal(served.handled, true);
    let row = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const store = JSON.parse(await readFile(path.join(dataDir, "inference-router-transcript.json"), "utf8"));
      row = store.agents.agent.find((entry) => entry.kind === "user-attachment");
      if (row?.width != null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(row.width, 2);
    assert.equal(row.height, 2);
    assert.equal(chunkCalls.length > 0, true);
    // second load: already backfilled, no further byte reads
    const before = chunkCalls.length;
    await router.dispatch("getAgentTranscriptTail", { id: "agent" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(chunkCalls.length, before);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("clearAgentImageMetadata busts saved dimensions and re-arms the backfill", async () => {
  const loaded = await loadModule();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-dims-bust-"));
  try {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ version: 1, inferenceProvider: "openrouter" }));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEJMDEgAwA+bQEQaNIfFgAAAABJRU5ErkJggg==", "base64");
    await writeFile(path.join(dataDir, "inference-router-transcript.json"), JSON.stringify({
      schemaVersion: 2,
      agents: { agent: [{ provider: "openrouter", kind: "user-attachment", id: "t0a0", file_path: "/home/box/x/a.png", width: 999, height: 111, timestampMs: 1 }] },
    }));
    let reads = 0;
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir,
      postEvent: () => {},
      dispatchRemote: async (method, args) => {
        if (method === "readAttachmentChunk") {
          reads += 1;
          if (args.length === 0) return { bytesBase64: "", totalSize: png.length };
          return { bytesBase64: png.subarray(args.offset, args.offset + args.length).toString("base64"), totalSize: png.length };
        }
        throw new Error(`unexpected remote ${method}`);
      },
      now: () => 1_700_000_000_000,
    });
    // wrong metadata present: first load does NOT re-read
    await router.dispatch("getAgentTranscriptTail", { id: "agent" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(reads, 0);
    const busted = await router.dispatch("clearAgentImageMetadata", { id: "agent" });
    assert.equal(busted.handled, true);
    assert.equal(busted.value.cleared, 1);
    await router.dispatch("getAgentTranscriptTail", { id: "agent" });
    let row = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const store = JSON.parse(await readFile(path.join(dataDir, "inference-router-transcript.json"), "utf8"));
      row = store.agents.agent[0];
      if (row.width === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(row.width, 2);
    assert.equal(row.height, 2);
    assert.equal(reads > 0, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await loaded.dispose();
  }
});
