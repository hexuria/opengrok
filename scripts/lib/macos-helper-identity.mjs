import path from "node:path";

import { reconstructedBundleId } from "./config.mjs";

// Electron derives nested helper folder names from CFBundleName. Mixed names
// crash on launch, so the inner executable and helper prefix stay "Grok Bot"
// while CFBundleDisplayName / InfoPlist.strings carry "Open Grok".
export const MACOS_EXECUTABLE_NAME = "Grok Bot";

const HELPER_KINDS = Object.freeze([
  { electron: "Electron Helper", idSuffix: "helper" },
  { electron: "Electron Helper (GPU)", idSuffix: "helper.GPU" },
  { electron: "Electron Helper (Plugin)", idSuffix: "helper.Plugin" },
  { electron: "Electron Helper (Renderer)", idSuffix: "helper.Renderer" },
]);

function helperDisplayName(executableName, electronName) {
  return electronName.replace(/^Electron/, executableName);
}

export function electronHelperRenames(executableName = MACOS_EXECUTABLE_NAME) {
  return HELPER_KINDS.map(({ electron }) => ({
    from: electron,
    to: helperDisplayName(executableName, electron),
  }));
}

/**
 * Nested Electron helpers copied from npm Electron.app still advertise
 * com.github.Electron.helper*. Official Grok Bot uses com.anysphere.sand.helper*.
 * Launch Services treats either family as the vendor's app and will open that
 * binary when ours spawns a helper. Rewrite them under bot.opengrok.app before
 * signing. Chromium locates helpers by path, not bundle id.
 */
export function reconstructedHelperIdentities(parentBundleId = reconstructedBundleId, executableName = MACOS_EXECUTABLE_NAME) {
  return HELPER_KINDS.map(({ electron, idSuffix }) => ({
    folder: `${helperDisplayName(executableName, electron)}.app`,
    bundleId: `${parentBundleId}.${idSuffix}`,
  }));
}

export function helperInfoPlistPath(appPath, folder) {
  return path.join(appPath, "Contents", "Frameworks", folder, "Contents", "Info.plist");
}
