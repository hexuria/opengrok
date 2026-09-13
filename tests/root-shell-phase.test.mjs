import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  const temporary = await mkdtemp(path.join(os.tmpdir(), "root-shell-phase-"));
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

const readFrontend = async (relative) => (await readFile(path.join(repoRoot, relative), "utf8")).replaceAll("\r\n", "\n");

/*
 * The shell used to route an account with no bots into a five-screen first-run
 * flow, and the roster read was what decided which. That flow is gone: sign-in
 * lands on the shell, and an account with no bots makes its first one from the
 * empty state. What survives is the part that was worth keeping — the shell
 * waits for the roster instead of rendering a guess at it.
 */

whenFrontend("the shell waits for the roster instead of rendering an empty one", async () => {
  const { loaded, cleanup } = await load("frontend/src/production/patched-ui/root-shell-phase.ts");
  try {
    const base = {
      isSignedIn: true,
      isPrivacyBlocked: false,
      hasActiveAgent: false,
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

    // A roster that will not load is an error with a way out, not a wait.
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
    assert.equal(phase({ isPrivacyBlocked: true, rosterLoadFailed: true }), "ready");
    assert.equal(phase({ hasActiveAgent: true, hasLoadedAgents: false }), "ready");

    // Without a coordinator there is no roster to wait for.
    assert.equal(phase({ transport: "browser", hasLoadedAgents: false }), "ready");

    // An empty roster is now a resting state, not a question to be settled:
    // there is no first-run gate left to hold the shell back.
    assert.doesNotMatch(
      await readFrontend("frontend/src/production/patched-ui/root-shell-phase.ts"),
      /FirstRunGate|isOnboardingOpen/,
      "the first-run gate went with the flow it existed for",
    );
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
    assert.ok((2 * TAU) / 900 > (TAU / 1400) * 2, "the second spin is more than twice as fast");

    // Pauses hold still.
    assert.equal(pose(1400 + 100).yaw, pose(1400 + 200).yaw, "it rests between beats");

    // A bounce, then later a higher jump.
    assert.equal(pose(1400 + 260 + 10).hop, 16);
    assert.equal(pose(1400 + 260 + 650 + 900 + 240 + 10).hop, 30);

    // Each hop is identified by when its beat began, so it fires exactly once.
    assert.equal(pose(1400 + 260 + 10).beatStartMs, pose(1400 + 260 + 600).beatStartMs);
    assert.notEqual(pose(1400 + 260 + 10).beatStartMs, pose(CYCLE + 1400 + 260 + 10).beatStartMs);

    // Position comes from the clock, so a dropped frame cannot desynchronise it.
    assert.deepEqual(pose(CYCLE * 4 + 500), { ...pose(500), beatStartMs: pose(500).beatStartMs + CYCLE * 4 });
    assert.equal(pose(-5).yaw, 0);
  } finally {
    await cleanup();
  }

  const mascot = await readFrontend("frontend/src/production/patched-ui/Mascot3D.tsx");
  assert.match(mascot, /mascotLoadingPose\(now - st\.loadStart\)/, "the loop is driven by the clock");
  assert.match(mascot, /modeRef\.current/, "the mode is read through a ref so the loop is not torn down");

  const renderer = await readFrontend("frontend/src/production/ProductionRenderer.tsx");
  // While the failure is still inside its grace period the wait continues,
  // rather than the screen going blank between the two surfaces.
  assert.match(renderer, /rootShellPhase === "error" && !isRootErrorSettled/, "the loader covers the grace period");
  assert.match(renderer, /rootShellPhase === "error" && isRootErrorSettled/, "and the error waits for it");

  const shell = await readFrontend("frontend/src/recovered/features/window-chrome/root-shell-state.tsx");
  assert.match(shell, /<Mascot3D className="sand-loading__mascot" mode="loading" size=\{96\} \/>/);

  const error = await readFrontend("frontend/src/production/patched-ui/RootShellRosterError.tsx");
  // Stopped, but still watching the pointer: the error mascot is the idle one.
  assert.doesNotMatch(error, /mode=/, "no mode means idle, so its eyes still follow the pointer");
  assert.match(error, /className="sand-loading__retry"[\s\S]*?onClick=\{onRetry\}/, "retrying is the button's job");
});

/*
 * The first-run flow was five screens: three inert marketing panels carried over
 * from the recovered upstream app, a tool picker, and the bot-creation form.
 * Only the last wrote anything, and what it wrote is editable in the shell. Its
 * suggestion cards sent a templateId the server 404s on an unknown id, so the
 * two cards shown by default failed the hire outright.
 */
whenFrontend("the first-run flow is gone and the empty state offers the first bot", async () => {
  assert.ok(
    !existsSync(path.join(FRONTEND, "src/recovered/features/onboarding")),
    "the onboarding feature is deleted, not just unrouted",
  );

  const renderer = await readFrontend("frontend/src/production/ProductionRenderer.tsx");
  assert.doesNotMatch(renderer, /onboarding/i, "the renderer no longer routes, opens or consults a first-run flow");

  const shell = await readFrontend("frontend/src/recovered/features/window-chrome/root-shell-state.tsx");
  assert.match(shell, /Create your first Bot/, "an account with no bots is offered one");
  assert.match(shell, /<Mascot3D className="sand-first-bot__mascot" size=\{96\} \/>/, "the idle mascot greets a new account");
  assert.doesNotMatch(shell, /EMPTY_WORKSPACE_COPY = "No chats yet"/, "the bare placeholder is replaced");

  // The creation path is the shell's own: no template id to 404 on, and no
  // kickstart flag, which the server drops anyway.
  assert.match(renderer, /onCreateBot=\{\(\) => void createAgent\(\)\}/, "the button makes a bot the ordinary way");
  assert.doesNotMatch(renderer, /templateId|isKickstartRequested: true/, "no template hire from the shell");

  // A restarting coordinator is not a refused roster read. Signing in restarts
  // it twice, and a freshly launched one reports "down" until its stream is up;
  // recording that as a roster failure is what flashed "Couldn't load your bots"
  // at a brand-new account whose server had refused nothing.
  assert.doesNotMatch(
    renderer,
    /state === "down"\)? \{\s*setRosterLoadFailed\(true\)/,
    "a transport report never claims a roster failure",
  );
  assert.match(
    renderer,
    /setTransport\(state === "connected" \? "connected" : hasLoadedAgentsRef\.current \? "down" : "connecting"\)/,
    "before the first roster, a transport that is not up yet is still connecting",
  );

  // A pushed roster is a change signal, never the roster. The server's live
  // frames are built for its configured account and reach every open stream, so
  // adopting one paints another account's bots; the RPC is the path that knows
  // who is asking.
  assert.match(renderer, /client\.subscribe\("agents", \(\) => \{[\s\S]*?scheduleRosterRefresh\(\)/, "an agents push re-asks listAgents, coalesced");
  assert.doesNotMatch(renderer, /subscribe\("agents", \(value\) => \{[\s\S]{0,400}setAgents\(projected\)/, "a pushed roster is never adopted wholesale");
  assert.match(renderer, /if \(!completeRosterAgentIdsRef\.current\.includes\(projected\.id\)\) \{ scheduleRosterRefresh\(\)/, "an unknown upserted agent is verified over RPC, not adopted");

  // The palette's search is served from the server's configured account, not
  // the caller's, and it returns message snippets; a match for an agent this
  // identity's roster does not hold is dropped before it renders.
  assert.match(renderer, /searchAgents: async \(input\) => \{[\s\S]*?const known = new Set\(completeRosterAgentIdsRef\.current\);[\s\S]*?known\.has\(/, "search results are filtered to the identity-scoped roster");

  // A fresh sign-in has to re-read who signed in. The landing dismisses the
  // login wall on its own, but the account status only changes in the main
  // process, so without this the shell renders behind a logged-out account and
  // the empty state below never appears until the app is relaunched.
  assert.match(renderer, /observeAccountRef\.current\(status\)/, "a finished sign-in re-reads the account");

  // The bot-character renderer outlived the flow it was filed under: it draws
  // every agent avatar and backs the avatar editor.
  const avatar = await readFrontend("frontend/src/recovered/features/conversation/workspace/agent-avatar.tsx");
  assert.match(avatar, /from "\.\.\/\.\.\/agent-character\/character"/, "avatars come from the relocated module");
  assert.ok(existsSync(path.join(FRONTEND, "src/recovered/features/agent-character/suggestions.ts")),
    "the suggestion catalog is parked for the New Bot surface, not deleted");
});
