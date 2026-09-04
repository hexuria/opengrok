import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(thisDir, "../..");
export const sourceAppDir = path.join(repoRoot, "src", "app");
export const cacheDir = path.join(repoRoot, ".cache");
export const buildDir = path.join(repoRoot, ".build");
export const stagedAppDir = path.join(buildDir, "app");
export const builtAsar = path.join(buildDir, "app.asar");
export const builtAsarUnpacked = `${builtAsar}.unpacked`;
export const outputDir = path.join(repoRoot, "dist");
const configuredOutputName = process.env.GROK_BOT_OUTPUT_APP_NAME?.trim();
export const outputApp = path.join(
  outputDir,
  configuredOutputName ? path.basename(configuredOutputName) : "Open Grok.app"
);
export const recoveredFrontendDir = path.join(repoRoot, "recovered", "frontend");
export const recoveredRendererDir = path.join(recoveredFrontendDir, "app");
export const frontendDir = path.join(repoRoot, "frontend");
export const devOutputApp = path.join(outputDir, "Grok Bot 0.18 Dev.app");
export const devProfileDir = path.join(cacheDir, "dev-profile");

export const upstreamVersion = "0.18.0";
export const reconstructedBundleId = "bot.opengrok.app";
export const reconstructedName = "Open Grok";
export const reconstructedProductUrl = "https://OpenGrok.app";
export const reconstructedCopyright = "Copyright © 2026 Open Grok";
export const viteOutputApp = path.join(outputDir, "Open Grok Vite.app");
export const viteBundleId = "bot.opengrok.app.vite";
export const viteDisplayName = "Open Grok Vite";
