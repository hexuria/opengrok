import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  applyReconstructedUpdaterGuard,
  prepareReconstructedElectronMainArtifactFallback,
  reconstructedUpdaterGuard,
} from "../scripts/lib/build-asar.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("reconstructed fallback and clean packaging share one idempotent service guard", async () => {
  const source = "console.log('electron-main');\n";
  const guarded = applyReconstructedUpdaterGuard(source);
  assert.equal(guarded, `${reconstructedUpdaterGuard}${source}`);
  assert.equal(applyReconstructedUpdaterGuard(guarded), guarded);
  assert.match(guarded, /SAND_DISABLE_UPDATES \?\?= "1"/);
  assert.match(guarded, /SAND_DISABLE_SENTRY \?\?= "1"/);
  assert.match(guarded, /SAND_DISABLE_TELEMETRY \?\?= "1"/);

  const fallbackFixture = [
    "var isSandLabBuild2 = appPackageJson.sandLab === true;",
    "var isPrimaryInstance = !import_electron51.app.isPackaged || import_electron51.app.requestSingleInstanceLock();",
  ].join("\n");
  assert.ok(prepareReconstructedElectronMainArtifactFallback(fallbackFixture).startsWith(reconstructedUpdaterGuard));

  const cleanBuildSource = await readFile(path.join(root, "scripts", "clean-build.mjs"), "utf8");
  assert.match(cleanBuildSource, /fidelityRuntimeComposition, \{ reconstructedPackage: true \}/);
});
