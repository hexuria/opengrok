import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-composer-attach-"));
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

test("composer chips use the screenshot basename, not the TemporaryItems path", async () => {
  const { loaded, cleanup } = await load("frontend/src/recovered/features/conversation/workspace/model.ts");
  try {
    const { composerAttachmentFileName, inferAttachmentKind } = loaded;
    const dropped = "/private/var/folders/6x/ssd0ns1s3kj76cs0pswjdk4m0000gn/T/TemporaryItems/NSIRD_screencaptureui_d9pl20/Screenshot 2026-08-27 at 11.14.52 PM.png";
    assert.equal(composerAttachmentFileName(dropped, "image/png"), "Screenshot 2026-08-27 at 11.14.52 PM.png");
    assert.equal(inferAttachmentKind({ mimeType: "image/png", fileName: composerAttachmentFileName(dropped) }), "image");
    assert.equal(composerAttachmentFileName("BIR_Archive_01.zip"), "BIR_Archive_01.zip");
    assert.equal(inferAttachmentKind({ fileName: "translate-this.pdf" }), "pdf");
  } finally {
    await cleanup();
  }
});

test("stageComposerFiles sends JSON-safe base64, not a typed array", async () => {
  const { loaded, cleanup } = await load("frontend/src/recovered/features/conversation/workspace/desktop.ts");
  try {
    const seen = [];
    const result = await loaded.stageComposerFiles(
      {
        stageAttachmentBytes: async (request) => {
          seen.push(request);
          return { ok: true, path: "/tmp/staged-notes.txt" };
        },
      },
      [{
        name: "/private/var/folders/x/T/TemporaryItems/NSIRD_screencaptureui_abc/notes.txt",
        size: 3,
        type: "text/plain",
        path: "/private/var/folders/x/T/TemporaryItems/NSIRD_screencaptureui_abc/notes.txt",
        arrayBuffer: async () => Uint8Array.from([97, 98, 99]).buffer,
      }],
    );
    assert.equal(result.failures.length, 0);
    assert.equal(result.attachments[0]?.name, "notes.txt");
    assert.equal(typeof seen[0]?.bytesBase64, "string");
    assert.equal(seen[0]?.filename, "notes.txt");
    assert.equal(seen[0]?.sourcePath, "/private/var/folders/x/T/TemporaryItems/NSIRD_screencaptureui_abc/notes.txt");
  } finally {
    await cleanup();
  }
});
