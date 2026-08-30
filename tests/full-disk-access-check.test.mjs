import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(sourcePath) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-fda-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, sourcePath)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function harness(overrides = {}) {
  const calls = { opened: [], dialogs: [], dismissed: 0 };
  const deps = {
    platform: "darwin",
    probe: () => "no-permission",
    dialog: { showMessageBox: async (options) => { calls.dialogs.push(options); return { response: 0 }; } },
    openExternal: (url) => { calls.opened.push(url); },
    hasAsked: () => false,
    markAsked: () => { calls.dismissed += 1; },
    ...overrides,
  };
  return { calls, deps };
}

test("the nudge fires only when the grant is actually missing and useful", async () => {
  const loaded = await loadModule("source/electron-main/startup/full-disk-access-check.ts");
  try {
    const { runFullDiskAccessCheck, FULL_DISK_ACCESS_PANE } = loaded.module;

    // Denied: offer the pane, and open exactly the Full Disk Access list.
    const denied = harness();
    assert.equal(await runFullDiskAccessCheck(denied.deps), "opened-settings");
    assert.deepEqual(denied.calls.opened, [FULL_DISK_ACCESS_PANE]);
    assert.match(FULL_DISK_ACCESS_PANE, /Privacy_AllFiles$/);

    // Already granted, or a Mac that never ran Messages: stay silent.
    for (const [probe, expected] of [["ok", "granted"], ["missing", "no-messages-db"]]) {
      const quiet = harness({ probe: () => probe });
      assert.equal(await runFullDiskAccessCheck(quiet.deps), expected);
      assert.equal(quiet.calls.dialogs.length, 0, `${probe} must not raise a dialog`);
    }

    // Not a Mac: the permission does not exist.
    const other = harness({ platform: "win32" });
    assert.equal(await runFullDiskAccessCheck(other.deps), "unsupported");
    assert.equal(other.calls.dialogs.length, 0);
  } finally {
    await loaded.dispose();
  }
});

test("the ask happens once, so it can never become a restart loop", async () => {
  const loaded = await loadModule("source/electron-main/startup/full-disk-access-check.ts");
  try {
    const { runFullDiskAccessCheck } = loaded.module;

    // The regression this guards: granting takes several steps in another app,
    // so the next launch still sees the permission missing. Asking again there
    // and offering another restart puts the app in a prompt-restart loop.
    let relaunched = 0;
    const loop = harness({
      relaunch: () => { relaunched += 1; },
      dialog: { showMessageBox: async () => ({ response: 0 }) },
    });
    assert.equal(await runFullDiskAccessCheck(loop.deps), "relaunching");
    assert.equal(relaunched, 1);
    assert.equal(loop.calls.dismissed, 1, "the ask must be recorded BEFORE the relaunch");

    // Second launch: already asked, so it probes nothing and shows nothing.
    let probed = 0;
    const second = harness({
      hasAsked: () => true,
      relaunch: () => { relaunched += 1; },
      probe: () => { probed += 1; return "no-permission"; },
    });
    assert.equal(await runFullDiskAccessCheck(second.deps), "already-asked");
    assert.equal(second.calls.dialogs.length, 0);
    assert.equal(probed, 0);
    assert.equal(relaunched, 1, "a second launch must never restart again");

    // "Not Now" is still recorded, so declining also cannot re-ask.
    const notNow = harness({ dialog: { showMessageBox: async () => ({ response: 1 }) } });
    assert.equal(await runFullDiskAccessCheck(notNow.deps), "declined");
    assert.equal(notNow.calls.dismissed, 1);
    assert.equal(notNow.calls.opened.length, 0);

    // The restart must be awaited: it stops the background helper first, and
    // the helper is the process that actually opens the database. Relaunching
    // without retiring it lets the new app adopt the old, denied decision.
    const order = [];
    const awaited = harness({
      relaunch: async () => { order.push("start"); await Promise.resolve(); order.push("finish"); },
      dialog: { showMessageBox: async () => ({ response: 0 }) },
    });
    assert.equal(await runFullDiskAccessCheck(awaited.deps), "relaunching");
    assert.deepEqual(order, ["start", "finish"], "the restart must be awaited, not fired and forgotten");

    // Declining the restart still counts as asked, and does not restart.
    let seen = 0;
    const later = harness({
      relaunch: () => { relaunched += 1; },
      dialog: { showMessageBox: async () => (seen++ === 0 ? { response: 0 } : { response: 1 }) },
    });
    assert.equal(await runFullDiskAccessCheck(later.deps), "opened-settings");
    assert.equal(relaunched, 1);

    // A permission nudge must never be able to stop the app from starting.
    const broken = harness({ probe: () => { throw new Error("tcc exploded"); } });
    const failures = [];
    broken.deps.reportFailure = (...args) => failures.push(args);
    assert.equal(await runFullDiskAccessCheck(broken.deps), "declined");
    assert.equal(failures.length, 1);
  } finally {
    await loaded.dispose();
  }
});
