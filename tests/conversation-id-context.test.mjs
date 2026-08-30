import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConnectError, Code } from "@connectrpc/connect";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entryContents) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-conversation-id-"));
  const output = path.join(temporary, "bundle.mjs");
  await build({
    stdin: {
      contents: entryContents,
      resolveDir: repoRoot,
      loader: "ts",
      sourcefile: "conversation-id-entry.ts",
    },
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("inference stream and agent runtime share one conversationId context key", async () => {
  const loaded = await load(`
    export { conversationIdKey as agentKey, requestIdKey as agentRequestKey } from "./source/packages/agent/utils/request-id.ts";
    export { conversationIdKey as protoKey, requestIdKey as protoRequestKey } from "./source/packages/chat-inference-proto/client.ts";
    export { createContext } from "./source/packages/context/core.ts";
  `);
  try {
    const { agentKey, protoKey, agentRequestKey, protoRequestKey, createContext } = loaded.module;
    assert.equal(agentKey.symbol, protoKey.symbol);
    assert.equal(agentRequestKey.symbol, protoRequestKey.symbol);
    const ctx = createContext().with(agentKey, "agent-f1ce2138").with(agentRequestKey, "req-1");
    assert.equal(ctx.get(protoKey), "agent-f1ce2138");
    assert.equal(ctx.get(protoRequestKey), "req-1");
  } finally {
    await loaded.dispose();
  }
});

test("ConnectError without typed details does not crash agent error classification", async () => {
  const loaded = await load(`
    export { describeAgentRunError, findBackendConnectError } from "./source/host/extensions/transcript/agent-run-error.ts";
    export { classifyAgentError } from "./source/host/extensions/transcript/turn-runtime.ts";
  `);
  try {
    const error = new ConnectError("conversation_id is required", Code.InvalidArgument);
    assert.equal(loaded.module.findBackendConnectError(error, false), error);
    const described = loaded.module.describeAgentRunError(error);
    assert.match(String(described.detail ?? ""), /conversation_id is required/);
    const classified = loaded.module.classifyAgentError(error);
    assert.equal(typeof classified, "object");
  } finally {
    await loaded.dispose();
  }
});
