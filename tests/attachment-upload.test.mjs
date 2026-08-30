import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-attachment-upload-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
  });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

test("boxPathFromUploadResult keeps Cursor box persist keys", async () => {
  const { loaded, cleanup } = await load("source/electron-main/attachments/attachments.ts");
  try {
    const { boxPathFromUploadResult, asAttachmentBytes } = loaded;
    assert.equal(
      boxPathFromUploadResult({ path: "/home/box/sand-data/agents/a/attachments/shot.png" }),
      "/home/box/sand-data/agents/a/attachments/shot.png",
    );
    assert.equal(
      boxPathFromUploadResult("/home/box/sand-data/agents/a/attachments/shot.png"),
      "/home/box/sand-data/agents/a/attachments/shot.png",
    );
    assert.equal(
      boxPathFromUploadResult({ result: { path: "file:///home/box/sand-data/shot.png" } }),
      "/home/box/sand-data/shot.png",
    );
    assert.equal(boxPathFromUploadResult({ path: "data:image/png;base64,QQ==" }), null);
    assert.equal(asAttachmentBytes(Buffer.from("abc"))?.toString(), "abc");
    assert.equal(asAttachmentBytes(new Uint8Array([1, 2, 3]))?.[1], 2);
    assert.equal(Buffer.from(asAttachmentBytes({ type: "Buffer", data: [65, 66] }) ?? []).toString(), "AB");
    assert.equal(Buffer.from(asAttachmentBytes({ 0: 65, 1: 66, length: 2 }) ?? []).toString(), "AB");
    assert.equal(Buffer.from(asAttachmentBytes("QUI=") ?? []).toString(), "AB");
  } finally {
    await cleanup();
  }
});

test("safeAttachmentFilename takes the leaf of a macOS screenshot TemporaryItems path", async () => {
  const { loaded, cleanup } = await load("source/electron-main/attachments/attachments.ts");
  try {
    const { safeAttachmentFilename, isSafeFilename } = loaded;
    const dropped = "/private/var/folders/6x/ssd0ns1s3kj76cs0pswjdk4m0000gn/T/TemporaryItems/NSIRD_screencaptureui_uiy57X/Screenshot 2026-08-27 at 11.13.00 PM.png";
    assert.equal(isSafeFilename(dropped), false);
    assert.equal(safeAttachmentFilename(dropped), "Screenshot 2026-08-27 at 11.13.00 PM.png");
    assert.equal(
      safeAttachmentFilename("file:///private/var/folders/x/T/Screenshot%20from%20Finder.png"),
      "Screenshot from Finder.png",
    );
    assert.equal(safeAttachmentFilename("notes.pdf"), "notes.pdf");
    assert.equal(safeAttachmentFilename(""), null);
    const { isReadableDropPath } = loaded;
    assert.equal(isReadableDropPath("/private/var/folders/6x/ssd0ns1s3kj76cs0pswjdk4m0000gn/T/TemporaryItems/NSIRD_screencaptureui_uiy57X/Screenshot.png"), true);
    assert.equal(isReadableDropPath("/Volumes/goldcoders/OSS/graph blueprint.jpeg"), true);
    assert.equal(isReadableDropPath("/etc/passwd"), false);
  } finally {
    await cleanup();
  }
});

test("official 0.18 stageAttachmentBytes(filename, bytes) still encodes a payload", async () => {
  const { loaded, cleanup } = await load("source/shared/media/bytes-base64.ts");
  try {
    const { stageAttachmentIpcRequest } = loaded;
    const fromOfficial = stageAttachmentIpcRequest("graph blueprint.jpeg", Uint8Array.from([1, 2, 3]));
    assert.equal(fromOfficial.filename, "graph blueprint.jpeg");
    assert.equal(typeof fromOfficial.bytesBase64, "string");
    assert.equal(fromOfficial.bytesBase64.length > 0, true);
    const fromRecovered = stageAttachmentIpcRequest({ filename: "shot.png", bytesBase64: "AQID", sourcePath: "/Users/x/shot.png" });
    assert.equal(fromRecovered.filename, "shot.png");
    assert.equal(fromRecovered.bytesBase64, "AQID");
    assert.equal(fromRecovered.sourcePath, "/Users/x/shot.png");
  } finally {
    await cleanup();
  }
});

test("stageBytes succeeds without injected now/randomUUID deps (crypto.randomUUID must stay bound)", async () => {
  const { loaded, cleanup } = await load("source/electron-main/attachments/attachments.ts");
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "grok-staging-default-"));
  // Electron's webcrypto brand-checks `this` (ERR_INVALID_THIS on a detached
  // randomUUID); plain Node does not, so emulate the strict receiver here.
  const originalCrypto = globalThis.crypto;
  const strictCrypto = {
    randomUUID() {
      if (this !== strictCrypto) throw new TypeError('Value of "this" must be of type Crypto');
      return originalCrypto.randomUUID();
    },
  };
  Object.defineProperty(globalThis, "crypto", { value: strictCrypto, configurable: true });
  try {
    const { createAttachmentEdgePort } = loaded;
    const failures = [];
    const port = createAttachmentEdgePort({
      legs: {},
      getMainWindow: () => null,
      onEdgeFailure: (failure) => failures.push(failure),
      byteLimitForName: () => 1024,
      getStagingDir: () => stagingDir,
      isWithinStagingDir: (candidate) => candidate.startsWith(stagingDir),
    });
    const staged = await port.stageBytes({ filename: "probe.txt", bytesBase64: "QUJDRA==" });
    assert.deepEqual(failures, []);
    assert.equal(staged.ok, true);
    assert.equal(staged.path.startsWith(stagingDir), true);
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: originalCrypto, configurable: true });
    await rm(stagingDir, { recursive: true, force: true });
    await cleanup();
  }
});

test("0.18 RPC unpack of e.filename/e.bytes drops bytesBase64-only composer requests", async () => {
  const { loaded, cleanup } = await load("source/shared/media/bytes-base64.ts");
  try {
    const { stageAttachmentIpcRequest } = loaded;
    const composer = { filename: "graph blueprint.jpeg", bytesBase64: "AQID" };
    const dropped = stageAttachmentIpcRequest(composer.filename, composer.bytes);
    assert.equal(dropped.filename, "graph blueprint.jpeg");
    assert.equal(dropped.bytesBase64, undefined);
    const forwarded = stageAttachmentIpcRequest(composer);
    assert.equal(forwarded.bytesBase64, "AQID");
    const official = { filename: "graph blueprint.jpeg", bytes: Uint8Array.from([1, 2, 3]) };
    const viaBytes = stageAttachmentIpcRequest(official.filename, official.bytes);
    assert.equal(typeof viaBytes.bytesBase64, "string");
    assert.equal(viaBytes.bytesBase64.length > 0, true);
  } finally {
    await cleanup();
  }
});

test("staging downscales oversized images and keeps small or shrink-resistant ones", async () => {
  const { loaded, cleanup } = await load("source/electron-main/attachments/attachments.ts");
  try {
    const { downscaleStagedImage, STAGE_IMAGE_MIN_BYTES } = loaded;
    const big = new Uint8Array(STAGE_IMAGE_MIN_BYTES + 1);
    const fakeImage = (width, height, jpegBytes) => ({
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      resize: (options) => ({
        isEmpty: () => false,
        toJPEG: () => Buffer.alloc(jpegBytes),
        toPNG: () => Buffer.alloc(jpegBytes),
        __options: options,
      }),
    });
    const nativeImage = { createFromDataURL: () => ({ isEmpty: () => true }), createFromBuffer: () => fakeImage(4000, 2200, 1024) };
    const shrunk = downscaleStagedImage("shot.jpeg", big, nativeImage);
    assert.equal(shrunk.bytes.byteLength, 1024);
    assert.equal(shrunk.extensionOverride, ".jpg");
    const png = downscaleStagedImage("shot.png", big, nativeImage);
    assert.equal(png.bytes.byteLength, 1024);
    assert.equal(png.extensionOverride, undefined);
    const small = downscaleStagedImage("shot.png", new Uint8Array(1000), nativeImage);
    assert.equal(small.bytes.byteLength, 1000);
    const smallDims = { ...nativeImage, createFromBuffer: () => fakeImage(1800, 900, 10) };
    assert.equal(downscaleStagedImage("shot.png", big, smallDims).bytes, big);
    const growsBack = { ...nativeImage, createFromBuffer: () => fakeImage(4000, 2200, STAGE_IMAGE_MIN_BYTES * 2) };
    assert.equal(downscaleStagedImage("shot.jpeg", big, growsBack).bytes, big);
    assert.equal(downscaleStagedImage("anim.gif", big, nativeImage).bytes, big);
    assert.equal(downscaleStagedImage("notes.pdf", big, nativeImage).bytes, big);
  } finally {
    await cleanup();
  }
});
