import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  outputDir,
  reconstructedProductUrl
} from "./lib/config.mjs";
import { buildReconstructedAsar } from "./clean-build.mjs";
import { signAppBundle } from "./lib/codesign.mjs";
import { verifyOfficialMacReference, verifyReconstructedMacPackage } from "./lib/macos-package-verification.mjs";
import { run } from "./lib/process.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";

if (process.platform !== "darwin") {
  throw new Error("The reconstructed macOS application can only be packaged on macOS.");
}

// Opt-in Vite renderer. `npm run package` stays on the checksum-pinned 0.18 UI
// so this can sit next to dist/Open Grok.app without replacing it.
const viteOutputApp = path.join(outputDir, "Open Grok Vite.app");
const viteBundleId = "bot.opengrok.app.vite";
const viteDisplayName = "Open Grok Vite";

const { builtAsar, builtAsarUnpacked, runtimeApp } = await buildReconstructedAsar();
await verifyOfficialMacReference({ runtimeApp });
await mkdir(outputDir, { recursive: true });
await rm(viteOutputApp, { recursive: true, force: true });
await run(SYSTEM_TOOLS.ditto, [runtimeApp, viteOutputApp]);
await run(SYSTEM_TOOLS.xattr, ["-cr", viteOutputApp]);

const resources = path.join(viteOutputApp, "Contents", "Resources");
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

const infoPlist = path.join(viteOutputApp, "Contents", "Info.plist");
await run(SYSTEM_TOOLS.plutil, ["-remove", "ElectronAsarIntegrity", infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-replace", "CFBundleIdentifier", "-string", viteBundleId, infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-replace", "CFBundleDisplayName", "-string", viteDisplayName, infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-replace", "GrokProductURL", "-string", reconstructedProductUrl, infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-remove", "CFBundleURLTypes", infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-insert", "CFBundleURLTypes", "-xml", "<array><dict><key>CFBundleTypeRole</key><string>Viewer</string><key>CFBundleURLName</key><string>Grok Bot reconstructed auth callback</string><key>CFBundleURLSchemes</key><array><string>sand</string></array></dict><dict><key>CFBundleTypeRole</key><string>Viewer</string><key>CFBundleURLName</key><string>OpenGrok deep links</string><key>CFBundleURLSchemes</key><array><string>opengrok</string></array></dict></array>", infoPlist]);
const lprojDir = path.join(viteOutputApp, "Contents", "Resources", "en.lproj");
await mkdir(lprojDir, { recursive: true });
await writeFile(path.join(lprojDir, "InfoPlist.strings"), `CFBundleName = "${viteDisplayName}";\nCFBundleDisplayName = "${viteDisplayName}";\n`);

await rm(path.join(viteOutputApp, "Contents", "_CodeSignature"), { recursive: true, force: true });
try {
  await signAppBundle(viteOutputApp);
} catch (error) {
  console.warn(`Initial signing pass failed; retrying once: ${String(error)}`);
  await signAppBundle(viteOutputApp);
}
await run(SYSTEM_TOOLS.codesign, ["--verify", "--deep", "--strict", viteOutputApp]);
const verification = await verifyReconstructedMacPackage({
  officialApp: runtimeApp,
  reconstructedApp: viteOutputApp,
  sourceUnpackedRoot: builtAsarUnpacked,
  packagedUnpackedRoot: packagedUnpacked,
});

console.log(`Packaged Vite application: ${viteOutputApp} (${verification.runtime.nodeFileCount} native manifest entries, ${verification.runtime.runtimeFileCount} unpacked runtime files)`);
