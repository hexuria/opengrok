import {
  outputApp,
  reconstructedBundleId,
  reconstructedName,
  reconstructedProductUrl
} from "./lib/config.mjs";
import { buildFidelityReconstructedAsar } from "./clean-build.mjs";
import { assembleReconstructedAppBundle } from "./lib/package-app-bundle.mjs";

if (process.platform !== "darwin") {
  throw new Error("The reconstructed macOS application can only be packaged on macOS.");
}

// Keep the checksum-pinned shipped renderer as the polished UI authority. Small
// reconstructed UI extensions are installed by the clean preload, leaving the
// original renderer chunks byte-for-byte intact.
const { builtAsar, builtAsarUnpacked } = await buildFidelityReconstructedAsar();
const verification = await assembleReconstructedAppBundle({
  builtAsar,
  builtAsarUnpacked,
  outputApp,
  bundleId: reconstructedBundleId,
  displayName: reconstructedName,
  productUrl: reconstructedProductUrl,
});

console.log(`Packaged application: ${outputApp} (${verification.runtime.nodeFileCount} native manifest entries, ${verification.runtime.runtimeFileCount} unpacked runtime files)`);
