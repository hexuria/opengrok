import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-media-protocol-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/media/media-protocol.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
  });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

test("?w= resize width parses only sane tile widths", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { parseSandMediaResizeWidth } = loaded;
    assert.equal(parseSandMediaResizeWidth("sand-media://attachment/a.png?w=440"), 440);
    assert.equal(parseSandMediaResizeWidth("sand-media://attachment/a.png?w=1120"), 1120);
    assert.equal(parseSandMediaResizeWidth("sand-media://attachment/a.png"), null);
    assert.equal(parseSandMediaResizeWidth("sand-media://attachment/a.png?w=8"), null);
    assert.equal(parseSandMediaResizeWidth("sand-media://attachment/a.png?w=4096"), null);
    assert.equal(parseSandMediaResizeWidth("sand-media://attachment/a.png?w=abc"), null);
    assert.equal(parseSandMediaResizeWidth("not a url"), null);
  } finally {
    await cleanup();
  }
});

test("resized tiles keep PNG only when transparency is actually present", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { chooseVariantMime } = loaded;
    assert.equal(chooseVariantMime("image/jpeg", false), "image/jpeg");
    assert.equal(chooseVariantMime("image/jpeg", true), "image/jpeg");
    assert.equal(chooseVariantMime("image/png", true), "image/png");
    assert.equal(chooseVariantMime("image/png", false), "image/jpeg");
    assert.equal(chooseVariantMime("image/webp", true), "image/png");
    assert.equal(chooseVariantMime("image/webp", false), "image/jpeg");
  } finally {
    await cleanup();
  }
});

test("range header parsing clamps and rejects malformed ranges", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { parseRangeHeader } = loaded;
    assert.deepEqual(parseRangeHeader("bytes=0-99", 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRangeHeader("bytes=900-", 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRangeHeader("bytes=-100", 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRangeHeader("bytes=0-9999", 1000), { start: 0, end: 999 });
    assert.equal(parseRangeHeader("bytes=1000-", 1000), null);
    assert.equal(parseRangeHeader("bytes=5-2", 1000), null);
    assert.equal(parseRangeHeader(null, 1000), null);
  } finally {
    await cleanup();
  }
});
