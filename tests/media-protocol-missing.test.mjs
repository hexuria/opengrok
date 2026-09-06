import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadMediaProtocol() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-media-protocol-"));
  const outfile = path.join(temporary, "media-protocol.mjs");
  await build({ entryPoints: [path.join(repoRoot, "source/electron-main/media/media-protocol.ts")], outfile, bundle: true, format: "esm", platform: "node", external: ["electron"] });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// The renderer's media fallback separates "file unavailable" from "bad bytes"
// by one ranged fetch: 404 means no bytes for this path. A remote leg that
// throws (the gateway has no such file, or is down) therefore has to come back
// as 404 too — a rejected protocol handler reaches the renderer as a network
// failure, which it cannot tell from a decode failure.
test("a missing path whose remote leg throws answers 404, not a rejected handler", async () => {
  const { loaded, cleanup } = await loadMediaProtocol();
  try {
    loaded.setSandMediaRemoteReader({ readChunk: async () => { throw new Error("gateway: no such attachment"); } });
    const url = loaded.buildSandMediaUrl("/tmp/opengrok-mock-fixtures/does-not-exist/mock-missing.jpg");
    const response = await loaded.handleSandMediaRequest(new Request(url, { headers: { Range: "bytes=0-0" } }));
    assert.equal(response.status, 404);
    loaded.setSandMediaRemoteReader({ readChunk: async () => null });
    const absent = await loaded.handleSandMediaRequest(new Request(url));
    assert.equal(absent.status, 404, "a remote leg that reports no file is 404 as well");
    loaded.setSandMediaRemoteReader(null);
    const noRemote = await loaded.handleSandMediaRequest(new Request(url));
    assert.equal(noRemote.status, 404, "no local file and no remote leg is 404");
  } finally { loaded.setSandMediaRemoteReader(null); await cleanup(); }
});
