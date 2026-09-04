import { outputApp } from "./lib/config.mjs";
import { releaseMacosApp } from "./lib/macos-release.mjs";

if (process.platform !== "darwin") {
  throw new Error("macOS distribution artifacts can only be produced on macOS.");
}

const result = await releaseMacosApp({ appPath: outputApp });
console.log(`Distribution zip: ${result.zipPath} (signed as ${result.identity}${result.notarized ? ", notarized and stapled" : ""})`);
