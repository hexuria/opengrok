import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(sourcePath) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-collections-store-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, sourcePath)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function memoryKv() {
  const values = new Map();
  return {
    values,
    read: async (key) => values.get(key) ?? null,
    write: async (key, value) => { values.set(key, value); },
    remove: async (key) => { values.delete(key); },
  };
}

function sequentialIds() {
  let next = 0;
  return () => {
    next += 1;
    return `col${String(next).padStart(16, "0")}`;
  };
}

function userMessage(id, content) {
  return { kind: "message", id, role: "user", content, isStreaming: false, timestampMs: 1_700_000_000_000 };
}

function agentMessage(id, content) {
  return { kind: "send-message", id, message: { type: "text", content }, timestampMs: 1_700_000_001_000 };
}

function share(entryId, entry, agentId = "agent-1") {
  return { agentId, agentName: "Ada", entryId, entry };
}

const stamp = () => "Nov 14, 2023 at 10:00";

test("collections CRUD mints ids, lists bookmarks first, and renames", async () => {
  const loaded = await loadModule("source/electron-main/collections/collections-store.ts");
  try {
    const kv = memoryKv();
    const store = new loaded.module.SandCollectionsStore(kv, { now: () => 1_000, mintId: sequentialIds() });

    const empty = await store.listCollections();
    assert.deepEqual(empty.map((entry) => entry.id), ["bookmarks"]);
    assert.equal(empty[0].count, 0);
    assert.equal(kv.values.size, 0, "listing must not write");

    const created = await store.addMessages({ messages: [share("t0u", userMessage("t0u", "hello"))] });
    assert.match(created.collectionId, /^col[0-9a-z]{16}$/);
    assert.equal(created.added, 1);
    assert.match(created.name, /^Collection \d{4}-\d{2}-\d{2}$/);

    const bookmarked = await store.addMessages({ collectionId: "bookmarks", messages: [share("t0s0", agentMessage("t0s0", "hi"))] });
    assert.equal(bookmarked.collectionId, "bookmarks");
    assert.equal(bookmarked.name, "Bookmarks");

    const listed = await store.listCollections();
    assert.deepEqual(listed.map((entry) => entry.id), ["bookmarks", created.collectionId]);
    assert.deepEqual(listed.map((entry) => entry.count), [1, 1]);

    const renamed = await store.renameCollection(created.collectionId, "  Release   notes  ");
    assert.equal(renamed.name, "Release notes");
    assert.equal((await store.getCollection(created.collectionId)).name, "Release notes");

    const document = await store.getCollection(created.collectionId);
    assert.equal(document.messages[0].key, "agent-1/t0u");
    assert.equal(document.messages[0].agentName, "Ada");
    assert.deepEqual(document.messages[0].entry, userMessage("t0u", "hello"));

    await store.removeMessages(created.collectionId, ["agent-1/t0u"]);
    assert.equal((await store.getCollection(created.collectionId)).messages.length, 0);

    await store.deleteCollection(created.collectionId);
    assert.equal(await store.getCollection(created.collectionId), null);
    assert.deepEqual((await store.listCollections()).map((entry) => entry.id), ["bookmarks"]);
  } finally {
    await loaded.dispose();
  }
});

test("collections dedupe by key and stop at the 500-message cap", async () => {
  const loaded = await loadModule("source/electron-main/collections/collections-store.ts");
  try {
    const store = new loaded.module.SandCollectionsStore(memoryKv(), { now: () => 1_000, mintId: sequentialIds() });
    const first = await store.addMessages({ messages: [share("t0u", userMessage("t0u", "one")), share("t0u", userMessage("t0u", "one"))] });
    assert.equal(first.added, 1);
    assert.equal(first.duplicates, 1);

    const again = await store.addMessages({ collectionId: first.collectionId, messages: [share("t0u", userMessage("t0u", "one"))] });
    assert.equal(again.added, 0);
    assert.equal(again.duplicates, 1);

    const bulk = [];
    for (let index = 1; index <= loaded.module.COLLECTION_MESSAGE_CAP; index += 1) bulk.push(share(`t${index}u`, userMessage(`t${index}u`, "x")));
    const capped = await store.addMessages({ collectionId: first.collectionId, messages: bulk });
    assert.equal(capped.added, loaded.module.COLLECTION_MESSAGE_CAP - 1);
    assert.equal(capped.dropped, 1);
    assert.equal((await store.getCollection(first.collectionId)).messages.length, loaded.module.COLLECTION_MESSAGE_CAP);
  } finally {
    await loaded.dispose();
  }
});

test("bookmarks is reserved: it cannot be renamed or deleted", async () => {
  const loaded = await loadModule("source/electron-main/collections/collections-store.ts");
  try {
    const store = new loaded.module.SandCollectionsStore(memoryKv(), { now: () => 1_000, mintId: sequentialIds() });
    await store.addMessages({ collectionId: "bookmarks", messages: [share("t0u", userMessage("t0u", "keep"))] });
    await assert.rejects(() => store.renameCollection("bookmarks", "Faves"), /cannot be renamed/);
    await assert.rejects(() => store.deleteCollection("bookmarks"), /cannot be deleted/);
    assert.equal((await store.getCollection("bookmarks")).name, "Bookmarks");
    assert.equal((await store.getCollection("bookmarks")).messages.length, 1);
  } finally {
    await loaded.dispose();
  }
});

test("collection JSON round-trips and a colliding id is re-minted and suffixed", async () => {
  const loaded = await loadModule("source/electron-main/collections/collections-store.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-collections-media-"));
  try {
    const kv = memoryKv();
    const store = new loaded.module.SandCollectionsStore(kv, { now: () => 2_000, mintId: sequentialIds() });
    const pixel = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const sourceImage = path.join(temporary, "shot.png");
    await writeFile(sourceImage, pixel);

    const created = await store.addMessages({
      name: "Trip",
      messages: [
        share("t0u", userMessage("t0u", "look at this")),
        share("t0ua0", { kind: "user-attachment", id: "t0ua0", file_path: sourceImage, timestampMs: 1_700_000_000_000 }),
      ],
    });
    const document = await store.getCollection(created.collectionId);
    assert.deepEqual(document.messages[1].media, [{ srcPath: sourceImage, mime: "image/png" }]);

    const readMedia = async (srcPath) => {
      const bytes = await readFile(srcPath).catch(() => null);
      return bytes == null ? null : { bytes: new Uint8Array(bytes), mime: "image/png" };
    };
    const exported = await loaded.module.buildCollectionJsonExport(document, readMedia, 3_000);
    assert.equal(exported.format, "opengrok-collection");
    assert.equal(exported.version, 1);
    assert.equal(exported.collection.id, created.collectionId);
    assert.equal(exported.messages.length, 2);
    assert.equal(exported.messages[1].media[0].bytesBase64, pixel.toString("base64"));

    const parsed = loaded.module.parseCollectionImport(JSON.stringify(exported));
    assert.equal(parsed.id, created.collectionId);
    assert.equal(parsed.name, "Trip");

    const importRoot = path.join(temporary, "imported");
    const writeImportedMedia = async (collectionId, relPath, bytes) => {
      const dir = path.join(importRoot, collectionId);
      await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
      const target = path.join(dir, relPath);
      await writeFile(target, bytes);
      return target;
    };
    const summary = await store.importDocument({
      name: parsed.name,
      createdAtMs: parsed.createdAtMs,
      preferredId: parsed.id,
      materialize: (collectionId) => loaded.module.materializeImportedMessages(parsed, collectionId, writeImportedMedia, 4_000),
    });
    assert.notEqual(summary.id, created.collectionId, "a colliding id must be re-minted");
    assert.equal(summary.name, "Trip (imported)");
    assert.equal(summary.count, 2);

    const round = await store.getCollection(summary.id);
    assert.deepEqual(round.messages[0].entry, userMessage("t0u", "look at this"));
    assert.equal(round.messages[1].media[0].srcPath, path.join(importRoot, summary.id, "100-shot.png"));
    assert.deepEqual(await readFile(round.messages[1].media[0].srcPath), pixel);

    await assert.rejects(() => Promise.resolve().then(() => loaded.module.parseCollectionImport(JSON.stringify({ format: "something-else" }))), /not a collection export/);
    await assert.rejects(() => Promise.resolve().then(() => loaded.module.parseCollectionImport(JSON.stringify({ ...exported, version: 2 }))), /unsupported version/);
    await assert.rejects(
      () => Promise.resolve().then(() => loaded.module.parseCollectionImport(JSON.stringify({ ...exported, collection: { ...exported.collection, id: "../escape" } }))),
      /invalid id/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("HTML export escapes message text and keeps oversized media as placeholders", async () => {
  const loaded = await loadModule("source/electron-main/collections/collections-store.ts");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-collections-html-"));
  try {
    const store = new loaded.module.SandCollectionsStore(memoryKv(), { now: () => 5_000, mintId: sequentialIds() });
    const small = path.join(temporary, "small.png");
    const large = path.join(temporary, "large.png");
    await writeFile(small, Buffer.from("89504e470d0a1a0a", "hex"));
    await writeFile(large, Buffer.alloc(4_096, 7));

    const created = await store.addMessages({
      name: "Escapes",
      messages: [
        share("t0u", userMessage("t0u", "<script>alert('x')</script> & \"quotes\"")),
        share("t0ua0", { kind: "user-attachment", id: "t0ua0", file_path: small, timestampMs: 1 }),
        share("t1ua0", { kind: "user-attachment", id: "t1ua0", file_path: large, timestampMs: 1 }),
        share("t9z", { kind: "widget-response", id: "t9z", timestampMs: 1 }),
      ],
    });
    const document = await store.getCollection(created.collectionId);

    const readMedia = async (srcPath, maxBytes) => {
      const bytes = await readFile(srcPath).catch(() => null);
      if (bytes == null) return null;
      if (maxBytes != null && bytes.byteLength > maxBytes) return null;
      return { bytes: new Uint8Array(bytes), mime: "image/png" };
    };
    const exported = await loaded.module.buildCollectionHtmlExport({
      document,
      readMedia,
      permalink: `opengrok://app/v1/collection?id=${created.collectionId}`,
      exportedAt: "Nov 14, 2023",
      formatTimestamp: stamp,
      fileMaxBytes: 1_024,
    });

    assert.equal(exported.embedded, 1);
    assert.equal(exported.skipped, 1);
    const html = exported.html;
    assert.ok(!html.includes("<script"), "an exported collection must contain no scripts at all");
    assert.ok(!html.includes("alert('x')"), "raw message text must never reach the document as markup");
    assert.ok(html.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;quotes&quot;"));
    assert.ok(html.includes("data:image/png;base64,"), "the small attachment is inlined");
    assert.ok(html.includes("<span class=\"sand-col-chip sand-col-chip-media\">large.png</span>"), "the oversized attachment degrades to a chip");
    assert.ok(html.includes("<span class=\"sand-col-chip\">widget-response</span>"), "an unknown kind degrades to a named chip");
    assert.ok(html.includes("Exported from OpenGrok"));
    assert.ok(html.includes(`opengrok://app/v1/collection?id=${created.collectionId}`));
    assert.ok(html.includes("4 messages"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("entry media collection covers attachments, inline images, and skips remote urls", async () => {
  const loaded = await loadModule("source/electron-main/collections/collections-store.ts");
  try {
    assert.deepEqual(
      loaded.module.collectEntryMedia({ kind: "user-attachment", file_path: "/home/box/sand-data/a.png" }),
      [{ srcPath: "/home/box/sand-data/a.png", mime: "image/png" }],
    );
    assert.deepEqual(
      loaded.module.collectEntryMedia({ kind: "send-message", message: { type: "text", content: "", images: [{ url: "file:///home/box/clip.mp4" }] } }),
      [{ srcPath: "/home/box/clip.mp4", mime: "video/mp4" }],
    );
    assert.deepEqual(
      loaded.module.collectEntryMedia({ kind: "message", attachments: ["https://example.com/a.png", "data:image/png;base64,AA"] }),
      [],
    );
  } finally {
    await loaded.dispose();
  }
});

test("promote copies snapshots into bookmarks without a transcript refetch", async () => {
  const loaded = await loadModule("source/electron-main/collections/collections-store.ts");
  try {
    const store = new loaded.module.SandCollectionsStore(memoryKv(), { now: () => 1_000, mintId: sequentialIds() });
    const created = await store.addMessages({
      messages: [share("t1u", userMessage("t1u", "keep me")), share("t2u", userMessage("t2u", "not me"))],
    });
    const doc = await store.getCollection(created.collectionId);
    const keepKey = doc.messages[0].key;

    const promoted = await store.promoteToBookmarks(created.collectionId, [keepKey]);
    assert.equal(promoted.collectionId, loaded.module.BOOKMARKS_COLLECTION_ID);
    assert.equal(promoted.added, 1);

    const bookmarks = await store.getCollection(loaded.module.BOOKMARKS_COLLECTION_ID);
    assert.equal(bookmarks.messages.length, 1);
    assert.equal(bookmarks.messages[0].entryId, "t1u");
    assert.deepEqual(bookmarks.messages[0].entry, doc.messages[0].entry);

    const again = await store.promoteToBookmarks(created.collectionId, [keepKey]);
    assert.equal(again.duplicates, 1);
    assert.equal(again.added, 0);

    await assert.rejects(() => store.promoteToBookmarks(created.collectionId, ["missing-key"]), /not in this collection/);
  } finally {
    await loaded.dispose();
  }
});
