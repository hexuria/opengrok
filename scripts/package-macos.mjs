import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  outputApp,
  outputDir,
  reconstructedBundleId,
  reconstructedName,
  reconstructedProductUrl
} from "./lib/config.mjs";
import { buildFidelityReconstructedAsar } from "./clean-build.mjs";
import { signAppBundle } from "./lib/codesign.mjs";
import { removePlistKeyIfPresent, stageNpmElectronShell } from "./lib/electron-shell.mjs";
import {
  verifyNpmElectronMacShell,
  verifyReconstructedHelperIdentities,
  verifyReconstructedMacPackage
} from "./lib/macos-package-verification.mjs";
import { run } from "./lib/process.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";

if (process.platform !== "darwin") {
  throw new Error("The reconstructed macOS application can only be packaged on macOS.");
}

// Keep the checksum-pinned shipped renderer as the polished UI authority. Small
// reconstructed UI extensions are installed by the clean preload, leaving the
// original renderer chunks byte-for-byte intact.
const { builtAsar, builtAsarUnpacked } = await buildFidelityReconstructedAsar();
await mkdir(outputDir, { recursive: true });
await rm(outputApp, { recursive: true, force: true });
const { sourceApp: electronApp } = await stageNpmElectronShell({
  destinationApp: outputApp,
  bundleId: reconstructedBundleId,
  displayName: reconstructedName,
  productUrl: reconstructedProductUrl
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
const verification = await verifyReconstructedMacPackage({
  reconstructedApp: outputApp,
  sourceUnpackedRoot: builtAsarUnpacked,
  packagedUnpackedRoot: packagedUnpacked
});

console.log(`Packaged application: ${outputApp} (${verification.runtime.nodeFileCount} native manifest entries, ${verification.runtime.runtimeFileCount} unpacked runtime files)`);
