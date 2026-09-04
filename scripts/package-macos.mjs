import {
  outputApp,
  reconstructedBundleId,
  reconstructedName,
  reconstructedProductUrl
} from "./lib/config.mjs";
import { buildReconstructedAsar } from "./clean-build.mjs";
import { assembleReconstructedAppBundle } from "./lib/package-app-bundle.mjs";

if (process.platform !== "darwin") {
  throw new Error("The reconstructed macOS application can only be packaged on macOS.");
}

// Vite is the shipped UI. package:diagnostic still builds the checksum-pinned
// 0.18 renderer.
const { builtAsar, builtAsarUnpacked } = await buildReconstructedAsar();
const verification = await assembleReconstructedAppBundle({
  builtAsar,
  builtAsarUnpacked,
  outputApp,
  bundleId: reconstructedBundleId,
  displayName: reconstructedName,
  productUrl: reconstructedProductUrl,
});

console.log(`Packaged application: ${outputApp} (${verification.runtime.nodeFileCount} native manifest entries, ${verification.runtime.runtimeFileCount} unpacked runtime files)`);
