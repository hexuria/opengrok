import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inline-chips-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, entry)], outfile, bundle: true, format: "esm", platform: "node", loader: { ".css": "empty" }, jsx: "automatic", define: { "process.env.NODE_ENV": "\"test\"" } });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// The four link forms official Grok Bot draws as chips (docs/research/grok-bot-chat-surface-catalog.md).
test("app-scheme markdown links parse into chips; everything else stays a link", async () => {
  const { loaded, cleanup } = await load("frontend/src/recovered/features/conversation/workspace/inline-chips.tsx");
  try {
    const { parseInlineChip } = loaded;
    assert.deepEqual(parseInlineChip("sand-msg:t2s1"), { kind: "jump", address: "t2s1" });
    assert.deepEqual(parseInlineChip("sand-msg:t304u"), { kind: "jump", address: "t304u" });
    assert.deepEqual(parseInlineChip("sand-msg:tba2"), { kind: "jump", address: "tba2" });
    assert.equal(parseInlineChip("sand-msg:nonsense"), null);
    assert.deepEqual(parseInlineChip("grokbot://app/v1/settings?id=theme"), { kind: "settings", anchor: "theme" });
    assert.deepEqual(parseInlineChip("sand://app/v1/settings?id=update-channel"), { kind: "settings", anchor: "update-channel" });
    assert.deepEqual(parseInlineChip("opengrok://app/v1/plugin/add?id=404"), { kind: "plugin", pluginId: "404" });
    assert.deepEqual(parseInlineChip("grokbot://app/v1/plugin/add?id=404"), { kind: "plugin", pluginId: "404" });
    assert.deepEqual(parseInlineChip("sand-workflow:deploy-prod"), { kind: "workflow", workflowId: "deploy-prod" });
    assert.equal(parseInlineChip("sand-workflow:Not Kebab"), null);
    assert.equal(parseInlineChip("https://example.com/a-page"), null);
    assert.equal(parseInlineChip("grokbot://app/v1/settings"), null);
  } finally {
    await cleanup();
  }
});

test("message addresses follow the official grammar: t<turn>u, t<turn>s<n>, tb before the first user turn", async () => {
  const { loaded, cleanup } = await load("frontend/src/recovered/features/conversation/workspace/inline-chips.tsx");
  try {
    const { buildMessageAddressIndex } = loaded;
    const message = (id, role) => ({ kind: "message", id, role, author: role === "user" ? "You" : "Agent", text: id, timestampMs: 1 });
    const index = buildMessageAddressIndex([
      message("greeting", "assistant"),
      message("ask", "user"),
      message("answer-1", "assistant"),
      { kind: "send-message", id: "card-1", message: { type: "widget" } },
      { kind: "tool-call", id: "tool" },
      message("ask-2", "user"),
      message("answer-2", "assistant"),
    ]);
    assert.equal(index.get("tbs1"), "greeting");
    assert.equal(index.get("t1u"), "ask");
    assert.equal(index.get("t1s1"), "answer-1");
    assert.equal(index.get("t1a2"), "card-1");
    assert.equal(index.get("t2u"), "ask-2");
    assert.equal(index.get("t2s1"), "answer-2");
    assert.equal(index.get("t3u"), undefined);
  } finally {
    await cleanup();
  }
});
