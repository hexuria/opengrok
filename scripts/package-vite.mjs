import {
  reconstructedProductUrl,
  viteBundleId,
  viteDisplayName,
  viteOutputApp,
} from "./lib/config.mjs";
import { buildReconstructedAsar } from "./clean-build.mjs";
import { assembleReconstructedAppBundle } from "./lib/package-app-bundle.mjs";

if (process.platform !== "darwin") {
  throw new Error("The reconstructed macOS application can only be packaged on macOS.");
}

// Opt-in Vite renderer. `npm run package` stays on the checksum-pinned 0.18 UI
// so this can sit next to dist/Open Grok.app without replacing it.
const { builtAsar, builtAsarUnpacked } = await buildReconstructedAsar();
const verification = await assembleReconstructedAppBundle({
  builtAsar,
  builtAsarUnpacked,
  outputApp: viteOutputApp,
  bundleId: viteBundleId,
  displayName: viteDisplayName,
  productUrl: reconstructedProductUrl,
});

console.log(`Packaged Vite application: ${viteOutputApp} (${verification.runtime.nodeFileCount} native manifest entries, ${verification.runtime.runtimeFileCount} unpacked runtime files)`);
