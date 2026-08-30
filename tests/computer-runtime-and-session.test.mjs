import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entry, name) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), name));
  const outfile = path.join(temporary, "mod.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return { temporary, mod: await import(pathToFileURL(outfile).href + "?" + Date.now()) };
}

test("Cursor + missing runtime defaults to remote Grok VM", async () => {
  const { temporary, mod } = await bundle("source/shared/box-runtime.ts", "runtime-default-");
  try {
    assert.equal(mod.DEFAULT_SAND_BOX_RUNTIME, "remote");
    assert.equal(mod.SAND_BOX_RUNTIME_OPTIONS[0].label, "Grok VM");
    assert.equal(mod.coerceBoxRuntimeForProvider(mod.DEFAULT_SAND_BOX_RUNTIME, "cursor"), "remote");
    assert.equal(mod.grokComputerAllowedForProvider("cursor"), true);
    const settings = await readFile(path.join(repoRoot, "source/shared/node/settings/sand-settings-store.ts"), "utf8");
    assert.match(settings, /getBoxRuntime\(\): SandBoxRuntime \{ return this\.load\(\)\.boxRuntime \?\? DEFAULT_SAND_BOX_RUNTIME; \}/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Claude cannot select remote Grok VM", async () => {
  const { temporary, mod } = await bundle("source/shared/box-runtime.ts", "runtime-claude-");
  try {
    assert.equal(mod.grokComputerAllowedForProvider("claude-code"), false);
    assert.equal(mod.grokComputerAllowedForProvider("codex"), false);
    assert.equal(mod.coerceBoxRuntimeForProvider("remote", "claude-code"), "local-docker");
    assert.equal(mod.coerceBoxRuntimeForProvider("remote", "codex"), "local-docker");
    assert.equal(mod.boxRuntimeAllowedForProvider("remote", "claude-code"), false);
    const dock = await readFile(path.join(repoRoot, "frontend/src/recovered/features/computer/shell/runtime-dock.tsx"), "utf8");
    assert.match(dock, /RUNTIMES\.filter\(\(runtime\) => runtime\.value !== "remote"\)/);
    const settings = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/computer-runtime.tsx"), "utf8");
    assert.match(settings, /COMPUTER_RUNTIME_OPTIONS\.filter\(\(option\) => option\.value !== "remote"\)/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("forceRecreate for local-docker or windows365 never calls remote recreateSandBox", async () => {
  const { temporary, mod } = await bundle("source/electron-main/box/computer-reset-route.ts", "reset-route-");
  try {
    assert.deepEqual(mod.routeComputerReset("remote"), { action: "hosted-grok-vm" });
    assert.deepEqual(mod.routeComputerReset("local-docker"), { action: "local-docker" });
    assert.equal(mod.routeComputerReset("windows365").action, "reject");
    assert.equal(mod.routeComputerReset("box").action, "reject");
    assert.equal(mod.routeComputerReset("grok-vm").action, "reject");
    assert.equal(mod.routeComputerReset(undefined).action, "reject");
    assert.equal(mod.mayCallHostedGrokVmRecreate("local-docker"), false);
    assert.equal(mod.mayCallHostedGrokVmRecreate("windows365"), false);
    assert.equal(mod.mayCallHostedGrokVmRecreate("box"), false);
    assert.equal(mod.mayCallHostedGrokVmRecreate("remote"), true);

    let hostedCalls = 0;
    const hosted = async () => {
      hostedCalls += 1;
      return { status: "started-untrackable" };
    };
    const localDocker = async () => ({ status: "started-untrackable", via: "docker" });
    const local = await mod.dispatchComputerReset({ runtime: "local-docker", hosted, localDocker });
    assert.equal(hostedCalls, 0);
    assert.equal(local.via, "docker");
    const w365 = await mod.dispatchComputerReset({ runtime: "windows365", hosted, localDocker });
    assert.equal(hostedCalls, 0);
    assert.equal(w365.status, "rejected");
    const leftoverBox = await mod.dispatchComputerReset({ runtime: "box", hosted, localDocker });
    assert.equal(hostedCalls, 0);
    assert.equal(leftoverBox.status, "rejected");
    await mod.dispatchComputerReset({ runtime: "remote", hosted, localDocker });
    assert.equal(hostedCalls, 1);

    const connector = await readFile(path.join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts"), "utf8");
    assert.match(connector, /dispatchComputerReset/);
    assert.doesNotMatch(connector, /usesLocalAgentHost\(settings\.getBoxRuntime\(\)\)/);
    const renderer = await readFile(path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx"), "utf8");
    assert.match(renderer, /boxRuntime === "windows365"/);
    assert.match(renderer, /cannot use the hosted Grok VM reset/);
    const banner = await readFile(path.join(repoRoot, "frontend/src/recovered/features/computer/rebuild/banner.tsx"), "utf8");
    assert.match(banner, /Resetting Grok VM/);
    assert.match(banner, /Resetting Local VM/);
    assert.doesNotMatch(banner, /Resetting Grok Bot's Computer/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("session present skips the login wall", async () => {
  const { temporary, mod } = await bundle("source/shared/cursor-session-policy.ts", "session-wall-");
  try {
    assert.equal(mod.cursorSessionPresent({ accessToken: "access", refreshToken: "refresh" }), true);
    assert.equal(mod.cursorSessionPresent({ accessToken: null, refreshToken: "refresh" }), false);
    assert.equal(mod.shouldShowCursorLoginWall({ kind: "logged-in" }), false);
    assert.equal(mod.shouldShowCursorLoginWall({ kind: "logged-out" }), true);
    assert.equal(mod.shouldShowCursorLoginWall({ kind: "logged-out" }, { skipped: true }), false);
    assert.equal(mod.shouldShowCursorLoginWall(null), false);

    const store = new Map([["cursor-access-token", "access-token"], ["cursor-refresh-token", "refresh-token"]]);
    const mock = {
      readSecret: async (key) => store.get(key) ?? null,
    };
    const [accessToken, refreshToken] = await Promise.all([mock.readSecret("cursor-access-token"), mock.readSecret("cursor-refresh-token")]);
    assert.equal(mod.cursorSessionPresent({ accessToken, refreshToken }), true);
    assert.equal(mod.shouldShowCursorLoginWall({ kind: "logged-in" }), false);

    const renderer = await readFile(path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx"), "utf8");
    assert.match(renderer, /shouldShowCursorLoginWall\(account, \{ skipped: subscriptionReady \}\)/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("provider switch logout does not run on launch or reinstall", async () => {
  const { temporary, mod } = await bundle("source/shared/cursor-session-policy.ts", "provider-logout-");
  try {
    assert.equal(mod.shouldLogoutCursorForProviderChange("launch"), false);
    assert.equal(mod.shouldLogoutCursorForProviderChange("reinstall"), false);
    assert.equal(mod.shouldLogoutCursorForProviderChange("reload"), false);
    assert.equal(mod.shouldLogoutCursorForProviderChange("explicit-user-switch"), false);
    const edge = await readFile(path.join(repoRoot, "source/electron-main/main-edge.ts"), "utf8");
    const routerLine = edge.split("\n").find((line) => line.includes("setInferenceRouter:"));
    assert.ok(routerLine);
    assert.doesNotMatch(routerLine, /logout/);
    const bootstrap = await readFile(path.join(repoRoot, "source/electron-main/startup/desktop-user-data-bootstrap.ts"), "utf8");
    assert.doesNotMatch(bootstrap, /logoutCursor|logout\(/);
    assert.match(bootstrap, /SAND_PERSIST_SECRETS_ON_DISK/);
    assert.match(bootstrap, /isReconstructedUserDataPath\(isolatedUserDataDir\)/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("reconstructed user-data path persists Cursor tokens without keychain", async () => {
  const { temporary, mod } = await bundle("source/shared/cursor-session-policy.ts", "persist-disk-");
  try {
    assert.equal(mod.shouldPersistSecretsOnDisk({ SAND_PERSIST_SECRETS_ON_DISK: "1" }, "/tmp/other"), true);
    assert.equal(mod.shouldPersistSecretsOnDisk({}, "/Users/x/Library/Application Support/OpenGrok-0.27/sand-secrets.json"), true);
    assert.equal(mod.shouldPersistSecretsOnDisk({ SAND_PERSIST_SECRETS_ON_DISK: "0" }, "/Users/x/Library/Application Support/OpenGrok-0.27/sand-secrets.json"), false);
    assert.equal(mod.shouldPersistSecretsOnDisk({}, "/Users/x/Library/Application Support/Grok Bot/sand-secrets.json"), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
