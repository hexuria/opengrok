import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = path.join(repoRoot, "frontend");
const present = existsSync(FRONTEND);

function whenFrontend(name, fn) {
  test(name, { skip: present ? false : "frontend/ is restored from stow; skip when absent" }, fn);
}

async function load(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "first-run-gate-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
  });
  const loaded = await import(pathToFileURL(outfile).href + "?" + Date.now());
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

/*
 * The bug these cover: signing in with an account that already had a bot showed
 * the first-run onboarding flow. The roster read is what proves an account is
 * not new, and a refused read used to be indistinguishable from an empty
 * roster, so a server that would not answer sent an established account
 * through first-run and offered to build it a second first bot.
 *
 * The rule is that an unread roster is never treated as an empty one.
 */

whenFrontend("an unread roster waits; only a counted empty roster means first-run", async () => {
  const { loaded, cleanup } = await load("frontend/src/recovered/features/onboarding/signed-in/model.ts");
  try {
    const route = (input) => loaded.resolveOnboardingRoute({ isSignedIn: true, hasSeenOnboarding: false, ...input });

    // The whole point: a failed probe must not look like a new account.
    assert.equal(route({ agentCount: null, isRosterKnown: false }), "pending");
    assert.equal(route({ agentCount: 0, isRosterKnown: true }), "onboarding");
    assert.equal(route({ agentCount: 3, isRosterKnown: true }), "shell");

    // An account that has already been through it never goes back.
    assert.equal(
      loaded.resolveOnboardingRoute({ isSignedIn: true, hasSeenOnboarding: true, agentCount: null, isRosterKnown: false }),
      "shell",
    );
    assert.equal(loaded.resolveOnboardingRoute({ isSignedIn: false, hasSeenOnboarding: false, agentCount: null }), "sign-in");

    // Callers that cannot say whether the roster is known keep the old answer,
    // so no existing call site changes meaning.
    assert.equal(route({ agentCount: null }), "onboarding");

    assert.ok(loaded.ONBOARDING_ROSTER_PROBE_ATTEMPTS > 1, "the probe retries before it gives up");
  } finally {
    await cleanup();
  }
});

whenFrontend("the shell waits for the roster instead of rendering an empty one", async () => {
  const { loaded, cleanup } = await load("frontend/src/production/patched-ui/root-shell-phase.ts");
  try {
    const base = {
      isSignedIn: true,
      isOnboardingOpen: false,
      isPrivacyBlocked: false,
      hasActiveAgent: false,
      gate: "ready",
      transport: "connected",
      hasLoadedAgents: true,
      rosterLoadFailed: false,
      hasRosterFailure: false,
      isRosterFetching: false,
    };
    const phase = (over) => loaded.selectRootShellPhase({ ...base, ...over });

    assert.equal(phase({}), "ready");

    // The window the shipped build left blank: connected, roster still in
    // flight. It used to render nothing, which reads as an account with no bots.
    assert.equal(phase({ hasLoadedAgents: false }), "loading");
    assert.equal(phase({ transport: "connecting", hasLoadedAgents: false }), "loading");
    assert.equal(phase({ gate: "unknown" }), "loading");
    assert.equal(phase({ gate: "pending" }), "loading");

    // A roster that will not load is an error with a way out, not a wait.
    assert.equal(phase({ gate: "error" }), "error");
    assert.equal(phase({ rosterLoadFailed: true }), "error");
    assert.equal(phase({ hasRosterFailure: true }), "error");
    assert.equal(phase({ transport: "down", hasLoadedAgents: false }), "error");

    // A connected transport is only a port handshake, so a failed roster over a
    // live transport still has to surface as an error.
    assert.equal(phase({ transport: "connected", hasLoadedAgents: false, rosterLoadFailed: true }), "error");

    // But a read that is still running outranks the last one's failure, so the
    // error surface never flashes on the way to a dashboard that loads fine.
    assert.equal(phase({ hasLoadedAgents: false, rosterLoadFailed: true, isRosterFetching: true }), "loading");
    assert.equal(phase({ hasLoadedAgents: false, hasRosterFailure: true, isRosterFetching: true }), "loading");
    assert.equal(phase({ hasLoadedAgents: false, gate: "error", isRosterFetching: true }), "loading");
    assert.equal(phase({ hasLoadedAgents: false, transport: "down", isRosterFetching: true }), "loading");
    // Once it has data, a background refresh never re-covers the shell.
    assert.equal(phase({ hasLoadedAgents: true, isRosterFetching: true }), "ready");
    // And a fetch that finishes without succeeding still lands on the error.
    assert.equal(phase({ hasLoadedAgents: false, rosterLoadFailed: true, isRosterFetching: false }), "error");

    // The error surface waits before taking the screen, so a failure recorded
    // between attempts at startup never flashes over a shell that loads fine.
    assert.ok(loaded.ROOT_SHELL_ERROR_GRACE_MS >= 500, "a failure has to persist to be shown");

    // Surfaces that own the screen are never painted over.
    assert.equal(phase({ isSignedIn: false, hasLoadedAgents: false }), "ready");
    assert.equal(phase({ isOnboardingOpen: true, hasLoadedAgents: false }), "ready");
    assert.equal(phase({ isPrivacyBlocked: true, rosterLoadFailed: true }), "ready");
    assert.equal(phase({ hasActiveAgent: true, hasLoadedAgents: false }), "ready");

    // Without a coordinator there is no roster to wait for.
    assert.equal(phase({ transport: "browser", hasLoadedAgents: false }), "ready");
  } finally {
    await cleanup();
  }
});

whenFrontend("the waiting loop spins, pauses, bounces, spins faster and jumps higher", async () => {
  const { loaded, cleanup } = await load("frontend/src/production/patched-ui/mascot-loading.ts");
  try {
    const { mascotLoadingPose: pose, MASCOT_LOADING_CYCLE_MS: CYCLE } = loaded;
    const TAU = Math.PI * 2;

    assert.equal(CYCLE, 1400 + 260 + 650 + 900 + 240 + 720);

    // It starts facing forward and closes each turn facing forward, so the 8 on
    // its back never gets stranded and the sphere never unwinds backwards.
    assert.equal(pose(0).yaw, 0);
    assert.ok(Math.abs(pose(1400).yaw - TAU) < 1e-9, "the slow beat is exactly one turn");
    assert.ok(Math.abs(pose(CYCLE - 1).yaw - 3 * TAU) < 1e-6, "three whole turns per cycle");
    assert.ok(Math.abs(pose(CYCLE).yaw % TAU) < 1e-9, "and the loop repeats from forward");

    // Halfway through the slow turn it has its back to us.
    const half = pose(700).yaw;
    assert.ok(half > 2 && half < TAU - 2, `back turned mid-beat, got ${half}`);

    // The turns speed up: the second spin covers two turns in less time.
    const slowRate = TAU / 1400;
    const fastRate = (2 * TAU) / 900;
    assert.ok(fastRate > slowRate * 2, "the second spin is more than twice as fast");

    // Pauses hold still.
    assert.equal(pose(1400 + 100).yaw, pose(1400 + 200).yaw, "it rests between beats");

    // A bounce, then later a higher jump.
    const bounce = pose(1400 + 260 + 10);
    const jump = pose(1400 + 260 + 650 + 900 + 240 + 10);
    assert.equal(bounce.hop, 16);
    assert.equal(jump.hop, 30);
    assert.ok(jump.hop > bounce.hop, "the second jump is the higher one");

    // Each hop is identified by when its beat began, so it fires exactly once.
    assert.equal(pose(1400 + 260 + 10).beatStartMs, pose(1400 + 260 + 600).beatStartMs);
    assert.notEqual(pose(1400 + 260 + 10).beatStartMs, pose(CYCLE + 1400 + 260 + 10).beatStartMs);

    // Position comes from the clock, so a dropped frame cannot desynchronise it.
    assert.deepEqual(pose(CYCLE * 4 + 500), { ...pose(500), beatStartMs: pose(500).beatStartMs + CYCLE * 4 });
    assert.equal(pose(-5).yaw, 0);
  } finally {
    await cleanup();
  }

  const { readFile } = await import("node:fs/promises");
  const mascot = await readFile(path.join(repoRoot, "frontend/src/production/patched-ui/Mascot3D.tsx"), "utf8");
  assert.match(mascot, /mascotLoadingPose\(now - st\.loadStart\)/, "the loop is driven by the clock");
  assert.match(mascot, /modeRef\.current/, "the mode is read through a ref so the loop is not torn down");

  const renderer = await readFile(path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx"), "utf8");
  // While the failure is still inside its grace period the wait continues,
  // rather than the screen going blank between the two surfaces.
  assert.match(renderer, /rootShellPhase === "error" && !isRootErrorSettled/, "the loader covers the grace period");
  assert.match(renderer, /rootShellPhase === "error" && isRootErrorSettled/, "and the error waits for it");

  const shell = await readFile(path.join(repoRoot, "frontend/src/recovered/features/window-chrome/root-shell-state.tsx"), "utf8");
  assert.match(shell, /<Mascot3D className="sand-loading__mascot" mode="loading" size=\{96\} \/>/);
  assert.doesNotMatch(shell, /className="sand-loading__mark"/, "the CSS ring is gone");

  const error = await readFile(path.join(repoRoot, "frontend/src/production/patched-ui/RootShellRosterError.tsx"), "utf8");
  // Stopped, but still watching the pointer: the error mascot is the idle one.
  assert.doesNotMatch(error, /mode=/, "no mode means idle, so its eyes still follow the pointer");
  assert.doesNotMatch(error, /sand-loading__mascot-button/, "the mascot is not a button; the retry button is");
  assert.match(error, /className="sand-loading__retry"[\s\S]*?onClick=\{onRetry\}/, "retrying is the button's job");
});
