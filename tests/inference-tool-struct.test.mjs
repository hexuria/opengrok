import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadConverters() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-struct-"));
  const output = path.join(temporary, "converters.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/packages/chat-inference-proto/converters.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function requestWithTools(tools) {
  return {
    messages: [{ role: "user", content: "hello" }],
    requestedModel: { modelId: "test-model", maxMode: true, parameters: [] },
    tools,
  };
}

test("kickstart tools without parameters do not encode protobuf Struct from undefined", async () => {
  const loaded = await loadConverters();
  try {
    const request = loaded.module.buildStreamRequest(requestWithTools([
      { name: "SendMessage", description: "Say hi" },
      { name: "Search", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
      { name: "Wrapped", parameters: { jsonSchema: { type: "object", properties: { n: { type: "number" } } } } },
    ]));
    assert.deepEqual(request.tools[0].parameters.toJson(), {});
    assert.deepEqual(request.tools[1].parameters.toJson(), {
      type: "object",
      properties: { query: { type: "string" } },
    });
    assert.deepEqual(request.tools[2].parameters.toJson(), {
      type: "object",
      properties: { n: { type: "number" } },
    });
  } finally {
    await loaded.dispose();
  }
});

test("jsonObjectForProtobufStruct drops undefined fields instead of failing Struct decode", async () => {
  const loaded = await loadConverters();
  try {
    assert.deepEqual(loaded.module.jsonObjectForProtobufStruct(undefined), {});
    assert.deepEqual(loaded.module.jsonObjectForProtobufStruct({ a: 1, b: undefined }), { a: 1 });
    assert.deepEqual(
      loaded.module.jsonObjectForProtobufStruct({ jsonSchema: { type: "object" } }),
      { type: "object" },
    );
  } finally {
    await loaded.dispose();
  }
});
