import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-coordinator-local-slot-"));
  const output = path.join(temporary, "coordinator-account-runtime.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/coordinator/coordinator-account-runtime.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function mockRuntime() {
  return {
    requestRendererPort() {},
    revokeRendererPortRequest() {},
    async restart() {},
    async dispose() {},
  };
}

function runtimeDeps(overrides = {}) {
  const launches = [];
  const authorizations = [];
  const problems = [];
  return {
    launches,
    authorizations,
    problems,
    deps: {
      createRuntime() {
        launches.push("launch");
        return mockRuntime();
      },
      async authorizeAccount(slot) {
        authorizations.push(slot);
        return true;
      },
      async revokeRefusedAccount() {
        return { kind: "ok", status: { kind: "logged-out" } };
      },
      async prepareAccountTransition() {},
      resetAccountState() {},
      revokeMainDataPort() {},
      deliverStatus() {},
      onProblem(detail) { problems.push(detail); },
      ...overrides,
    },
  };
}

test("coordinatorSlotForStatus uses the local slot when Cursor is signed out", async () => {
  const loaded = await loadModule();
  try {
    const { coordinatorSlotForStatus, cursorAccountSlot, LOCAL_SUBSCRIPTION_COORDINATOR_SLOT } = loaded.module;
    assert.equal(cursorAccountSlot({ kind: "logged-out" }), null);
    assert.equal(coordinatorSlotForStatus({ kind: "logged-out" }, null), null);
    assert.equal(
      coordinatorSlotForStatus({ kind: "logged-out" }, LOCAL_SUBSCRIPTION_COORDINATOR_SLOT),
      LOCAL_SUBSCRIPTION_COORDINATOR_SLOT,
    );
    assert.equal(
      coordinatorSlotForStatus({ kind: "logged-in", authId: "user-1" }, LOCAL_SUBSCRIPTION_COORDINATOR_SLOT),
      "user-1",
    );
    const { localSubscriptionSlotFromStore } = loaded.module;
    assert.equal(localSubscriptionSlotFromStore({ getCursorLoginWallSkipped: () => true }), LOCAL_SUBSCRIPTION_COORDINATOR_SLOT);
    assert.equal(localSubscriptionSlotFromStore({ getInferenceProvider: () => "openrouter" }), LOCAL_SUBSCRIPTION_COORDINATOR_SLOT);
    assert.equal(localSubscriptionSlotFromStore({ getInferenceProvider: () => "cursor" }), null);
  } finally {
    await loaded.dispose();
  }
});

test("logged-out Cursor still launches coordinator when a local subscription slot is set", async () => {
  const loaded = await loadModule();
  try {
    const { createCoordinatorAccountRuntime, LOCAL_SUBSCRIPTION_COORDINATOR_SLOT } = loaded.module;
    const harness = runtimeDeps({ localSlot: () => LOCAL_SUBSCRIPTION_COORDINATOR_SLOT });
    const runtime = createCoordinatorAccountRuntime(harness.deps);
    await runtime.start({ kind: "logged-out" });
    assert.deepEqual(harness.authorizations, [LOCAL_SUBSCRIPTION_COORDINATOR_SLOT]);
    assert.equal(harness.launches.length, 1);
    await runtime.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("logged-out Cursor does not launch coordinator without a local slot", async () => {
  const loaded = await loadModule();
  try {
    const { createCoordinatorAccountRuntime } = loaded.module;
    const harness = runtimeDeps();
    const runtime = createCoordinatorAccountRuntime(harness.deps);
    await runtime.start({ kind: "logged-out" });
    assert.deepEqual(harness.authorizations, []);
    assert.equal(harness.launches.length, 0);
    await runtime.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("restart launches an inactive coordinator after a local slot appears", async () => {
  const loaded = await loadModule();
  try {
    const { createCoordinatorAccountRuntime, LOCAL_SUBSCRIPTION_COORDINATOR_SLOT } = loaded.module;
    let slot = null;
    const harness = runtimeDeps({ localSlot: () => slot });
    const runtime = createCoordinatorAccountRuntime(harness.deps);
    await runtime.start({ kind: "logged-out" });
    assert.equal(harness.launches.length, 0);
    slot = LOCAL_SUBSCRIPTION_COORDINATOR_SLOT;
    await runtime.restart();
    assert.deepEqual(harness.authorizations, [LOCAL_SUBSCRIPTION_COORDINATOR_SLOT]);
    assert.equal(harness.launches.length, 1);
    await runtime.dispose();
  } finally {
    await loaded.dispose();
  }
});

test("local Claude coordinator reports connected and keeps host agents from wiping the roster", async () => {
  const mainSource = await readFile(path.join(repoRoot, "source/node-agent-coordinator/main.ts"), "utf8");
  assert.match(mainSource, /usesLocalCoordinator\(dataDir\)/);
  assert.match(mainSource, /state: "connected"/);
  assert.match(mainSource, /event\.channel === "agents" \|\| event\.channel === "agent-upserted"\) && usesLocalInference\(dataDir\)/);
  assert.match(mainSource, /routed\.handled/);
  const providerSource = await readFile(path.join(repoRoot, "source/electron-main/coordinator/production-provider.ts"), "utf8");
  assert.match(providerSource, /LOCAL_SUBSCRIPTION_COORDINATOR_SLOT/);
  assert.match(providerSource, /if \(slot === LOCAL_SUBSCRIPTION_COORDINATOR_SLOT\) return true/);
});
