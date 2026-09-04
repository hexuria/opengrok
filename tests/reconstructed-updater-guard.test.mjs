import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("source electron-main disables updater and telemetry without wrapping a 0.18 artifact", async () => {
  const main = await readFile(path.join(root, "source", "electron-main", "main.ts"), "utf8");
  assert.match(main, /SAND_DISABLE_UPDATES \?\?= "1"/);
  assert.match(main, /SAND_DISABLE_SENTRY \?\?= "1"/);
  assert.match(main, /SAND_DISABLE_TELEMETRY \?\?= "1"/);

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
