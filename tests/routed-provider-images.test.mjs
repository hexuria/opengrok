import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  // The bundle keeps packages external, so it must live under the repo for node_modules resolution.
  const temporary = await mkdtemp(path.join(repoRoot, ".build", "routed-images-test-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
  });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const attachment = (id, filePath) => ({ provider: "openrouter", kind: "user-attachment", id, file_path: filePath, timestampMs: 1 });
const message = (id, role, content) => ({ provider: "openrouter", role, content, id, timestampMs: 1 });

const fakeImage = async (filePath) => filePath.endsWith(".png")
  ? { type: "image", image: Uint8Array.from([1]), mimeType: "image/png" }
  : null;

test("OpenRouter turns get image parts attached to the following user message", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { buildRoutedProviderMessages } = loaded;
    const messages = await buildRoutedProviderMessages([
      attachment("t0a0", "/tmp/shot.png"),
      attachment("t0a1", "/tmp/notes.zip"),
      message("t0u", "user", "tell me what do you see"),
      message("t0s0", "assistant", "a screenshot"),
    ], { includeImageParts: true, readImage: fakeImage });
    assert.equal(messages.length, 2);
    assert.equal(Array.isArray(messages[0].content), true);
    assert.deepEqual(messages[0].content.map((part) => part.type), ["image", "text"]);
    assert.equal(messages[0].content[1].text, "tell me what do you see");
    assert.equal(messages[1].content, "a screenshot");
  } finally {
    await cleanup();
  }
});

test("attachment-only sends become an images-only user message", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { buildRoutedProviderMessages } = loaded;
    const messages = await buildRoutedProviderMessages([
      attachment("t0a0", "/tmp/shot.png"),
      message("t0s0", "assistant", "nice image"),
    ], { includeImageParts: true, readImage: fakeImage });
    assert.deepEqual(messages[0].content.map((part) => part.type), ["image"]);
    assert.equal(messages[1].content, "nice image");
  } finally {
    await cleanup();
  }
});

test("non-OpenRouter providers keep the text-only history", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { buildRoutedProviderMessages } = loaded;
    const messages = await buildRoutedProviderMessages([
      attachment("t0a0", "/tmp/shot.png"),
      message("t0u", "user", "hello"),
    ], { includeImageParts: false, readImage: fakeImage });
    assert.deepEqual(messages, [{ role: "user", content: "hello" }]);
  } finally {
    await cleanup();
  }
});

test("box-path attachments fall back to gateway readAttachmentChunk", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { createRoutedImageReader } = loaded;
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const calls = [];
    const reader = createRoutedImageReader(async (method, args) => {
      calls.push({ method, args });
      assert.equal(method, "readAttachmentChunk");
      if (args.length === 0) return { bytesBase64: "", totalSize: bytes.length, mime: "image/jpeg" };
      return { bytesBase64: bytes.subarray(args.offset, args.offset + args.length).toString("base64"), totalSize: bytes.length };
    });
    const part = await reader("/home/box/sand-data/agents/a/attachments/blueprint.jpeg");
    assert.equal(part.type, "image");
    assert.equal(part.mimeType, "image/jpeg");
    assert.deepEqual([...part.image], [...bytes]);
    assert.equal(calls.length, 2);
    const missing = await reader("/home/box/sand-data/agents/a/attachments/notes.zip");
    assert.equal(missing, null);
  } finally {
    await cleanup();
  }
});

test("oldest image parts are trimmed past the cap and text survives", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { buildRoutedProviderMessages } = loaded;
    const messages = await buildRoutedProviderMessages([
      attachment("t0a0", "/tmp/old.png"),
      message("t0u", "user", "first"),
      message("t0s0", "assistant", "ok"),
      attachment("t1a0", "/tmp/new.png"),
      message("t1u", "user", "second"),
    ], { includeImageParts: true, readImage: fakeImage, maxImageParts: 1 });
    assert.equal(messages[0].content, "first");
    assert.deepEqual(messages[2].content.map((part) => part.type), ["image", "text"]);
  } finally {
    await cleanup();
  }
});
