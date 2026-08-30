import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(thisDir, "../..");
export const sourceAppDir = path.join(repoRoot, "src", "app");
export const cacheDir = path.join(repoRoot, ".cache");
export const cachedRuntimeApp = path.join(cacheDir, "runtime", "Grok Bot.app");
export const cachedDmg = path.join(cacheDir, "downloads", "Grok_Bot_0.18.0.dmg");
export const archivedDmg = path.join(repoRoot, "research-archives", "original", "0.18.0", "macos-arm64", "Grok_Bot_0.18.0.dmg");
export const buildDir = path.join(repoRoot, ".build");
export const stagedAppDir = path.join(buildDir, "app");
export const builtAsar = path.join(buildDir, "app.asar");
export const builtAsarUnpacked = `${builtAsar}.unpacked`;
export const fidelityBuildDir = path.join(buildDir, "fidelity");
export const fidelityStagedAppDir = path.join(fidelityBuildDir, "app");
export const fidelityBuiltAsar = path.join(fidelityBuildDir, "app.asar");
export const fidelityBuiltAsarUnpacked = `${fidelityBuiltAsar}.unpacked`;
export const fidelityCandidateManifest = path.join(fidelityBuildDir, "release-candidate.json");
export const fidelityE2ECandidateManifest = path.join(fidelityBuildDir, "e2e-candidate.json");
export const fidelityReleaseEvidenceDir = path.join(fidelityBuildDir, "release-evidence");
export const outputDir = path.join(repoRoot, "dist");
const configuredOutputName = process.env.GROK_BOT_OUTPUT_APP_NAME?.trim();
export const outputApp = path.join(
  outputDir,
  configuredOutputName ? path.basename(configuredOutputName) : "Open Grok.app"
);
export const fidelityOutputApp = path.join(outputDir, "Grok Bot 0.18 Fidelity.app");
export const fidelityOutputAppForAsarHash = asarHash => {
  if (!/^[0-9a-f]{64}$/.test(asarHash)) throw new TypeError("A full lowercase ASAR SHA-256 is required");
  return path.join(outputDir, `Grok Bot 0.18 Fidelity-${asarHash.slice(0, 12)}.app`);
};
export const fidelityInstalledAppForAsarHash = asarHash => path.join("/Applications", path.basename(fidelityOutputAppForAsarHash(asarHash)));
export const recoveredFrontendDir = path.join(repoRoot, "recovered", "frontend");
export const recoveredRendererDir = path.join(recoveredFrontendDir, "app");
export const frontendDir = path.join(repoRoot, "frontend");
export const devOutputApp = path.join(outputDir, "Grok Bot 0.18 Dev.app");
export const devProfileDir = path.join(cacheDir, "dev-profile");

export const upstreamVersion = "0.18.0";
export const reconstructedBundleId = "bot.opengrok.app";
export const reconstructedName = "Open Grok";
export const reconstructedProductUrl = "https://OpenGrok.app";
export const fidelityBundleId = "bot.opengrok.app.fidelity";
export const fidelityName = "Grok Bot 0.18 Fidelity";
export const dmgUrl = "https://downloads.cursor.com/grokbot/stable/darwin-arm64/0.18.0/Grok_Bot_0.18.0.dmg";
export const dmgSha256 = "a253ccd8aab01e083f9812a0264354c5034d8ba7f0610bbb557e82ae77d203eb";
export const upstreamAsarSha256 = "6665408168466f9cacc6087e917890c17f59d2e2e9c2404a5c4a59ad79c1de58";
