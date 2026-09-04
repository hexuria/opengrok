import { cp, rm } from "node:fs/promises";
import path from "node:path";

import { signAppBundle } from "./codesign.mjs";
import { removePlistKeyIfPresent, stageNpmElectronShell } from "./electron-shell.mjs";
import {
  verifyNpmElectronMacShell,
  verifyReconstructedHelperIdentities,
  verifyReconstructedMacPackage
} from "./macos-package-verification.mjs";
import { run } from "./process.mjs";
import { SYSTEM_TOOLS } from "./system-tools.mjs";

export async function assembleReconstructedAppBundle({
  builtAsar,
  builtAsarUnpacked,
  outputApp,
  bundleId,
  displayName,
  productUrl,
} = {}) {
  if ([builtAsar, builtAsarUnpacked, outputApp, bundleId, displayName, productUrl].some(value => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("assembleReconstructedAppBundle requires asar paths, outputApp, bundleId, displayName, and productUrl");
  }
  const { sourceApp: electronApp } = await stageNpmElectronShell({
    destinationApp: outputApp,
    bundleId,
    displayName,
    productUrl,
  });

  const resources = path.join(outputApp, "Contents", "Resources");
  const packagedAsar = path.join(resources, "app.asar");
  const packagedUnpacked = `${packagedAsar}.unpacked`;
  await rm(packagedAsar, { force: true });
  await rm(packagedUnpacked, { recursive: true, force: true });
  await cp(builtAsar, packagedAsar);
  await cp(builtAsarUnpacked, packagedUnpacked, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true
  });

  const infoPlist = path.join(outputApp, "Contents", "Info.plist");
  await removePlistKeyIfPresent(infoPlist, "ElectronAsarIntegrity");

  await rm(path.join(outputApp, "Contents", "_CodeSignature"), { recursive: true, force: true });
  try {
    await signAppBundle(outputApp);
  } catch (error) {
    // macOS can transiently deny replacement of a nested framework signature
    // immediately after the copied runtime was in use. A second idempotent pass
    // succeeds once the kernel releases that code object.
    console.warn(`Initial signing pass failed; retrying once: ${String(error)}`);
    await signAppBundle(outputApp);
  }
  await run(SYSTEM_TOOLS.codesign, ["--verify", "--deep", "--strict", outputApp]);
  await verifyReconstructedHelperIdentities({ reconstructedApp: outputApp });
  await verifyNpmElectronMacShell({ electronApp, reconstructedApp: outputApp });
  return verifyReconstructedMacPackage({
    reconstructedApp: outputApp,
    sourceUnpackedRoot: builtAsarUnpacked,
    packagedUnpackedRoot: packagedUnpacked,
  });
}
