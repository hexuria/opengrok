import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(sourcePath) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-window-state-"));
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

const laptop = { x: 0, y: 0, width: 1800, height: 1130 };
const external = { x: 1800, y: 0, width: 1920, height: 1080 };

test("a window parked on an unplugged display is moved onto the laptop, not discarded", async () => {
  const loaded = await loadModule("source/electron-main/window-state-store.ts");
  try {
    const { resolveSandWindowLaunchPlacement } = loaded.module;
    // Live bug, 2026-09-14: V2 restored at 1799,1137 (old external) on a
    // 1800×1169 laptop. One-pixel sliver, looks like the app quit.
    const placement = resolveSandWindowLaunchPlacement({
      persisted: {
        version: 1,
        normalBounds: { x: 1799, y: 1137, width: 1800, height: 1129 },
        isMaximized: true,
      },
      workAreas: [laptop],
    });
    assert.ok(placement.bounds, "must return on-screen bounds so BrowserWindow gets x/y");
    assert.equal(placement.bounds.x, laptop.x);
    assert.equal(placement.bounds.y, laptop.y);
    assert.ok(placement.bounds.x + placement.bounds.width <= laptop.x + laptop.width);
    assert.ok(placement.bounds.y + placement.bounds.height <= laptop.y + laptop.height);
    assert.equal(placement.maximize, true, "maximize after relocating, on the remaining display");
  } finally {
    await loaded.dispose();
  }
});

test("a window still on a connected second display stays there", async () => {
  const loaded = await loadModule("source/electron-main/window-state-store.ts");
  try {
    const { resolveSandWindowLaunchPlacement } = loaded.module;
    const placement = resolveSandWindowLaunchPlacement({
      persisted: {
        version: 1,
        normalBounds: { x: 1900, y: 40, width: 1200, height: 800 },
        isMaximized: false,
      },
      workAreas: [laptop, external],
    });
    assert.deepEqual(placement.bounds, { x: 1900, y: 40, width: 1200, height: 800 });
    assert.equal(placement.maximize, false);
  } finally {
    await loaded.dispose();
  }
});

test("a fully visible window on the laptop is left in place", async () => {
  const loaded = await loadModule("source/electron-main/window-state-store.ts");
  try {
    const { resolveSandWindowLaunchPlacement } = loaded.module;
    const placement = resolveSandWindowLaunchPlacement({
      persisted: {
        version: 1,
        normalBounds: { x: 60, y: 50, width: 1280, height: 820 },
        isMaximized: false,
      },
      workAreas: [laptop],
    });
    assert.deepEqual(placement.bounds, { x: 60, y: 50, width: 1280, height: 820 });
  } finally {
    await loaded.dispose();
  }
});

test("no displays, or no saved state, does not maximize onto a ghost frame", async () => {
  const loaded = await loadModule("source/electron-main/window-state-store.ts");
  try {
    const { resolveSandWindowLaunchPlacement } = loaded.module;
    assert.deepEqual(
      resolveSandWindowLaunchPlacement({
        persisted: {
          version: 1,
          normalBounds: { x: 1799, y: 1137, width: 1800, height: 1129 },
          isMaximized: true,
        },
        workAreas: [],
      }),
      { bounds: null, maximize: false },
    );
    assert.deepEqual(
      resolveSandWindowLaunchPlacement({ persisted: null, workAreas: [laptop] }),
      { bounds: null, maximize: false },
    );
  } finally {
    await loaded.dispose();
  }
});

test("the main window is created hidden, placed, then shown", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/main.ts"), "utf8");
  assert.match(source, /show: false/);
  assert.match(
    source,
    /applySandWindowPlacement\(window, placement\);\s*window\.show\(\);/s,
    "show after apply so macOS window restoration cannot beat the on-screen bounds",
  );
});

test("applySandWindowPlacement persists the relocated bounds, not the ghost ones", async () => {
  const loaded = await loadModule("source/electron-main/window-state-persistence.ts");
  try {
    const { createWindowStatePersistence } = loaded.module;
    const dir = await mkdtemp(path.join(os.tmpdir(), "grok-window-state-apply-"));
    const statePath = path.join(dir, "window-state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        normalBounds: { x: 1799, y: 1137, width: 1800, height: 1129 },
        isMaximized: true,
      }),
    );
    const events = [];
    const window = {
      isDestroyed: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      maximize() {
        events.push("maximize");
      },
      getBounds: () => ({ x: 0, y: 0, width: 1040, height: 760 }),
      getNormalBounds: () => ({ x: 0, y: 0, width: 1040, height: 760 }),
      getContentBounds: () => ({ x: 0, y: 0, width: 1040, height: 760 }),
      setContentBounds(bounds) {
        events.push(["bounds", bounds]);
      },
      on(event, listener) {
        events.push(["on", event]);
        void listener;
      },
    };
    const persistence = createWindowStatePersistence({
      app: { getPath: () => dir },
      screen: { getAllDisplays: () => [{ workArea: laptop }], getDisplayMatching: () => ({ workArea: laptop }) },
      captureWarning: () => {},
    });
    const placement = persistence.resolveSandWindowPlacement();
    persistence.applySandWindowPlacement(window, placement);
    assert.equal(events[0][0], "bounds");
    assert.equal(events[0][1].x, 0);
    assert.equal(events[0][1].y, 0);
    assert.ok(events.some((item) => item === "maximize"), "maximize after the window is on the laptop");
    assert.ok(
      events.some((item) => Array.isArray(item) && item[0] === "on" && item[1] === "move"),
      "persistence is attached so the next close writes the on-screen frame",
    );
    await rm(dir, { recursive: true, force: true });
  } finally {
    await loaded.dispose();
  }
});
