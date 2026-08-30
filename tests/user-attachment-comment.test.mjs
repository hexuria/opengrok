import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-user-attachment-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
  });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const COMMENT = "source/shared/media/user-attachment-comment.ts";
const MODEL = "frontend/src/production/model.ts";

const leak = (payload) => `<!--cursor-user-attachment:${JSON.stringify(payload)}-->`;

test("parse+strip host-leak comments and never paint the payload", async () => {
  const { loaded, cleanup } = await load(COMMENT);
  try {
    const comment = leak({
      kind: "user-attachment",
      id: "optimistic:n1:a0",
      file_path: "data:image/png;base64,iVBORw0KGgo=",
      file_name: "Screenshot 1.png",
    });
    const body = `Look at this\n${comment}\n<!--cursor-timestamp:{"t":1}-->`;
    const split = loaded.splitUserAttachmentBody(body);
    assert.equal(split.text, "Look at this");
    assert.equal(split.attachments.length, 1);
    assert.equal(split.attachments[0].file_name, "Screenshot 1.png");
    assert.equal(split.attachments[0].file_path.startsWith("data:image/png"), true);
    assert.equal(loaded.stripHostLeakComments(body).includes("cursor-user-attachment"), false);
    assert.equal(loaded.stripHostLeakComments(body).includes("data:image"), false);
    const preview = loaded.previewUserAttachmentBody(comment);
    assert.equal(preview.includes("cursor-user-attachment"), false);
    assert.equal(preview.includes("data:image"), false);
    assert.equal(preview, "Sent 1 image");
  } finally {
    await cleanup();
  }
});

test("send path stamps official optimistic ids, caps at 6, and keeps path/name/bytes", async () => {
  const { loaded, cleanup } = await load(COMMENT);
  try {
    const comment = leak({
      kind: "user-attachment",
      file_path: "data:image/png;base64,abcd",
      file_name: "from-comment.png",
    });
    const collected = loaded.collectUserAttachmentsForSend({
      prompt: `caption ${comment}`,
      attachmentPaths: ["/tmp/a.png", "/tmp/b.pdf", "/tmp/c.png", "/tmp/d.png", "/tmp/e.png"],
      attachmentNames: ["a.png", "notes.pdf", "c.png", "d.png", "e.png"],
      attachments: [{ kind: "user-attachment", file_path: "/tmp/a.png", file_name: "a.png", byteSize: 12 }],
      clientNonce: "n1",
      timestampMs: 1_700_000_000_000,
    });
    assert.equal(collected.text, "caption");
    assert.equal(collected.batchId, "optimistic:n1:batch");
    assert.equal(collected.attachments.length, 6);
    assert.deepEqual(collected.attachments.map((item) => item.id), [
      "optimistic:n1:a0",
      "optimistic:n1:a1",
      "optimistic:n1:a2",
      "optimistic:n1:a3",
      "optimistic:n1:a4",
      "optimistic:n1:a5",
    ]);
    assert.equal(collected.attachments[0].file_path, "/tmp/a.png");
    assert.equal(collected.attachments[0].file_name, "a.png");
    assert.equal(collected.attachments[0].byteSize, 12);
    assert.equal(collected.attachments[0].batchId, "optimistic:n1:batch");
    assert.equal(collected.attachments.some((item) => item.file_name === "from-comment.png"), true);
    const overCap = loaded.collectUserAttachmentsForSend({
      prompt: "",
      attachmentPaths: ["/tmp/1.png", "/tmp/2.png", "/tmp/3.png", "/tmp/4.png", "/tmp/5.png", "/tmp/6.png", "/tmp/7.png"],
      clientNonce: "n2",
    });
    assert.equal(overCap.attachments.length, 6);
    const persisted = collected.attachments.map((item, index) => loaded.persistableUserAttachmentEntry(item, `fallback-${index}`));
    assert.equal(persisted.every((item) => item.kind === "user-attachment"), true);
    assert.equal(persisted.every((item) => typeof item.file_path === "string" && item.file_path.length > 0), true);
  } finally {
    await cleanup();
  }
});

test("gallery shows 3 tiles and leftover +N on the last cell", async () => {
  const { loaded, cleanup } = await load(COMMENT);
  try {
    assert.equal(loaded.USER_ATTACHMENT_VISIBLE_TILES, 3);
    assert.equal(loaded.USER_ATTACHMENT_FILE_CAP, 6);
    const four = loaded.visibleUserAttachmentTiles(["a", "b", "c", "d"]);
    assert.deepEqual(four.visible, ["a", "b", "c"]);
    assert.equal(four.leftover, 1);
    const three = loaded.visibleUserAttachmentTiles(["a", "b", "c"]);
    assert.deepEqual(three.visible, ["a", "b", "c"]);
    assert.equal(three.leftover, 0);
    assert.equal(loaded.classifyUserAttachmentKind({
      mimeType: "image/png",
      fileName: "notes.pdf",
      urlOrPath: "notes.pdf",
    }), "image");
    assert.equal(loaded.classifyUserAttachmentKind({
      fileName: "notes.pdf",
      urlOrPath: "/tmp/notes.pdf",
    }), "file");
  } finally {
    await cleanup();
  }
});

test("same-batch user-attachment rows collapse into one gallery above the text", async () => {
  const { loaded, cleanup } = await load(COMMENT);
  try {
    const batchId = "optimistic:n1:batch";
    const grouped = loaded.groupUserAttachmentMessages([
      { kind: "message", role: "user", id: "a0", text: "", attachments: [{ path: "1.png" }], batchId },
      { kind: "message", role: "user", id: "a1", text: "", attachments: [{ path: "2.png" }], batchId },
      { kind: "message", role: "user", id: "a2", text: "", attachments: [{ path: "3.png" }], batchId },
      { kind: "message", role: "user", id: "a3", text: "", attachments: [{ path: "4.png" }], batchId },
      { kind: "message", role: "user", id: "u", text: "caption", attachments: [], batchId },
    ]);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].text, "caption");
    assert.equal(grouped[0].attachments.length, 4);
    assert.equal(grouped[0].id, "u");
    const leftover = loaded.visibleUserAttachmentTiles(grouped[0].attachments);
    assert.equal(leftover.visible.length, 3);
    assert.equal(leftover.leftover, 1);
  } finally {
    await cleanup();
  }
});

test("sidebar last-entry preview never leaks the comment or data payload", async () => {
  const { loaded, cleanup } = await load(MODEL);
  try {
    const comment = leak({
      kind: "user-attachment",
      id: "optimistic:n1:a0",
      file_path: "data:image/png;base64,iVBORw0KGgo=",
      file_name: "Screenshot 1.png",
    });
    const last = loaded.parseRendererAgentLastEntry({ kind: "text", text: comment });
    assert.equal(last.kind, "attachment");
    assert.equal(last.count, 1);
    const agent = loaded.projectRendererAgent({
      id: "agent-1",
      name: "Chat",
      lastEntry: { kind: "text", text: `hello ${comment}` },
      lastMessagePreview: comment,
    });
    assert.ok(agent);
    assert.equal(agent.lastMessage.includes("cursor-user-attachment"), false);
    assert.equal(agent.lastMessage.includes("data:image"), false);
    assert.equal(agent.lastMessage, "hello");
  } finally {
    await cleanup();
  }
});

test("transcript projection strips comments and groups persisted user-attachment rows", async () => {
  const { loaded, cleanup } = await load(MODEL);
  try {
    const comment = leak({
      kind: "user-attachment",
      id: "optimistic:n1:a0",
      file_path: "data:image/png;base64,iVBORw0KGgo=",
      file_name: "Screenshot 1.png",
    });
    const fromComment = loaded.projectTranscriptEntry({
      kind: "message",
      id: "t1u",
      role: "user",
      content: `see this ${comment}`,
    }, 0, "Bot");
    assert.equal(fromComment.text, "see this");
    assert.equal(fromComment.attachments.length, 1);
    assert.equal(fromComment.attachments[0].name, "Screenshot 1.png");
    assert.equal(fromComment.text.includes("cursor-user-attachment"), false);

    const feed = loaded.projectTranscriptFeedEntries([
      {
        kind: "user-attachment",
        id: "optimistic:n1:a0",
        file_path: "/tmp/a.png",
        file_name: "a.png",
        timestampMs: 1,
        batchId: "optimistic:n1:batch",
        clientNonce: "n1",
      },
      {
        kind: "user-attachment",
        id: "optimistic:n1:a1",
        file_path: "/tmp/b.png",
        file_name: "b.png",
        timestampMs: 2,
        batchId: "optimistic:n1:batch",
        clientNonce: "n1",
      },
      {
        kind: "user-attachment",
        id: "optimistic:n1:a2",
        file_path: "/tmp/c.png",
        file_name: "c.png",
        timestampMs: 3,
        batchId: "optimistic:n1:batch",
        clientNonce: "n1",
      },
      {
        kind: "user-attachment",
        id: "optimistic:n1:a3",
        file_path: "/tmp/d.pdf",
        file_name: "d.pdf",
        timestampMs: 4,
        batchId: "optimistic:n1:batch",
        clientNonce: "n1",
      },
      {
        kind: "message",
        id: "t1u",
        role: "user",
        content: "caption",
        timestampMs: 5,
        batchId: "optimistic:n1:batch",
        clientNonce: "n1",
      },
    ], "Bot", "agent-1");
    assert.equal(feed.length, 1);
    assert.equal(feed[0].text, "caption");
    assert.equal(feed[0].attachments.length, 4);
    assert.equal(feed[0].batchId, "optimistic:n1:batch");
  } finally {
    await cleanup();
  }
});
