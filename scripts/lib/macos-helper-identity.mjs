import path from "node:path";

import { reconstructedBundleId } from "./config.mjs";

/**
 * Nested Electron helpers copied from npm Electron.app still advertise
 * com.github.Electron.helper*. Official Grok Bot uses com.anysphere.sand.helper*.
 * Launch Services treats either family as the vendor's app and will open that
 * binary when ours spawns a helper. Rewrite them under bot.opengrok.app before
 * signing. Chromium locates helpers by path, not bundle id.
 */
export function reconstructedHelperIdentities(parentBundleId = reconstructedBundleId) {
  return [
    { folder: "Grok Bot Helper.app", bundleId: `${parentBundleId}.helper` },
    { folder: "Grok Bot Helper (GPU).app", bundleId: `${parentBundleId}.helper.GPU` },
    { folder: "Grok Bot Helper (Plugin).app", bundleId: `${parentBundleId}.helper.Plugin` },
    { folder: "Grok Bot Helper (Renderer).app", bundleId: `${parentBundleId}.helper.Renderer` },
  ];
}

export function helperInfoPlistPath(appPath, folder) {
  return path.join(appPath, "Contents", "Frameworks", folder, "Contents", "Info.plist");
}
