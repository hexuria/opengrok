import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "acorn";
import { build } from "esbuild";

import {
  COMPONENT_SOURCE,
  MAIN_CHROME_SOURCE,
  containsUnquotedCodexIdentifier,
  patchOriginalComposerAttach,
  patchOriginalLoginWall,
  patchOriginalMainChrome,
  patchOriginalSettingsPanel,
  patchOriginalViewFallback,
} from "../scripts/lib/router-renderer-patch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pinnedRendererPath = path.join(repoRoot, "src/app/dist/renderer/assets/index-UbX-y3il.js");
const hasPinnedRenderer = existsSync(pinnedRendererPath);

async function loadModule(entry, outfileName) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-provider-switch-"));
  const output = path.join(temporary, outfileName);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function status(provider, authenticated, extra = {}) {
  return {
    provider,
    installed: extra.installed ?? true,
    authenticated,
    executablePath: extra.executablePath ?? (provider === "codex" ? "/bin/codex" : "/bin/claude"),
    loginCommand: extra.loginCommand ?? (provider === "codex" ? ["codex", "login"] : ["claude", "/login"]),
    prompt: extra.prompt ?? (authenticated ? "signed in" : `${provider} is not signed in.`),
  };
}

function signedInAuth(overrides = {}) {
  const logouts = [];
  return {
    logouts,
    auth: {
      async getStatus(provider) {
        return status(provider, true);
      },
      async startLogin() {
        throw new Error("already signed in");
      },
      async logout(provider) {
        logouts.push(provider);
        return { loggedOut: true, status: status(provider, false) };
      },
      ...overrides,
    },
  };
}

test("switching provider logs out the previous official session and does not leave it selected", async () => {
  const loaded = await loadModule("source/shared/node/provider-switch.ts", "provider-switch.mjs");
  try {
    const { applyInferenceProviderSwitch } = loaded.module;
    const { auth, logouts } = signedInAuth();
    let persisted = "cursor";
    let cursorLoggedOut = 0;
    const switched = await applyInferenceProviderSwitch({
      requested: "claude-code",
      current: "cursor",
      auth,
      persist: (provider) => { persisted = provider; },
      logoutCursor: async () => { cursorLoggedOut += 1; },
    });
    assert.equal(switched.ok, true);
    assert.equal(switched.provider, "claude-code");
    assert.equal(switched.persisted, true);
    assert.equal(switched.applied, true);
    assert.equal(switched.previousLoggedOut, "none");
    assert.equal(switched.previousSessionCleared, false);
    assert.equal(persisted, "claude-code");
    assert.equal(cursorLoggedOut, 0);
    assert.deepEqual(logouts, []);

    const next = await applyInferenceProviderSwitch({
      requested: "codex",
      current: persisted,
      auth,
      persist: (provider) => { persisted = provider; },
    });
    assert.equal(next.ok, true);
    assert.equal(next.provider, "codex");
    assert.equal(next.previousLoggedOut, "claude-code");
    assert.deepEqual(logouts, ["claude-code"]);
    assert.equal(persisted, "codex");
  } finally {
    await loaded.dispose();
  }
});

test("switching provider does not mark the computer unreachable or trigger reset/recover", async () => {
  const switchLoaded = await loadModule("source/shared/node/provider-switch.ts", "provider-switch.mjs");
  const computersLoaded = await loadModule("source/shared/provider-computers.ts", "provider-computers.mjs");
  const edgeLoaded = await loadModule("source/electron-main/main-edge.ts", "main-edge.mjs");
  try {
    const idle = computersLoaded.module.providerSwitchMustNotTouchComputer();
    assert.deepEqual(idle, {
      restartCoordinator: false,
      recreateComputer: false,
      markUnreachable: false,
      recoverComputer: false,
    });

    const { auth } = signedInAuth();
    let persisted = "cursor";
    const switched = await switchLoaded.module.applyInferenceProviderSwitch({
      requested: "claude-code",
      current: "cursor",
      auth,
      persist: (provider) => { persisted = provider; },
      logoutCursor: async () => {},
    });
    assert.deepEqual(switched.computer, idle);
    assert.equal(persisted, "claude-code");

    let provider = "cursor";
    const computers = {
      cursor: { activated: ["box"], selectedScreen: "box" },
      "claude-code": { activated: ["box"], selectedScreen: "box" },
      codex: { activated: [], selectedScreen: null },
      openrouter: { activated: [], selectedScreen: null },
    };
    const recover = [];
    const handlers = edgeLoaded.module.createMainEdgeHandlers({
      settingsStore: {
        getInferenceProvider: () => provider,
        setInferenceProvider: (value) => { provider = value; },
        getInferenceRouterUsage: () => null,
        getProviderComputers: () => computers,
        setProviderComputers: (value) => { Object.assign(computers, value); },
        getBoxRuntime: () => "remote",
        settingsPath: "/tmp/grok-bot-settings.json",
      },
      readHostSettingsFromBox: async () => ({}),
      syncHostSettingsToBox: async () => {
        throw new Error("provider switch must not sync inferenceProvider into the box");
      },
      subscriptionAuth: auth,
      cursorAccount: {
        getAuthStatus: async () => ({ kind: "logged-in" }),
        logout: async () => ({ kind: "logged-out" }),
      },
      boxRecovery: {
        restartCoordinator: () => recover.push("restart"),
        forceRecreateComputer: () => recover.push("recreate"),
      },
    });
    const result = await handlers.setInferenceRouter({ provider: "claude-code" });
    assert.equal(result.provider, "claude-code");
    assert.equal(result.applied, true);
    assert.equal(result.persisted, true);
    assert.deepEqual(result.computerImpact, idle);
    assert.deepEqual(recover, []);
    assert.deepEqual(result.computers.activated, ["box"]);
  } finally {
    await switchLoaded.dispose();
    await computersLoaded.dispose();
    await edgeLoaded.dispose();
  }
});

test("first-run and signed-out UI offer Cursor plus Choose Other Provider", async () => {
  const signIn = await readFile(path.join(repoRoot, "frontend/src/recovered/features/account/session/sign-in-status.tsx"), "utf8");
  assert.match(signIn, /data-first-run-logins="cursor-claude-codex"/);
  assert.match(signIn, /Choose Other Provider/);
  assert.match(signIn, /data-login-skip="1"/);
  assert.match(signIn, /onSkip/);
  assert.doesNotMatch(signIn, /Sign in with Claude/);
  assert.match(MAIN_CHROME_SOURCE, /data-first-run-logins","cursor-claude-codex"/);
  assert.match(MAIN_CHROME_SOURCE, /Choose Other Provider/);
  assert.match(MAIN_CHROME_SOURCE, /data-login-skip","1"/);
  assert.match(MAIN_CHROME_SOURCE, /RSkipLoginWall/);
  assert.match(MAIN_CHROME_SOURCE, /RBootProviderChrome/);
  assert.match(COMPONENT_SOURCE, /startSubscriptionLogin/);
  assert.match(COMPONENT_SOURCE, /label:"Claude Code"/);
  assert.match(COMPONENT_SOURCE, /Official Codex\/ChatGPT login on this Mac/);
  // Each refresh shells out to the provider CLIs, so a 2s poll spawned
  // subprocesses continuously while Settings stayed open.
  assert.match(COMPONENT_SOURCE, /setInterval\(load,15e3\)/);
  assert.doesNotMatch(COMPONENT_SOURCE, /setInterval\(load,2e3\)/);
  assert.match(COMPONENT_SOURCE, /Paste an API key first/);
  assert.match(COMPONENT_SOURCE, /setOpenRouterModel/);
  assert.match(COMPONENT_SOURCE, /org\/model:free/);
  assert.match(COMPONENT_SOURCE, /openRouterModel\?\?n\.model/);
  assert.match(COMPONENT_SOURCE, /return\[s,t,g,e\]/);
  assert.match(COMPONENT_SOURCE, /const\[s,e,g,u\]=RRouterState\(\)/);
  assert.match(COMPONENT_SOURCE, /onSaved:l=>u\(/);
  assert.doesNotMatch(COMPONENT_SOURCE, /onSaved:l=>e\(/);

  const edgeLoaded = await loadModule("source/electron-main/main-edge.ts", "main-edge.mjs");
  try {
    const handlers = edgeLoaded.module.createMainEdgeHandlers({
      settingsStore: {
        getInferenceProvider: () => "cursor",
        getInferenceRouterUsage: () => null,
        getBoxRuntime: () => "remote",
      },
      readHostSettingsFromBox: async () => ({}),
      syncHostSettingsToBox: async (settings) => settings,
      subscriptionAuth: signedInAuth().auth,
      cursorAccount: { getAuthStatus: async () => ({ kind: "logged-out" }) },
    });
    const state = await handlers.getInferenceRouter();
    assert.equal(state.firstRunLogins.cursor.label, "Sign in with Cursor");
    assert.equal(state.firstRunLogins["claude-code"].label, "Sign in with Claude");
    assert.equal(state.firstRunLogins.codex.label, "Sign in with Codex");
    assert.equal(state.firstRunLogins["claude-code"].command, "claude /login");
    assert.equal(state.firstRunLogins.codex.command, "codex login");
  } finally {
    await edgeLoaded.dispose();
  }
});

test("provider change is persisted and a subsequent turn uses the new provider", async () => {
  const switchLoaded = await loadModule("source/shared/node/provider-switch.ts", "provider-switch.mjs");
  const routerLoaded = await loadModule("source/node-agent-coordinator/inference-router.ts", "inference-router.mjs");
  const storeLoaded = await loadModule("source/shared/node/settings/sand-settings-store.ts", "settings-store.mjs");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-provider-persist-"));
  try {
    await writeFile(path.join(temporary, "settings.json"), JSON.stringify({ version: 1, inferenceProvider: "cursor" }));
    const { auth } = signedInAuth();
    const store = new storeLoaded.module.SandSettingsStore(path.join(temporary, "settings.json"));
    const switched = await switchLoaded.module.applyInferenceProviderSwitch({
      requested: "claude-code",
      current: store.getInferenceProvider(),
      auth,
      persist: (provider) => store.setInferenceProvider(provider),
      logoutCursor: async () => {},
    });
    assert.equal(switched.ok, true);
    assert.equal(store.getInferenceProvider(), "claude-code");

    const remoteCalls = [];
    const router = routerLoaded.module.createCoordinatorInferenceRouter({
      dataDir: temporary,
      postEvent() {},
      async dispatchRemote(method) {
        remoteCalls.push(method);
        return { entries: [] };
      },
      subscriptionAuth: {
        async getStatus(id) { return status(id, false, { prompt: `${id} is not signed in.` }); },
        async startLogin() { throw new Error("sendPrompt must not start login"); },
        async logout() { throw new Error("sendPrompt must not logout"); },
      },
    });
    assert.equal(router.provider(), "claude-code");
    const dispatched = await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hello", clientNonce: "n-persist" });
    assert.equal(dispatched.handled, true);
    assert.equal(dispatched.value.provider, "claude-code");
    assert.equal(remoteCalls.includes("sendPrompt"), false);
  } finally {
    await switchLoaded.dispose();
    await routerLoaded.dispose();
    await storeLoaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("per-provider computer config is stored separately and Settings-driven", async () => {
  const computersLoaded = await loadModule("source/shared/provider-computers.ts", "provider-computers.mjs");
  const edgeLoaded = await loadModule("source/electron-main/main-edge.ts", "main-edge.mjs");
  const storeLoaded = await loadModule("source/shared/node/settings/sand-settings-store.ts", "settings-store.mjs");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-provider-computers-"));
  try {
    const {
      activateProviderComputer,
      emptyProviderComputerMap,
      migrateBoxRuntimeIntoProviderComputers,
      selectProviderComputerScreen,
    } = computersLoaded.module;
    const cursorOnly = activateProviderComputer("claude-code", emptyProviderComputerMap()["claude-code"], "grok-vm", true);
    assert.deepEqual(cursorOnly.activated, []);
    const cursorGrok = activateProviderComputer("cursor", emptyProviderComputerMap().cursor, "grok-vm", true);
    assert.deepEqual(cursorGrok.activated, ["grok-vm"]);
    const migrated = migrateBoxRuntimeIntoProviderComputers("cursor", "local-docker");
    assert.deepEqual(migrated.cursor.activated, ["local-docker"]);
    assert.deepEqual(migrated["claude-code"].activated, []);

    const store = new storeLoaded.module.SandSettingsStore(path.join(temporary, "settings.json"));
    store.setInferenceProvider("cursor");
    store.setBoxRuntime("remote");
    const map = store.getProviderComputers();
    assert.ok(map.cursor.activated.includes("box") || map.cursor.activated.includes("local-docker"));

    let provider = "cursor";
    let computers = emptyProviderComputerMap();
    const recover = [];
    const handlers = edgeLoaded.module.createMainEdgeHandlers({
      settingsStore: {
        settingsPath: path.join(temporary, "settings.json"),
        getInferenceProvider: () => provider,
        setInferenceProvider: (value) => { provider = value; },
        getInferenceRouterUsage: () => null,
        getProviderComputers: () => computers,
        setProviderComputers: (value) => { computers = value; },
        getBoxRuntime: () => "remote",
        setBoxRuntime: () => {},
      },
      readHostSettingsFromBox: async () => ({}),
      syncHostSettingsToBox: async (settings) => settings,
      subscriptionAuth: signedInAuth().auth,
      cursorAccount: { getAuthStatus: async () => ({ kind: "logged-in" }), logout: async () => ({ kind: "logged-out" }) },
      boxRecovery: {
        restartCoordinator: () => recover.push("restart"),
        forceRecreateComputer: () => recover.push("recreate"),
      },
      startLocalDockerBox: async () => ({ mode: "local-docker" }),
      getLocalDockerStatus: async () => ({ available: true, running: true, ready: true, containerName: "test", image: "test", detail: "ready" }),
      stopLocalDockerBox: async () => {},
    });
    const docker = await handlers.setProviderComputer({ kind: "local-docker", enabled: true });
    assert.ok(docker.computers.activated.includes("local-docker"));
    const w365 = await handlers.setProviderComputer({ kind: "windows-365", enabled: true });
    assert.ok(w365.computers.activated.includes("windows-365"));
    const grok = await handlers.setProviderComputer({ kind: "grok-vm", enabled: true });
    assert.ok(grok.computers.activated.includes("grok-vm"));
    const box = await handlers.setProviderComputer({ kind: "box", enabled: true });
    assert.ok(box.computers.activated.includes("box"));
    assert.deepEqual(recover, []);
    const other = selectProviderComputerScreen("claude-code", emptyProviderComputerMap()["claude-code"], "local-docker");
    assert.equal(other.selectedScreen, null);
  } finally {
    await computersLoaded.dispose();
    await edgeLoaded.dispose();
    await storeLoaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("right-sidebar screen selection only changes the rendered screen among activated computers", async () => {
  const computersLoaded = await loadModule("source/shared/provider-computers.ts", "provider-computers.mjs");
  const edgeLoaded = await loadModule("source/electron-main/main-edge.ts", "main-edge.mjs");
  try {
    const { activateProviderComputer, emptyProviderComputerMap, screenSwitcherOptions, selectProviderComputerScreen } = computersLoaded.module;
    let config = emptyProviderComputerMap().cursor;
    config = activateProviderComputer("cursor", config, "local-docker", true);
    config = activateProviderComputer("cursor", config, "box", true);
    config = activateProviderComputer("cursor", config, "windows-365", true);
    const options = screenSwitcherOptions("cursor", config);
    assert.deepEqual(options.map((item) => item.id), config.activated);
    const selected = selectProviderComputerScreen("cursor", config, "box");
    assert.equal(selected.selectedScreen, "box");
    assert.deepEqual(selected.activated, config.activated);
    const ignored = selectProviderComputerScreen("cursor", config, "grok-vm");
    assert.notEqual(ignored.selectedScreen, "grok-vm");

    let provider = "cursor";
    let computers = { ...emptyProviderComputerMap(), cursor: selected };
    const recover = [];
    const handlers = edgeLoaded.module.createMainEdgeHandlers({
      settingsStore: {
        getInferenceProvider: () => provider,
        setInferenceProvider: (value) => { provider = value; },
        getInferenceRouterUsage: () => null,
        getProviderComputers: () => computers,
        setProviderComputers: (value) => { computers = value; },
        getBoxRuntime: () => "remote",
      },
      readHostSettingsFromBox: async () => ({}),
      syncHostSettingsToBox: async (settings) => settings,
      subscriptionAuth: signedInAuth().auth,
      cursorAccount: { getAuthStatus: async () => ({ kind: "logged-in" }) },
      boxRecovery: {
        restartCoordinator: () => recover.push("restart"),
        forceRecreateComputer: () => recover.push("recreate"),
      },
    });
    const result = await handlers.setComputerScreen({ screen: "local-docker" });
    assert.equal(result.provider, "cursor");
    assert.equal(result.computers.selectedScreen, "local-docker");
    assert.deepEqual(result.computerImpact, {
      restartCoordinator: false,
      recreateComputer: false,
      markUnreachable: false,
      recoverComputer: false,
      changeProvider: false,
    });
    assert.deepEqual(recover, []);
    assert.equal(provider, "cursor");
    assert.match(MAIN_CHROME_SOURCE, /setComputerScreen/);
    assert.doesNotMatch(COMPONENT_SOURCE, /forceRecreateComputer/);
    assert.doesNotMatch(COMPONENT_SOURCE, /setInferenceRouter\(c\)/);
  } finally {
    await computersLoaded.dispose();
    await edgeLoaded.dispose();
  }
});

test("OpenRouter model save persists through setInferenceRouter without restarting the coordinator", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-openrouter-model-"));
  const edgeLoaded = await loadModule("source/electron-main/main-edge.ts", "main-edge-model.mjs");
  const storeLoaded = await loadModule("source/shared/node/settings/sand-settings-store.ts", "settings-store-model.mjs");
  try {
    const settingsPath = path.join(temporary, "settings.json");
    const store = new storeLoaded.module.SandSettingsStore(settingsPath);
    store.setInferenceProvider("openrouter");
    store.setOpenRouterModel("nvidia/nemotron-3-ultra-550b-a55b:free");
    const recover = [];
    const handlers = edgeLoaded.module.createMainEdgeHandlers({
      settingsStore: store,
      readHostSettingsFromBox: async () => ({}),
      syncHostSettingsToBox: async (settings) => settings,
      subscriptionAuth: signedInAuth().auth,
      cursorAccount: { getAuthStatus: async () => ({ kind: "logged-out" }) },
      boxRecovery: { restartCoordinator: () => recover.push("restart") },
    });
    const saved = await handlers.setInferenceRouter({ openRouterModel: "minimax/minimax-m3:free" });
    assert.equal(saved.openRouterModel, "minimax/minimax-m3:free");
    assert.equal(saved.model, "minimax/minimax-m3:free");
    assert.equal(saved.provider, "openrouter");
    assert.deepEqual(structuredClone(saved).openRouterModel, "minimax/minimax-m3:free");
    assert.equal(store.getOpenRouterModel(), "minimax/minimax-m3:free");
    assert.deepEqual(recover, []);
    await assert.rejects(
      () => handlers.setInferenceRouter({ openRouterModel: "not a model" }),
      /OpenRouter model id/,
    );
    assert.equal(store.getOpenRouterModel(), "minimax/minimax-m3:free");
    store.setOpenRouterModel("not a model");
    assert.equal(store.getOpenRouterModel(), "minimax/minimax-m3:free");
    const ignored = await handlers.setInferenceRouter({});
    assert.equal(ignored.provider, "openrouter");
    assert.equal(ignored.openRouterModel, "minimax/minimax-m3:free");
    assert.deepEqual(recover, []);
  } finally {
    await edgeLoaded.dispose();
    await storeLoaded.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("lazy-view failure uses a toast instead of an unstyled Retry dump", { skip: !hasPinnedRenderer }, async () => {
  const source = await readFile(pinnedRendererPath, "utf8");
  assert.match(source, /This view failed to load/);
  const patched = patchOriginalViewFallback(source);
  assert.doesNotMatch(patched, /This view failed to load/);
  assert.doesNotMatch(patched, /p\.jsx\("button",\{type:"button",onClick:t,children:"Retry"\}\)/);
  assert.match(patched, /Couldn't open that screen/);
  assert.match(patched, /sand-settings-toast/);
});

test("original login wall skip patch is unique on the checksum-pinned renderer", { skip: !hasPinnedRenderer }, async () => {
  const source = await readFile(pinnedRendererPath, "utf8");
  const patched = patchOriginalLoginWall(source);
  assert.match(patched, /sand-cursor-login-skip/);
  assert.match(patched, /isSignedIn:!0/);
  assert.match(patched, /Ae=Ne\.status\.kind==="logged-in"\|\|/);
  assert.doesNotMatch(patched, /e\.isSignedIn\?\{kind:"shell"/);
  assert.match(patched, /slot:"local-subscription"/);
  assert.match(patched, /function Wzn\(n\)\{try\{const e=await n\(\);if\(e\.kind==="logged-in"\)/);
});

test("checksum-pinned composer stages leaf names and json-safe bytes", { skip: !hasPinnedRenderer }, async () => {
  const source = await readFile(pinnedRendererPath, "utf8");
  const patched = patchOriginalComposerAttach(source);
  assert.match(patched, /function D9n\(n\)\{const e=xft\(n\.name\)/);
  assert.match(patched, /sourcePath:qe/);
  assert.match(patched, /bytesBase64/);
  assert.match(patched, /filename:we,bytes:Pe,bytesBase64:/);
  assert.match(patched, /n\.stageAttachmentBytes\(e\)/);
  assert.doesNotMatch(patched, /n\.stageAttachmentBytes\(e\.filename,e\.bytes\)/);
  assert.doesNotMatch(patched, /stageAttachmentBytes\(\{filename:we,bytes:Pe\}\)/);
});

test("Router settings injection is valid JavaScript", async () => {
  parse(COMPONENT_SOURCE, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true });
  parse(MAIN_CHROME_SOURCE, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true });
  if (!hasPinnedRenderer) return;
  const assetsRoot = path.join(repoRoot, "src/app/dist/renderer/assets");
  const names = await readdir(assetsRoot);
  const panel = [];
  for (const name of names) {
    if (!name.endsWith(".js")) continue;
    const source = await readFile(path.join(assetsRoot, name), "utf8");
    if (source.includes("function Sa(s){") && source.includes('Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):null')) panel.push(source);
  }
  assert.equal(panel.length, 1);
  parse(patchOriginalSettingsPanel(panel[0]), { ecmaVersion: "latest", sourceType: "module" });
});

test("renderer patch never emits an unquoted codex identifier", async () => {
  assert.equal(containsUnquotedCodexIdentifier(COMPONENT_SOURCE), false);
  assert.equal(containsUnquotedCodexIdentifier(MAIN_CHROME_SOURCE), false);
  const chrome = patchOriginalMainChrome("const wDn=[];");
  assert.match(chrome, /Choose Other Provider/);
  assert.match(chrome, /RInstallFirstRunLogins/);
  assert.equal(
    containsUnquotedCodexIdentifier(`n==="cursor"?"cursor":n==="claude-code"?"claude-code":codex`),
    true,
  );
  assert.equal(
    containsUnquotedCodexIdentifier(`n==="cursor"?"cursor":n==="claude-code"?"claude-code":"codex"`),
    false,
  );
  const patched = patchOriginalSettingsPanel(
    'prefix;Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):null;Z=x==="usage"?a.jsx(Te,{children:a.jsx(Na,{})}):null;function Sa(s){return s}',
  );
  assert.equal(containsUnquotedCodexIdentifier(patched), false);
  assert.match(patched, /['"]codex['"]/);
  assert.match(COMPONENT_SOURCE, /RQuoteProvider/);
  assert.match(COMPONENT_SOURCE, /return n==="cursor"\?"cursor":n==="claude-code"\?"claude-code":n==="openrouter"\?"openrouter":"codex"/);
});

test("existing Claude/Codex fail-closed and Cursor-untouched paths still hold", async () => {
  const loaded = await loadModule("source/shared/node/subscription-cli-auth.ts", "subscription-cli-auth.mjs");
  try {
    const selected = await loaded.module.selectSubscriptionInferenceProvider({
      requested: "claude-code",
      current: "cursor",
      auth: {
        async getStatus(id) { return status(id, false); },
        async startLogin() { throw new Error("picking Claude must not start login"); },
        async logout() { throw new Error("picking Claude must not logout"); },
      },
    });
    assert.equal(selected.ok, true);
    assert.equal(selected.provider, "claude-code");
    assert.equal(selected.loginStarted, false);

    let logins = 0;
    let logouts = 0;
    const cursor = await loaded.module.selectSubscriptionInferenceProvider({
      requested: "cursor",
      current: "cursor",
      auth: {
        async getStatus(id) { return status(id, false); },
        async startLogin() { logins += 1; throw new Error("Cursor path must not login"); },
        async logout() { logouts += 1; throw new Error("Cursor path must not logout"); },
      },
    });
    assert.equal(cursor.ok, true);
    assert.equal(cursor.provider, "cursor");
    assert.equal(logins, 0);
    assert.equal(logouts, 0);
  } finally {
    await loaded.dispose();
  }
});

test("gemini transcribe toggle survives the settings whitelist round-trip", async () => {
  const storeLoaded = await loadModule("source/shared/node/settings/sand-settings-store.ts", "settings-store.mjs");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-transcribe-toggle-"));
  try {
    const settingsPath = path.join(temporary, "settings.json");
    const store = new storeLoaded.module.SandSettingsStore(settingsPath);
    assert.equal(store.getGeminiTranscribeEnabled(), false);
    store.setGeminiTranscribeEnabled(true);
    assert.equal(store.getGeminiTranscribeEnabled(), true);
    const reloaded = new storeLoaded.module.SandSettingsStore(settingsPath);
    assert.equal(reloaded.getGeminiTranscribeEnabled(), true);
    reloaded.setGeminiTranscribeEnabled(false);
    assert.equal(new storeLoaded.module.SandSettingsStore(settingsPath).getGeminiTranscribeEnabled(), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await storeLoaded.dispose();
  }
});

test("gemini transcribe language hints parse, persist, and reach the request body", async () => {
  const storeLoaded = await loadModule("source/shared/node/settings/sand-settings-store.ts", "settings-store.mjs");
  const geminiLoaded = await loadModule("source/electron-main/account/gemini-transcribe.ts", "gemini-transcribe.mjs");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-transcribe-langs-"));
  try {
    const { parseTranscribeLanguageTags, SandSettingsStore } = storeLoaded.module;
    assert.deepEqual(parseTranscribeLanguageTags("fil-PH, en-US"), ["fil-PH", "en-US"]);
    assert.deepEqual(parseTranscribeLanguageTags(["fil-PH", "fil-PH", "!!bad!!", "en"]), ["fil-PH", "en"]);
    assert.deepEqual(parseTranscribeLanguageTags(42), []);

    const settingsPath = path.join(temporary, "settings.json");
    const store = new SandSettingsStore(settingsPath);
    assert.deepEqual(store.getGeminiTranscribeLanguages(), ["en-US"]);
    store.setGeminiTranscribeLanguages("fil-PH en-US");
    assert.deepEqual(new SandSettingsStore(settingsPath).getGeminiTranscribeLanguages(), ["fil-PH", "en-US"]);
    store.setGeminiTranscribeLanguages("");
    assert.deepEqual(new SandSettingsStore(settingsPath).getGeminiTranscribeLanguages(), ["en-US"]);

    const bodies = [];
    const result = await geminiLoaded.module.transcribeWithGemini(
      { audio: Uint8Array.from([1, 2, 3]), mimeType: "audio/flac" },
      {
        apiKey: "test-key",
        ffmpegPath: null,
        languageCodes: ["fil-PH", "en-US"],
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(init.body));
          return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "kumusta" }] } }] }) };
        },
      },
    );
    assert.equal(result.text, "kumusta");
    assert.deepEqual(bodies[0].generationConfig.audioTranscriptionConfig.languageCodes, ["fil-PH"]);
    assert.equal(bodies[0].generationConfig.audioTranscriptionConfig.wordTimestamp, true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await storeLoaded.dispose();
    await geminiLoaded.dispose();
  }
});

test("gemini language hints strip English when another language is selected", async () => {
  const geminiLoaded = await loadModule("source/electron-main/account/gemini-transcribe.ts", "gemini-transcribe.mjs");
  try {
    const { effectiveGeminiLanguageCodes, transcribeWithGemini } = geminiLoaded.module;
    assert.deepEqual(effectiveGeminiLanguageCodes(["en-US", "fil-PH"]), ["fil-PH"]);
    assert.deepEqual(effectiveGeminiLanguageCodes(["fil-PH", "en-US"]), ["fil-PH"]);
    assert.deepEqual(effectiveGeminiLanguageCodes(["en-US", "en-GB"]), ["en-US", "en-GB"]);
    assert.deepEqual(effectiveGeminiLanguageCodes(["fil-PH", "ja-JP"]), ["fil-PH", "ja-JP"]);
    const bodies = [];
    await transcribeWithGemini(
      { audio: Uint8Array.from([1]), mimeType: "audio/flac" },
      {
        apiKey: "k", ffmpegPath: null, languageCodes: ["en-US", "fil-PH"],
        fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }) }; },
      },
    );
    assert.deepEqual(bodies[0].generationConfig.audioTranscriptionConfig.languageCodes, ["fil-PH"]);
  } finally {
    await geminiLoaded.dispose();
  }
});
