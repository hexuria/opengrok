import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-image-dimensions-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/media/image-dimensions.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
  });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

/** Minimal JPEG: SOI, optional APP1/EXIF with the given orientation, SOF0 with raw 4032x3024. */
function jpegBytes(orientation) {
  const bytes = [0xff, 0xd8];
  if (orientation != null) {
    bytes.push(
      0xff, 0xe1, 0x00, 0x22,
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF little-endian, IFD at 8
      0x01, 0x00, // one entry
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, // tag 0x0112
      0x00, 0x00, 0x00, 0x00, // no next IFD
    );
  }
  bytes.push(
    0xff, 0xc0, 0x00, 0x11, 0x08,
    0x0b, 0xd0, // height 3024
    0x0f, 0xc0, // width 4032
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  );
  return Uint8Array.from(bytes);
}

test("EXIF-transposed JPEGs report browser-rendered (swapped) dimensions", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { readImageFileDimensions, readJpegDimensions } = loaded;
    assert.deepEqual(readJpegDimensions(jpegBytes(6)), { width: 3024, height: 4032 });
    assert.deepEqual(readJpegDimensions(jpegBytes(8)), { width: 3024, height: 4032 });
    assert.deepEqual(readJpegDimensions(jpegBytes(1)), { width: 4032, height: 3024 });
    assert.deepEqual(readJpegDimensions(jpegBytes(3)), { width: 4032, height: 3024 });
    assert.deepEqual(readJpegDimensions(jpegBytes(null)), { width: 4032, height: 3024 });
    assert.deepEqual(readImageFileDimensions(jpegBytes(6)), { width: 3024, height: 4032 });
  } finally {
    await cleanup();
  }
});
