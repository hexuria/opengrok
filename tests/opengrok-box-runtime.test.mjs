import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadBoxRuntime() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opengrok-box-runtime-"));
  const outfile = path.join(temporary, "box-runtime.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/box-runtime.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

test("the OpenGrok server is a real runtime, offered to every provider", async () => {
  const { loaded, cleanup } = await loadBoxRuntime();
  try {
    assert.equal(loaded.isSandBoxRuntime("opengrok"), true);
    assert.ok(loaded.SAND_BOX_RUNTIME_OPTIONS.some((o) => o.value === "opengrok"));
    // Choosing it is what makes the router provider moot, so no provider may gate
    // it and none may coerce it away - either would silently drop the user's server.
    for (const provider of ["cursor", "codex", "openrouter", "claude-code"]) {
      assert.equal(loaded.boxRuntimeAllowedForProvider("opengrok", provider), true, provider);
      assert.equal(loaded.coerceBoxRuntimeForProvider("opengrok", provider), "opengrok", provider);
    }
    assert.equal(loaded.boxRuntimeOwnsInference("opengrok"), true);
    assert.equal(loaded.boxRuntimeOwnsInference("local-docker"), false);
    // The existing runtimes must keep their behaviour.
    assert.equal(loaded.coerceBoxRuntimeForProvider("remote", "codex"), "local-docker");
    assert.equal(loaded.coerceBoxRuntimeForProvider("remote", "cursor"), "remote");
  } finally {
    await cleanup();
  }
});

test("the bearer has a secret-store key, not a settings field", async () => {
  const { loaded, cleanup } = await loadBoxRuntime();
  try {
    assert.equal(loaded.OPENGROK_GATEWAY_TOKEN_SECRET, "opengrok-gateway-token");
  } finally {
    await cleanup();
  }
});

test("the server URL survives a settings round-trip", async () => {
  // It did not, at first: parseSettings drops unknown keys on load, so the write
  // landed and the next read threw it away. hasToken said true while gatewayUrl
  // said null - the shape of that bug.
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opengrok-settings-"));
  try {
    const outfile = path.join(temporary, "settings-store.mjs");
    await build({
      entryPoints: [path.join(repoRoot, "source/shared/node/settings/sand-settings-store.ts")],
      outfile, bundle: true, format: "esm", platform: "node",
    });
    const { SandSettingsStore } = await import(pathToFileURL(outfile).href);
    const settingsPath = path.join(temporary, "settings.json");
    const store = new SandSettingsStore(settingsPath);
    store.setOpenGrokGatewayUrl("http://192.168.1.10:1447");
    assert.equal(new SandSettingsStore(settingsPath).getOpenGrokGatewayUrl(), "http://192.168.1.10:1447");
    store.setOpenGrokGatewayUrl(undefined);
    assert.equal(new SandSettingsStore(settingsPath).getOpenGrokGatewayUrl(), undefined);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the account backend follows the configured server, and falls back to env", async () => {
  // One account, not two. Whoever answers this URL is who the app's account
  // belongs to - that is what makes an OpenGrok server a drop-in rather than a
  // second identity sitting beside the Cursor one.
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opengrok-backend-"));
  try {
    const outfile = path.join(temporary, "cursor-token.mjs");
    await build({
      entryPoints: [path.join(repoRoot, "source/shared/node/cursor-token.ts")],
      outfile, bundle: true, format: "esm", platform: "node",
    });
    const { getConfiguredBackendUrl, setBackendUrlResolver } = await import(pathToFileURL(outfile).href);

    const env = { SAND_BACKEND_URL: "https://backend.example/" };
    assert.equal(getConfiguredBackendUrl(env), "https://backend.example/");

    setBackendUrlResolver(() => "http://192.168.1.10:1447");
    assert.equal(getConfiguredBackendUrl(env), "http://192.168.1.10:1447/");

    // No server configured: the env answer stands.
    setBackendUrlResolver(() => undefined);
    assert.equal(getConfiguredBackendUrl(env), "https://backend.example/");

    // A resolver that throws must not take the account down with it.
    setBackendUrlResolver(() => { throw new Error("settings unreadable"); });
    assert.equal(getConfiguredBackendUrl(env), "https://backend.example/");

    setBackendUrlResolver(null);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
