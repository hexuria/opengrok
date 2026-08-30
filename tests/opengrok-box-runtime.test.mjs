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

async function loadSignIn() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opengrok-signin-"));
  const outfile = path.join(temporary, "signin.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/box/opengrok-signin.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["electron"],
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// The parser names the fields it keeps, so a field it does not name is dropped
// in silence. That is how "configured" went missing: the server sent it, the
// panel never saw it, and a box the organisation had never set up rendered as
// ready to use. Pin the whole row against the payload the server actually sends.
test("a computer the organisation has not configured stays marked unconfigured", async () => {
  const { loaded, cleanup } = await loadSignIn();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    computers: [
      { id: "local-docker", label: "Local VM (on the server)", kind: "local-docker", state: "available", configured: true },
      { id: "ascii", label: "box.ascii.dev", kind: "ascii", state: "not-configured", configured: false },
      { id: "windows365", label: "Windows 365", kind: "windows365", state: "not-configured", configured: false },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const rows = await loaded.listOpenGrokComputers("http://server.test:1447", "token");
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.configured), [true, false, false]);
    assert.deepEqual(rows.map((row) => row.label), ["Local VM (on the server)", "box.ascii.dev", "Windows 365"]);
    assert.deepEqual(rows.map((row) => row.kind), ["local-docker", "ascii", "windows365"]);
  } finally {
    globalThis.fetch = realFetch;
    await cleanup();
  }
});

// A server that says nothing about configuration is not asserting the computer
// is unusable, so absence must stay absent rather than becoming false.
test("a server that omits configured leaves it unset rather than guessing", async () => {
  const { loaded, cleanup } = await loadSignIn();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    computers: [{ id: "only", label: "Only", kind: "local-docker", state: "available" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const rows = await loaded.listOpenGrokComputers("http://server.test:1447", "token");
    assert.equal(rows.length, 1);
    assert.ok(!("configured" in rows[0]));
  } finally {
    globalThis.fetch = realFetch;
    await cleanup();
  }
});

// The coordinator asks which backend owns the session on every renderer request,
// and the answer used to cost a read, a parse and a migration pass each time.
// It is cached now, which is only safe if a change to the file still lands: a
// stale answer here routes the roster to the wrong backend and the app looks
// connected while showing someone else's bots.
test("the cached box runtime still follows a change to settings.json", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opengrok-runtime-cache-"));
  try {
    const bundle = async (entry, name) => {
      const outfile = path.join(temporary, name);
      await build({
        entryPoints: [path.join(repoRoot, entry)],
        outfile, bundle: true, format: "esm", platform: "node",
        external: ["electron"], logLevel: "silent",
      });
      return await import(pathToFileURL(outfile).href);
    };
    const { readBoxRuntime } = await bundle("source/node-agent-coordinator/main.ts", "coordinator.mjs");
    // Written through the store rather than by hand, so the test cannot drift
    // from the on-disk schema the way a literal would.
    const { SandSettingsStore } = await bundle("source/shared/node/settings/sand-settings-store.ts", "store.mjs");

    const dataDir = path.join(temporary, "data");
    const store = new SandSettingsStore(path.join(dataDir, "settings.json"));

    store.setBoxRuntime("opengrok");
    assert.equal(readBoxRuntime(dataDir), "opengrok");
    assert.equal(readBoxRuntime(dataDir), "opengrok", "an unchanged file must keep answering the same way");

    store.setBoxRuntime("local-docker");
    assert.equal(readBoxRuntime(dataDir), "local-docker", "a rewritten file must invalidate the cached answer");

    store.setBoxRuntime("opengrok");
    assert.equal(readBoxRuntime(dataDir), "opengrok", "and again, in the other direction");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
