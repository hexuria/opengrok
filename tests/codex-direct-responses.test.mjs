import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const source = await readFile(path.join(repoRoot, "source/host/extensions/inference/codex-direct-responses.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

function sse(events, split = 17) {
  const bytes = new TextEncoder().encode(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += split) controller.enqueue(bytes.slice(offset, offset + split));
      controller.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("direct Codex Responses transport streams text without an SDK reader", async () => {
  const { streamCodexDirectResponses } = await loadModule();
  const requests = [];
  const fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return sse([
      { type: "response.output_text.delta", delta: "DIRECT_" },
      { type: "response.output_text.delta", delta: "OK" },
      { type: "response.completed", response: { id: "resp-1", output: [{ type: "message", role: "assistant", content: [] }], usage: { input_tokens: 11, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } } } }
    ], 5);
  };
  const events = [];
  for await (const event of streamCodexDirectResponses({ fetch, endpoint: "https://example.invalid/responses", model: "gpt-test", instructions: "Grok", input: [{ role: "user", content: "hi" }] })) events.push(event);
  assert.deepEqual(events, [
    { type: "text-delta", delta: "DIRECT_" },
    { type: "text-delta", delta: "OK" },
    { type: "done", text: "DIRECT_OK", responseId: "resp-1", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 } }
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].stream, true);
});

test("direct Codex Responses transport executes Grok Bot tools and continues with the exact call id", async () => {
  const { streamCodexDirectResponses } = await loadModule();
  const requests = [];
  let toolExecution = null;
  const fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    if (requests.length === 1) return sse([
      { type: "response.output_item.done", item: { type: "reasoning", id: "reason-1", encrypted_content: "opaque" } },
      { type: "response.output_item.done", item: { type: "function_call", id: "call-item", call_id: "call-123", name: "gmail_search", arguments: "{\"query\":\"newer_than:1d\"}" } },
      { type: "response.completed", response: { id: "resp-tool", output: [], usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } } } }
    ]);
    return sse([
      { type: "response.output_text.delta", delta: "Subject" },
      { type: "response.completed", response: { id: "resp-final", output: [{ type: "message", role: "assistant", content: [] }], usage: { input_tokens: 8, output_tokens: 1, input_tokens_details: { cached_tokens: 2 } } } }
    ]);
  };
  const source = { providerIdentifier: "user-Gmail", toolName: "search_threads" };
  const events = [];
  for await (const event of streamCodexDirectResponses({
    fetch,
    endpoint: "https://example.invalid/responses",
    model: "gpt-test",
    instructions: "Use connected tools",
    input: [{ role: "user", content: "latest email" }],
    tools: [{ name: "gmail_search", description: "Search Gmail", parameters: { type: "object" }, source }],
    executeTool: async (tool, args, toolCallId) => {
      toolExecution = { tool, args, toolCallId };
      return { result: { case: "success", value: { subject: "Subject" } } };
    }
  })) events.push(event);

  assert.equal(requests.length, 2);
  assert.deepEqual(toolExecution, { tool: { name: "gmail_search", description: "Search Gmail", parameters: { type: "object" }, source }, args: { query: "newer_than:1d" }, toolCallId: "call-123" });
  assert.equal(requests[1].input.at(-2).type, "function_call");
  assert.deepEqual(requests[1].input.at(-1), { type: "function_call_output", call_id: "call-123", output: JSON.stringify({ result: { case: "success", value: { subject: "Subject" } } }) });
  assert.deepEqual(events.at(-1), { type: "done", text: "Subject", responseId: "resp-final", usage: { inputTokens: 28, outputTokens: 6, cacheReadTokens: 6, cacheWriteTokens: 0 } });
});

test("direct Codex Responses transport fails closed on a truncated stream", async () => {
  const { streamCodexDirectResponses } = await loadModule();
  await assert.rejects(async () => {
    for await (const _event of streamCodexDirectResponses({
      fetch: async () => new Response("data: {\"type\":\"response.output_text.delta\"", { status: 200 }),
      endpoint: "https://example.invalid/responses",
      model: "gpt-test",
      instructions: "Grok",
      input: [{ role: "user", content: "hi" }]
    })) {}
  }, /incomplete SSE event/);
});
