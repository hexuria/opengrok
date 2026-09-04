import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

async function loadDesktopEnvironment() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opengrok-desktop-env-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(root, "source", "electron-main", "desktop-environment.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("source electron-main disables updater and telemetry without wrapping a 0.18 artifact", async () => {
  const loaded = await loadDesktopEnvironment();
  try {
    const { configureDesktopEnvironment } = loaded.module;
    const env = {};
    configureDesktopEnvironment({ env, isPackaged: true, isAttachProdBox: false, isLabBuild: false });
    assert.equal(env.SAND_DISABLE_UPDATES, "1");
    assert.equal(env.SAND_DISABLE_SENTRY, "1");
    assert.equal(env.SAND_DISABLE_TELEMETRY, "1");

    const preset = {
      SAND_DISABLE_UPDATES: "0",
      SAND_DISABLE_SENTRY: "0",
      SAND_DISABLE_TELEMETRY: "0",
    };
    configureDesktopEnvironment({ env: preset, isPackaged: true, isAttachProdBox: false, isLabBuild: false });
    assert.equal(preset.SAND_DISABLE_UPDATES, "0");
    assert.equal(preset.SAND_DISABLE_SENTRY, "0");
    assert.equal(preset.SAND_DISABLE_TELEMETRY, "0");
  } finally {
    await loaded.dispose();
  }

  const asar = await readFile(path.join(root, "scripts", "lib", "build-asar.mjs"), "utf8");
  assert.doesNotMatch(asar, /prepareReconstructedElectronMainArtifactFallback/);
  assert.doesNotMatch(asar, /applyReconstructedUpdaterGuard/);
  assert.doesNotMatch(asar, /enableReconstructedRuntimeSeams/);

  const cleanBuild = await readFile(path.join(root, "scripts", "clean-build.mjs"), "utf8");
  assert.doesNotMatch(cleanBuild, /reconstructedPackage/);
  const electronMainActivation = await readFile(path.join(root, "scripts", "electron-main-production-activation.mjs"), "utf8");
  assert.doesNotMatch(electronMainActivation, /applyReconstructedUpdaterGuard/);
  assert.doesNotMatch(electronMainActivation, /reconstructedPackage/);
});
