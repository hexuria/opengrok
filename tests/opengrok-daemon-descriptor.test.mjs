import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadDescriptor() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opengrok-daemon-descriptor-"));
  const outfile = path.join(temporary, "descriptor.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/box/opengrok-daemon-descriptor.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const GATEWAY = { baseUrl: "https://grok.example.test", token: "gateway-bearer" };

test("the daemon descriptor carries the enrolment token to the server this machine enrolled with", async () => {
  const { loaded, cleanup } = await loadDescriptor();
  try {
    const result = loaded.withOpenGrokDaemonToken(GATEWAY, {
      gatewayUrl: "https://grok.example.test/",
      token: "daemon-token",
    });
    assert.equal(result.token, "daemon-token");
    assert.equal(result.baseUrl, GATEWAY.baseUrl, "the address is not the daemon's to change");
    assert.equal(GATEWAY.token, "gateway-bearer", "the caller's descriptor is left alone");
  } finally {
    await cleanup();
  }
});

test("a port, host or scheme the machine did not enrol with never sees the token", async () => {
  const { loaded, cleanup } = await loadDescriptor();
  try {
    for (const elsewhere of [
      "https://someone-elses-server.test",
      "https://grok.example.test:8443",
      "http://grok.example.test",
    ]) {
      const result = loaded.withOpenGrokDaemonToken(GATEWAY, { gatewayUrl: elsewhere, token: "daemon-token" });
      assert.equal(result.token, "gateway-bearer", `${elsewhere} must not be handed the daemon token`);
    }
  } finally {
    await cleanup();
  }
});

test("without an enrolment, or with an unreadable address, the descriptor is untouched", async () => {
  const { loaded, cleanup } = await loadDescriptor();
  try {
    for (const identity of [
      { gatewayUrl: "https://grok.example.test", token: null },
      { gatewayUrl: "https://grok.example.test", token: "" },
      { gatewayUrl: null, token: "daemon-token" },
      { gatewayUrl: "not a url", token: "daemon-token" },
      { gatewayUrl: undefined, token: undefined },
    ]) {
      assert.equal(loaded.withOpenGrokDaemonToken(GATEWAY, identity).token, "gateway-bearer");
    }
    // A box gateway has no readable origin match either, and keeps its bearer.
    const box = { baseUrl: "http://127.0.0.1:39187", token: "box-bearer" };
    assert.equal(
      loaded.withOpenGrokDaemonToken(box, { gatewayUrl: "https://grok.example.test", token: "daemon-token" }).token,
      "box-bearer",
    );
  } finally {
    await cleanup();
  }
});

test("headers the gateway set survive the swap", async () => {
  const { loaded, cleanup } = await loadDescriptor();
  try {
    const withHeaders = { baseUrl: "https://grok.example.test", token: "gateway-bearer", headers: { "x-sand-network-token": "n" } };
    const result = loaded.withOpenGrokDaemonToken(withHeaders, {
      gatewayUrl: "https://grok.example.test",
      token: "daemon-token",
    });
    assert.deepEqual(result.headers, { "x-sand-network-token": "n" });
    assert.equal(result.token, "daemon-token");
  } finally {
    await cleanup();
  }
});
