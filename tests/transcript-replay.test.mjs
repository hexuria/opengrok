import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry, outfileName) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-transcript-replay-"));
  const output = path.join(temporary, outfileName);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("already-replied user messages are not prepended on the next turn", async () => {
  const loaded = await load("source/host/runner/conversation-state.ts", "conversation-state.mjs");
  try {
    const entries = [
      { kind: "message", role: "user", id: "t3u" },
      { kind: "send-message", id: "t3s0" },
      { kind: "message", role: "user", id: "t4u" },
      { kind: "send-message", id: "t4s0" },
      { kind: "send-message", id: "t4s1" },
      { kind: "message", role: "user", id: "t5u" },
    ];
    const users = [
      { id: "t3u", text: "sup dog" },
      { id: "t4u", text: "who is elon musk" },
      { id: "t5u", text: "who is uriah galang" },
    ];
    const lastReplied = loaded.module.lastRepliedUserMessageId(entries);
    assert.equal(lastReplied, "t4u");
    const recent = loaded.module.userMessagesAfterLastReply(users, lastReplied);
    assert.deepEqual(recent.map((message) => message.id), ["t5u"]);
    assert.deepEqual(
      loaded.module.selectUnconfirmedUserMessages({
        recentUserMessages: recent,
        currentMessageId: "t5u",
        hasConfirmedTurns: false,
      }),
      [],
    );
  } finally {
    await loaded.dispose();
  }
});

test("journal prepare bootstraps recover when the process has no in-memory checkpoint", async () => {
  const loaded = await load("source/host/transcript-mirror/transcript-mirror.ts", "transcript-mirror.mjs");
  const transcriptsDir = await mkdtemp(path.join(os.tmpdir(), "grok-journal-"));
  try {
    const deriver = {
      async initial() {
        return [{ id: "seed", line: JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hi" }] } }) }];
      },
      async derive() {
        return { occurrences: [] };
      },
    };
    const journal = new loaded.module.FileTranscriptMirror(transcriptsDir, () => {}, deriver);
    const checkpoint = { turns: [Uint8Array.from([1, 2, 3])] };
    await journal.claimConversation("agent-1");
    await journal.prepareCheckpoint({}, "agent-1", checkpoint, {});
    await journal.commitCheckpoint({}, "agent-1");
  } finally {
    await loaded.dispose();
    await rm(transcriptsDir, { recursive: true, force: true });
  }
});
