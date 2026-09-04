import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  reconstructedBundleId,
  reconstructedCopyright,
  reconstructedName,
  reconstructedProductUrl,
  repoRoot,
  upstreamVersion,
} from "./config.mjs";
import {
  electronHelperRenames,
  helperInfoPlistPath,
  MACOS_EXECUTABLE_NAME,
  reconstructedHelperIdentities,
} from "./macos-helper-identity.mjs";
import { capture, run } from "./process.mjs";
import { SYSTEM_TOOLS } from "./system-tools.mjs";

export { electronHelperRenames, MACOS_EXECUTABLE_NAME };
export const NPM_ELECTRON_VERSION = "42.1.0";

// Two schemes on purpose: `sand` is what the Cursor auth callback redirects
// to (renaming it breaks sign-in); `opengrok` is the brand scheme for links
// we mint (shareable message URLs). See source/shared/deep-link.ts.
export const reconstructedUrlTypesXml = "<array><dict><key>CFBundleTypeRole</key><string>Viewer</string><key>CFBundleURLName</key><string>Grok Bot reconstructed auth callback</string><key>CFBundleURLSchemes</key><array><string>sand</string></array></dict><dict><key>CFBundleTypeRole</key><string>Viewer</string><key>CFBundleURLName</key><string>OpenGrok deep links</string><key>CFBundleURLSchemes</key><array><string>opengrok</string></array></dict></array>";

export function resolveNpmElectronApp(root = repoRoot) {
  return path.join(root, "node_modules", "electron", "dist", "Electron.app");
}

async function plistHasKey(plist, key) {
  try {
    await capture(SYSTEM_TOOLS.plutil, ["-extract", key, "raw", plist]);
    return true;
  } catch {
    return false;
  }
}

export async function setPlistString(plist, key, value) {
  if (await plistHasKey(plist, key)) {
    await run(SYSTEM_TOOLS.plutil, ["-replace", key, "-string", value, plist]);
    return;
  }
  await run(SYSTEM_TOOLS.plutil, ["-insert", key, "-string", value, plist]);
}

export async function removePlistKeyIfPresent(plist, key) {
  if (!(await plistHasKey(plist, key))) return;
  await run(SYSTEM_TOOLS.plutil, ["-remove", key, plist]);
}

export async function assertNpmElectronApp(sourceApp = resolveNpmElectronApp()) {
  const declared = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")).devDependencies?.electron;
  if (declared !== NPM_ELECTRON_VERSION) {
    throw new Error(`package.json electron devDependency must stay ${NPM_ELECTRON_VERSION}`);
  }
  try {
    const electronPkg = JSON.parse(await readFile(path.join(repoRoot, "node_modules", "electron", "package.json"), "utf8"));
    if (electronPkg.version !== NPM_ELECTRON_VERSION) {
      throw new Error(`node_modules/electron is ${electronPkg.version}, expected ${NPM_ELECTRON_VERSION}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Missing node_modules/electron@${NPM_ELECTRON_VERSION}. Run npm ci.`);
    throw error;
  }
  try {
    if (!(await stat(path.join(sourceApp, "Contents", "MacOS", "Electron"))).isFile()) {
      throw new Error(`npm Electron.app is incomplete: ${sourceApp}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Missing ${sourceApp}. Run node node_modules/electron/install.js to extract electron@${NPM_ELECTRON_VERSION}.`);
    }
    throw error;
  }
}

export async function writeLocalizedDisplayNames(appPath, displayName) {
  // npm Electron.app ships InfoPlist.strings in many locales with
  // CFBundleName = "Electron". A non-en macOS locale prefers those over
  // en.lproj and over the unlocalized plist, so every *.lproj must carry the
  // display name. Unlocalized CFBundleName stays Grok Bot for helper lookup.
  const resources = path.join(appPath, "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  const entries = await readdir(resources, { withFileTypes: true });
  const lprojs = new Set(entries.filter(entry => entry.isDirectory() && entry.name.endsWith(".lproj")).map(entry => entry.name));
  lprojs.add("en.lproj");
  const strings = `CFBundleName = "${displayName}";\nCFBundleDisplayName = "${displayName}";\n`;
  for (const lproj of lprojs) {
    const dir = path.join(resources, lproj);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "InfoPlist.strings"), strings);
  }
}

export async function renameElectronShell(appPath, executableName = MACOS_EXECUTABLE_NAME) {
  if (typeof appPath !== "string" || appPath.length === 0) throw new TypeError("An explicit application bundle path is required");
  const macos = path.join(appPath, "Contents", "MacOS");
  await rename(path.join(macos, "Electron"), path.join(macos, executableName));
  const frameworks = path.join(appPath, "Contents", "Frameworks");
  for (const { from, to } of electronHelperRenames(executableName)) {
    const fromApp = path.join(frameworks, `${from}.app`);
    try {
      await stat(fromApp);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`npm Electron.app is missing ${from}.app`);
      throw error;
    }
    await rename(path.join(fromApp, "Contents", "MacOS", from), path.join(fromApp, "Contents", "MacOS", to));
    await rename(fromApp, path.join(frameworks, `${to}.app`));
  }
}

export async function applyMacBundleIdentity({
  appPath,
  bundleId = reconstructedBundleId,
  displayName = reconstructedName,
  executableName = MACOS_EXECUTABLE_NAME,
  productUrl = reconstructedProductUrl,
} = {}) {
  if (typeof appPath !== "string" || appPath.length === 0) throw new TypeError("An explicit application bundle path is required");
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  await setPlistString(infoPlist, "CFBundleIdentifier", bundleId);
  await setPlistString(infoPlist, "CFBundleDisplayName", displayName);
  await setPlistString(infoPlist, "CFBundleName", executableName);
  await setPlistString(infoPlist, "CFBundleExecutable", executableName);
  await setPlistString(infoPlist, "CFBundleShortVersionString", upstreamVersion);
  await setPlistString(infoPlist, "CFBundleVersion", upstreamVersion);
  await setPlistString(infoPlist, "NSHumanReadableCopyright", reconstructedCopyright);
  await setPlistString(infoPlist, "GrokProductURL", productUrl);
  // plutil -insert -xml replaces an XML plist wholesale; binary form inserts the key.
  await run(SYSTEM_TOOLS.plutil, ["-convert", "binary1", infoPlist]);
  await removePlistKeyIfPresent(infoPlist, "CFBundleURLTypes");
  await run(SYSTEM_TOOLS.plutil, ["-insert", "CFBundleURLTypes", "-xml", reconstructedUrlTypesXml, infoPlist]);
  await writeLocalizedDisplayNames(appPath, displayName);
  for (const { folder, bundleId: helperId } of reconstructedHelperIdentities(bundleId, executableName)) {
    const helperPlist = helperInfoPlistPath(appPath, folder);
    const helperName = folder.replace(/\.app$/, "");
    await setPlistString(helperPlist, "CFBundleIdentifier", helperId);
    await setPlistString(helperPlist, "CFBundleExecutable", helperName);
    await setPlistString(helperPlist, "CFBundleDisplayName", helperName);
    await setPlistString(helperPlist, "CFBundleName", helperName);
  }
}

export async function stageNpmElectronShell({
  destinationApp,
  sourceApp,
  bundleId = reconstructedBundleId,
  displayName = reconstructedName,
  productUrl = reconstructedProductUrl,
} = {}) {
  if (typeof destinationApp !== "string" || destinationApp.length === 0) {
    throw new TypeError("An explicit destinationApp is required");
  }
  const resolvedSource = sourceApp ?? resolveNpmElectronApp();
  if (sourceApp == null) await assertNpmElectronApp(resolvedSource);
  else if (!(await stat(path.join(resolvedSource, "Contents", "MacOS", "Electron"))).isFile()) {
    throw new Error(`Electron.app is incomplete: ${resolvedSource}`);
  }
  await rm(destinationApp, { recursive: true, force: true });
  await mkdir(path.dirname(destinationApp), { recursive: true });
  await run(SYSTEM_TOOLS.ditto, [resolvedSource, destinationApp]);
  await run(SYSTEM_TOOLS.xattr, ["-cr", destinationApp]);
  await renameElectronShell(destinationApp);
  await applyMacBundleIdentity({
    appPath: destinationApp,
    bundleId,
    displayName,
    productUrl,
  });
  const resources = path.join(destinationApp, "Contents", "Resources");
  await rm(path.join(resources, "app.asar"), { force: true });
  await rm(path.join(resources, "app.asar.unpacked"), { recursive: true, force: true });
  await rm(path.join(resources, "default_app.asar"), { force: true });
  await rm(path.join(resources, "default_app.asar.unpacked"), { recursive: true, force: true });
  return { appPath: destinationApp, sourceApp: resolvedSource };
}
