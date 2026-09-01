import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("default computer is the account's remote Grok VM, not Docker", async () => {
  const runtime = await readFile(path.join(repoRoot, "source/shared/box-runtime.ts"), "utf8");
  assert.match(runtime, /DEFAULT_SAND_BOX_RUNTIME: SandBoxRuntime = "remote"/);
  assert.match(runtime, /label: "Grok VM"/);
  assert.match(runtime, /Hosted Grok VM for this Cursor account/);

  const dock = await readFile(path.join(repoRoot, "frontend/src/recovered/features/computer/shell/runtime-dock.tsx"), "utf8");
  assert.match(dock, /value: "remote", label: "Grok VM"/);
  assert.doesNotMatch(dock, /mode === "remote"\)/);
  assert.match(dock, /const selected = mode === runtime.value;/);

  const settings = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/computer-runtime.tsx"), "utf8");
  assert.match(settings, /value: "remote", label: "Grok VM"/);
  assert.doesNotMatch(settings, /Cursor computer/);

  const patch = await readFile(path.join(repoRoot, "scripts/lib/router-renderer-patch.mjs"), "utf8");
  assert.doesNotMatch(patch, /id:"computer",label:"Computer"/);
  assert.match(patch, /title:"Computer",children:a.jsx\(RBoxRuntime/);
  assert.match(patch, /value:"remote",label:"Grok VM"/);
  assert.match(patch, /n\.value!=="remote"/);
  assert.match(patch, /setBoxRuntime\(n\)/);
  assert.doesNotMatch(patch, /Use local Docker VM/);

  const connector = await readFile(path.join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts"), "utf8");
  // local-docker still reaches localConnect for cursor; subscription
  // providers branch to the desktop host first.
  assert.match(connector, /return await localConnect\(\);/);
  assert.match(connector, /return await desktopConnect\(\);/);
  assert.doesNotMatch(connector, /await stopLocalDockerBox\(\)\.catch/);
  assert.match(connector, /Leave grok-bot-local-vm running/);
  assert.match(connector, /formatAccountComputerError/);
  assert.match(connector, /noteAccountComputerStatus/);
});

test("account computer errors name Cursor gates instead of a generic disconnect", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/box/account-computer-status.ts"), "utf8");
  assert.match(source, /export function formatAccountComputerError/);
  assert.match(source, /same Cursor account official Grok Bot uses/);
  assert.match(source, /Privacy mode blocks the shared computer/);
  assert.match(source, /too old for the account computer/);
  assert.match(source, /did not return a computer gateway/);
  const edge = await readFile(path.join(repoRoot, "source/electron-main/main-edge.ts"), "utf8");
  assert.match(edge, /account: getAccountComputerStatus\(\)/);
});

test("reconstructed profile persists secrets on disk without OS keychain", async () => {
  const secretStore = await readFile(path.join(repoRoot, "source/electron-main/secrets/secret-store.ts"), "utf8");
  assert.match(secretStore, /encodePlaintextSecret/);
  assert.match(secretStore, /shouldPersistSecretsOnDisk/);
  const policy = await readFile(path.join(repoRoot, "source/shared/cursor-session-policy.ts"), "utf8");
  assert.match(policy, /SAND_PERSIST_SECRETS_ON_DISK/);
  const bootstrap = await readFile(path.join(repoRoot, "source/electron-main/startup/desktop-user-data-bootstrap.ts"), "utf8");
  assert.match(bootstrap, /Grok-0\.27\.app/);
  assert.match(bootstrap, /isReconstructedDesktopApp/);
  assert.match(bootstrap, /SAND_PERSIST_SECRETS_ON_DISK/);
});

test("Cursor backend client version is at least official Grok Bot 0.24", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "client-version-"));
  try {
    const outfile = path.join(temporary, "metadata.mjs");
    await build({
      entryPoints: [path.join(repoRoot, "source/shared/node/sand-client-metadata.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    const mod = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
    assert.equal(mod.SAND_BACKEND_COMPAT_CLIENT_VERSION, "0.24.0");
    assert.equal(mod.getSandClientBaseVersion({ SAND_CLIENT_APP_VERSION: "0.18.0" }), "0.24.0");
    assert.equal(mod.getSandClientBaseVersion({ SAND_CLIENT_APP_VERSION: "0.18.0", SAND_BACKEND_CLIENT_VERSION: "0.25.1" }), "0.25.1");
    assert.equal(mod.getSandClientBaseVersion({ SAND_CLIENT_APP_VERSION: "0.30.0" }), "0.30.0");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("loopback gateway descriptors are not treated as the account computer", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "remote-box-"));
  try {
    const outfile = path.join(temporary, "box-runtime.mjs");
    await build({
      entryPoints: [path.join(repoRoot, "source/shared/box-runtime.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    const mod = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
    assert.equal(mod.DEFAULT_SAND_BOX_RUNTIME, "remote");
    assert.equal(mod.usesLocalAgentHost("remote"), false);
    assert.equal(mod.usesLocalAgentHost("local-docker"), true);
    assert.equal(mod.isLoopbackGatewayUrl("http://127.0.0.1:1340"), true);
    assert.equal(mod.isLoopbackGatewayUrl("http://localhost:6080/vnc.html"), true);
    assert.equal(mod.isLoopbackGatewayUrl("https://gateway.cursor.sh/sand"), false);
    assert.equal(mod.SAND_BOX_RUNTIME_OPTIONS[0].value, "remote");
    assert.equal(mod.SAND_BOX_RUNTIME_OPTIONS[0].label, "Grok VM");
    assert.equal(mod.grokComputerAllowedForProvider("cursor"), true);
    assert.equal(mod.grokComputerAllowedForProvider("claude-code"), false);
    assert.equal(mod.coerceBoxRuntimeForProvider("remote", "claude-code"), "local-docker");
    assert.equal(mod.coerceBoxRuntimeForProvider("remote", "cursor"), "remote");
    assert.equal(mod.coerceBoxRuntimeForProvider("windows365", "claude-code"), "windows365");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("cached loopback descriptors miss the remote fast path", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "gateway-cache-"));
  try {
    const outfile = path.join(temporary, "cache.mjs");
    await build({
      entryPoints: [path.join(repoRoot, "source/electron-main/box/gateway-descriptor-cache.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    const mod = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
    let innerCalls = 0;
    const store = {
      read: async () => ({ baseUrl: "http://127.0.0.1:1340", token: "local" }),
      write: async () => {},
      clear: async () => {},
    };
    const connect = mod.createGatewayConnectFastPath(
      {
        connect: async () => {
          innerCalls += 1;
          return { baseUrl: "https://box.cursor.sh", token: "remote" };
        },
      },
      { store, getAccountScope: () => "acct" },
    );
    const connection = await connect();
    assert.equal(connection.baseUrl, "https://box.cursor.sh");
    assert.equal(innerCalls, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
