import { cp, mkdir, rm, writeFile } from "node:fs/promises";
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
import { verifyOfficialMacReference, verifyReconstructedMacPackage } from "./lib/macos-package-verification.mjs";
import { run } from "./lib/process.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";

if (process.platform !== "darwin") {
  throw new Error("The reconstructed macOS application can only be packaged on macOS.");
}

// Keep the checksum-pinned shipped renderer as the polished UI authority. Small
// reconstructed UI extensions are installed by the clean preload, leaving the
// original renderer chunks byte-for-byte intact.
const { builtAsar, builtAsarUnpacked, runtimeApp } = await buildFidelityReconstructedAsar();
// Keep the signed release audit separate from the reconstructed package audit:
// the official app is reference-only and is never used as the runtime payload.
await verifyOfficialMacReference({ runtimeApp });
await mkdir(outputDir, { recursive: true });
await rm(outputApp, { recursive: true, force: true });
await run(SYSTEM_TOOLS.ditto, [runtimeApp, outputApp]);
// The source DMG's quarantine/provenance applies to Anysphere's signed artifact,
// not to this differently identified local reconstruction. Leaving it attached
// makes Gatekeeper reject the otherwise valid ad-hoc signature before launch.
await run(SYSTEM_TOOLS.xattr, ["-cr", outputApp]);

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
await run(SYSTEM_TOOLS.plutil, ["-remove", "ElectronAsarIntegrity", infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-replace", "CFBundleIdentifier", "-string", reconstructedBundleId, infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-replace", "CFBundleDisplayName", "-string", reconstructedName, infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-replace", "GrokProductURL", "-string", reconstructedProductUrl, infoPlist]);
// The backend currently emits only the `sand` auth/deep-link target. Make the
// reconstructed bundle's claim explicit and remove inherited aliases such as
// `grokbot`; the original bundle remains untouched and remains reference-only.
await run(SYSTEM_TOOLS.plutil, ["-remove", "CFBundleURLTypes", infoPlist]);
// Two schemes on purpose: `sand` is what the Cursor auth callback redirects
// to (renaming it breaks sign-in); `opengrok` is the brand scheme for links
// we mint (shareable message URLs). See source/shared/deep-link.ts.
await run(SYSTEM_TOOLS.plutil, ["-insert", "CFBundleURLTypes", "-xml", "<array><dict><key>CFBundleTypeRole</key><string>Viewer</string><key>CFBundleURLName</key><string>Grok Bot reconstructed auth callback</string><key>CFBundleURLSchemes</key><array><string>sand</string></array></dict><dict><key>CFBundleTypeRole</key><string>Viewer</string><key>CFBundleURLName</key><string>OpenGrok deep links</string><key>CFBundleURLSchemes</key><array><string>opengrok</string></array></dict></array>", infoPlist]);
// CFBundleName must stay "Grok Bot": Electron derives nested helper bundle
// names from it and the app CRASHES on launch if they don't match (verified
// empirically). The menu-bar/About name instead comes from a localized
// InfoPlist.strings, which macOS prefers over the raw plist values.
const lprojDir = path.join(outputApp, "Contents", "Resources", "en.lproj");
await mkdir(lprojDir, { recursive: true });
await writeFile(path.join(lprojDir, "InfoPlist.strings"), `CFBundleName = "${reconstructedName}";\nCFBundleDisplayName = "${reconstructedName}";\n`);

await rm(path.join(outputApp, "Contents", "_CodeSignature"), { recursive: true, force: true });
let signedWith;
try {
  signedWith = await signAppBundle(outputApp);
} catch (error) {
  // macOS can transiently deny replacement of a nested framework signature
  // immediately after the copied runtime was in use. A second idempotent pass
  // succeeds once the kernel releases that code object.
  console.warn(`Initial signing pass failed; retrying once: ${String(error)}`);
  signedWith = await signAppBundle(outputApp);
}
await run(SYSTEM_TOOLS.codesign, ["--verify", "--deep", "--strict", outputApp]);
const verification = await verifyReconstructedMacPackage({
  officialApp: runtimeApp,
  reconstructedApp: outputApp,
  sourceUnpackedRoot: builtAsarUnpacked,
  packagedUnpackedRoot: packagedUnpacked,
});

console.log(`Packaged application: ${outputApp} (${verification.runtime.nodeFileCount} native manifest entries, ${verification.runtime.runtimeFileCount} unpacked runtime files)`);
