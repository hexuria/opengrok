import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { extractFile, listPackage } from "@electron/asar";

import {
  outputApp,
  reconstructedBundleId,
  reconstructedName,
  repoRoot,
} from "./lib/config.mjs";
import { canonicalizeRetainedElectronNativePackages } from "./build-electron-natives.mjs";
import { isNpmVendoredRendererAsset } from "./lib/renderer-runtime-assets.mjs";
import { resolvePackagedAppArtifacts } from "./lib/packaged-app.mjs";
import { capture, run } from "./lib/process.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";

function readAppArgument(argv) {
  const index = argv.indexOf("--app");
  if (index === -1) return outputApp;
  if (index !== argv.length - 2 || argv[index + 1]?.startsWith("--")) {
    throw new Error("Usage: node scripts/verify.mjs [--app /absolute/path/to/App.app]");
  }
  return path.resolve(argv[index + 1]);
}

const verifiedApp = readAppArgument(process.argv.slice(2));
const { asarPath: builtAsar, unpackedPath: builtAsarUnpacked } = resolvePackagedAppArtifacts(verifiedApp);

async function requirePath(target) {
  await access(target);
  return target;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

await requirePath(builtAsar);
await requirePath(path.join(builtAsarUnpacked, "dist", "deps", "better-sqlite3", "build", "Release", "better_sqlite3.node"));
await requirePath(verifiedApp);

const listing = new Set(listPackage(builtAsar));
const nativePacked = [...listing].filter(entry => entry === "/dist/native" || entry.startsWith("/dist/native/"));
if (nativePacked.length > 0) throw new Error(`ASAR still contains dist/native: ${nativePacked.join(", ")}`);
try {
  const unpackedNative = await walkFiles(path.join(builtAsarUnpacked, "dist", "native"));
  if (unpackedNative.length > 0) throw new Error(`Packaged unpacked runtime still contains dist/native: ${unpackedNative.join(", ")}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
for (const required of [
  "/dist/electron-main/main.cjs",
  "/dist/electron-dev-controls/main.cjs",
  "/dist/electron-preload/preload.cjs",
  "/dist/electron-preload/preload-dev-controls.cjs",
  "/dist/electron-preload/preload-webview.cjs",
  "/dist/electron-preload/preload-vnc.cjs",
  "/dist/node-agent-coordinator/main.cjs",
  "/dist/host/host-main.cjs",
  "/dist/host/agent-isolation/agent-store-worker.cjs",
  "/dist/host/agent-isolation/transcript-mirror-worker.cjs",
  "/dist/host/extensions/box-store-sync/box-store-vacuum-worker.cjs",
  "/dist/host/extensions/content-search/search-index-worker.cjs",
  "/dist/local-exec-daemon/main.cjs",
  "/dist/renderer/index.html",
  "/dist/reconstruction-build.json",
  "/dist/runtime-composition-audit.json",
  "/package.json",
]) {
  if (!listing.has(required)) throw new Error(`ASAR is missing ${required}`);
}

const rendererRuntimeManifest = JSON.parse(await readFile(path.join(repoRoot, "frontend/manifests/renderer-runtime-assets.json"), "utf8"));
const rendererAssets = [...(rendererRuntimeManifest.assets ?? []), ...(rendererRuntimeManifest.immutableAssets ?? [])];
const icon = rendererAssets.find(asset => asset.file === "app-icon-C7NKj2u7.png");
if (icon == null || typeof icon.sha256 !== "string") throw new Error("Renderer runtime manifest has no exact app icon record");
const iconPath = `dist/renderer/assets/${icon.file}`;
if (!listing.has(`/${iconPath}`)) throw new Error(`ASAR is missing ${iconPath}`);
extractFile(builtAsar, iconPath);

const rendererListing = [...listing].map(entry => entry.replace(/^\/+/, ""));
const rendererMaps = rendererListing.filter(entry => entry.startsWith("dist/renderer/") && entry.endsWith(".map"));
if (rendererMaps.length > 0) throw new Error(`Packaged renderer contains source maps: ${rendererMaps.join(", ")}`);
for (const relative of [
  "dist/node-deps/tree-sitter/build/Release/tree_sitter_runtime_binding.node",
  "dist/node-deps/tree-sitter-bash/build/Release/tree_sitter_bash_binding.node",
  "dist/node-deps/node_modules/node-addon-api/package.json",
  "dist/node-deps/node_modules/node-gyp-build/package.json",
]) {
  if (!listing.has(`/${relative}`)) throw new Error(`ASAR is missing generated Node runtime entry ${relative}`);
  await requirePath(path.join(builtAsarUnpacked, relative));
}

const buildManifest = JSON.parse(extractFile(builtAsar, "dist/reconstruction-build.json").toString("utf8"));
const runtimeComposition = buildManifest.runtimeComposition;
if (!Array.isArray(runtimeComposition)) throw new Error("Packaged build manifest has no runtime composition.");
for (const relative of ["dist/recovered-source/electron-main/main.cjs", "dist/recovered-source/host/host-main.cjs"]) {
  if (listing.has(`/${relative}`)) throw new Error(`Packaged ASAR still contains recovered-source fallback: ${relative}`);
}
const compositionAuditBytes = extractFile(builtAsar, "dist/runtime-composition-audit.json");
const compositionAudit = JSON.parse(compositionAuditBytes.toString("utf8"));
if (JSON.stringify(compositionAudit.runtimeComposition) !== JSON.stringify(runtimeComposition)) {
  throw new Error("Packaged runtime composition does not match the clean build contract.");
}
if (buildManifest.compositionAudit?.path !== "dist/runtime-composition-audit.json" || buildManifest.compositionAudit.sha256 !== sha256(compositionAuditBytes)) {
  throw new Error("Packaged runtime composition audit differs from its deterministic manifest.");
}
for (const assertion of compositionAudit.cleanRuntimeAssertions) {
  if (assertion.declaration === "clean-source" && assertion.verdict !== "clean") {
    throw new Error(`Runtime was declared clean without a clean executable closure: ${assertion.runtime}`);
  }
  if (assertion.graph.forbiddenEvidenceInputs.length > 0 || assertion.output.forbiddenEvidenceMarkers?.length > 0 || assertion.output.forbiddenEvidenceReferences?.length > 0) {
    throw new Error(`Runtime composition reaches immutable src/app evidence: ${assertion.runtime}`);
  }
}
const electronMainComposition = runtimeComposition.find(runtime => runtime.runtime === "electron-main");
if (electronMainComposition?.mode !== "clean-source") throw new Error(`Packaged electron-main must be clean-source, found ${electronMainComposition?.mode}`);
if (compositionAudit.replacementClosures["electron-main"]?.verdict !== "clean-source") throw new Error("Electron main composition verdict is not clean-source");
const hostComposition = runtimeComposition.find(runtime => runtime.runtime === "host");
if (hostComposition?.mode !== "clean-source") throw new Error(`Packaged host must be clean-source, found ${hostComposition?.mode}`);
if (compositionAudit.replacementClosures.host?.verdict !== "clean-source") {
  throw new Error("Host composition verdict is not clean-source");
}
const rendererComposition = runtimeComposition.find(runtime => runtime.runtime === "renderer");
if (rendererComposition?.mode !== "clean-source") {
  throw new Error(`Packaged renderer must be clean-source, found ${rendererComposition?.mode}`);
}
for (const output of buildManifest.outputs) {
  const bytes = extractFile(builtAsar, output.path);
  if (bytes.byteLength !== output.bytes || sha256(bytes) !== output.sha256) {
    throw new Error(`Packaged clean output differs from its deterministic manifest: ${output.path}`);
  }
}

const rendererProvenancePath = rendererComposition.provenance;
if (typeof rendererProvenancePath !== "string" || !listing.has(`/${rendererProvenancePath}`)) throw new Error("Packaged renderer has no provenance record.");
const rendererProvenance = JSON.parse(extractFile(builtAsar, rendererProvenancePath).toString("utf8"));
const packagedRendererIndex = extractFile(builtAsar, "dist/renderer/index.html").toString("utf8");
if (!/src="\.\/assets\//.test(packagedRendererIndex)) throw new Error("Packaged renderer index is not file-relative.");
const forbiddenRendererAssets = rendererListing.filter(entry => entry === "dist/renderer/assets/index-UbX-y3il.js" || entry === "dist/renderer/assets/mermaid.core-CYC_FcEu.js");
if (forbiddenRendererAssets.length > 0) throw new Error(`Packaged clean renderer contains forbidden opaque assets: ${forbiddenRendererAssets.join(", ")}`);
if (compositionAudit.rendererComposition?.productionActivation?.verified !== true) throw new Error("Renderer composition audit did not verify the clean production entry graph.");
if (rendererProvenance.mode !== "clean-source" || rendererProvenance.entrypoint !== "frontend/src/main.tsx") throw new Error("Packaged clean renderer provenance has the wrong root.");
if (rendererProvenance.graph?.forbiddenInputs?.length !== 0) throw new Error("Packaged clean renderer graph reaches immutable evidence.");
if (rendererProvenance.evidence?.closureSummary?.composedFeatureSurfaces !== 5 || rendererProvenance.evidence?.closureSummary?.shippedFeatureRoutes !== 11 || rendererProvenance.evidence?.closureSummary?.findings !== 0) throw new Error("Packaged clean renderer closure is incomplete.");
const expectedRendererRoutes = JSON.parse(await readFile(path.join(repoRoot, "manifests/reconstruction/renderer-closure.json"), "utf8")).routes.map(({ route, family, kind, reviewed, cleanComposition }) => ({ route, family, kind, reviewed, cleanComposition }));
if (JSON.stringify(rendererProvenance.evidence?.routeContracts) !== JSON.stringify(expectedRendererRoutes) || expectedRendererRoutes.length !== 11 || expectedRendererRoutes.some(route => route.reviewed !== true || route.cleanComposition !== "present")) throw new Error("Packaged renderer provenance does not preserve the exact 11 shipped route contracts.");
if (rendererProvenance.evidence?.uiSummary?.findings !== 0 || rendererProvenance.evidence?.emittedLazyEntries?.length !== 5) throw new Error("Packaged renderer provenance or lazy boundaries are incomplete.");
if (packagedRendererIndex.includes("index-UbX-y3il.js")) throw new Error("Packaged clean renderer still activates the immutable artifact entry chunk.");
const rendererRuntimeAssetPaths = new Set(rendererAssets.map(asset => `dist/renderer/assets/${asset.file}`));
for (const output of rendererProvenance.outputs.filter(output => output.path.endsWith(".js") && !rendererRuntimeAssetPaths.has(output.path) && !isNpmVendoredRendererAsset(output.path, rendererProvenance))) {
  const contents = extractFile(builtAsar, output.path).toString("utf8");
  if (!contents.includes('"Deterministic clean-source renderer: frontend/src/main.tsx";')) throw new Error(`Renderer chunk did not come from the clean production root: ${output.path}`);
}

for (const relative of [
  "dist/electron-main/main.cjs",
  "dist/host/host-main.cjs",
  "dist/electron-dev-controls/main.cjs",
  "dist/electron-preload/preload.cjs",
  "dist/electron-preload/preload-dev-controls.cjs",
  "dist/electron-preload/preload-webview.cjs",
  "dist/electron-preload/preload-vnc.cjs",
  "dist/host/agent-isolation/agent-store-worker.cjs",
  "dist/host/agent-isolation/transcript-mirror-worker.cjs",
  "dist/host/extensions/box-store-sync/box-store-vacuum-worker.cjs",
  "dist/host/extensions/content-search/search-index-worker.cjs",
  "dist/local-exec-daemon/main.cjs",
  "dist/node-agent-coordinator/main.cjs",
]) {
  const contents = extractFile(builtAsar, relative).toString("utf8");
  if (!contents.includes("// Deterministic clean-source")) throw new Error(`Runtime did not come from clean source: ${relative}`);
}
if (!extractFile(builtAsar, "dist/electron-main/main.cjs").toString("utf8").includes("// Deterministic clean-source production Electron main")) {
  throw new Error("Packaged electron-main does not carry the clean-source banner");
}
if (!extractFile(builtAsar, "dist/host/host-main.cjs").toString("utf8").includes("// Deterministic clean-source production host")) {
  throw new Error("Packaged host does not carry the clean-source banner");
}

if (!listing.has("/dist/host-production-bindings.json")) throw new Error("Clean host has no packaged binding provenance manifest.");
const hostProvenance = JSON.parse(extractFile(builtAsar, "dist/host-production-bindings.json").toString("utf8"));
if (hostProvenance.status !== "validated-clean-source" || hostProvenance.executableGraph.forbiddenInputs.length > 0 || hostProvenance.executableGraph.forbiddenOutputReferences.length > 0) {
  throw new Error("Clean host binding provenance is not fail-closed.");
}
for (const binding of hostProvenance.bindings) {
  if (binding.module.includes("src/app") || binding.module.includes("dist/deps") || binding.module.includes("recovered/source-capsules")) {
    throw new Error(`Clean host binding smuggles first-party artifact code: ${binding.path}`);
  }
}

if (!listing.has("/dist/electron-main-production-bindings.json")) throw new Error("Clean Electron main has no packaged binding provenance manifest.");
const electronMainProvenance = JSON.parse(extractFile(builtAsar, "dist/electron-main-production-bindings.json").toString("utf8"));
if (electronMainProvenance.status !== "validated-clean-source" || electronMainProvenance.executableGraph.forbiddenInputs.length > 0 || electronMainProvenance.executableGraph.forbiddenOutputReferences.length > 0) throw new Error("Clean Electron-main binding provenance is not fail-closed.");
for (const binding of electronMainProvenance.bindings) {
  if (binding.module.includes("src/app") || binding.module.includes("dist/deps") || binding.module.includes("recovered/source-capsules")) throw new Error(`Clean Electron-main binding smuggles first-party artifact code: ${binding.path}`);
}
const hostRetained = hostProvenance.executableGraph.retainedNativePackages;
const electronMainRetained = electronMainProvenance.executableGraph.retainedNativePackages;
if (!Array.isArray(hostRetained) || !Array.isArray(electronMainRetained)) {
  throw new Error("Clean activation provenance omitted esbuild-metafile retained natives");
}
const expectedRetained = canonicalizeRetainedElectronNativePackages([...hostRetained, ...electronMainRetained]);
const depsManifest = JSON.parse(await readFile(path.join(builtAsarUnpacked, "dist", "deps", "runtime-deps-manifest.json"), "utf8"));
if (depsManifest.retained?.source !== "esbuild-metafile" || JSON.stringify(depsManifest.retained.packages) !== JSON.stringify(expectedRetained)) {
  throw new Error("Staged retained natives do not match the production esbuild metafile");
}
if (expectedRetained.length === 0) {
  for (const name of ["whichlang-node", "whichlang-node-darwin-arm64", "@anysphere/tree-chunk-napi"]) {
    try {
      await access(path.join(builtAsarUnpacked, "dist", "deps", ...name.split("/"), "package.json"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`Retained native ${name} was staged without an esbuild-metafile mention`);
  }
}

const sourceFallbacks = runtimeComposition.filter(({ mode, sourceBundle }) => mode === "artifact-fallback" && sourceBundle != null);
for (const fallback of sourceFallbacks) {
  if (!fallback.sourceBundle || !listing.has(`/${fallback.sourceBundle}`)) {
    throw new Error(`Artifact fallback has no packaged clean source bundle: ${fallback.runtime}`);
  }
}

const infoPlist = path.join(verifiedApp, "Contents", "Info.plist");
const bundleId = await capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleIdentifier", "raw", infoPlist]);
if (bundleId !== reconstructedBundleId) throw new Error(`Unexpected reconstructed bundle ID: ${bundleId}`);
const displayName = await capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleDisplayName", "raw", infoPlist]);
if (displayName !== reconstructedName) throw new Error(`Unexpected reconstructed display name: ${displayName}`);
const plistText = await capture(SYSTEM_TOOLS.plutil, ["-convert", "xml1", "-o", "-", infoPlist]);
if (plistText.includes("ElectronAsarIntegrity")) throw new Error("Stale ElectronAsarIntegrity metadata remains in the reconstructed application");
const urlTypes = await capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleURLTypes", "xml1", "-o", "-", infoPlist]);
for (const scheme of ["sand", "opengrok"]) {
  if (!new RegExp(`<key>CFBundleURLSchemes</key>[\\s\\S]*<string>${scheme}</string>`).test(urlTypes)) {
    throw new Error(`Reconstructed application has no ${scheme} URL registration`);
  }
}

await run(SYSTEM_TOOLS.codesign, ["--verify", "--deep", "--strict", verifiedApp]);
const cleanCount = runtimeComposition.filter(({ mode }) => mode === "clean-source").length;
const fallbackNames = runtimeComposition.filter(({ mode }) => mode !== "clean-source").map(({ runtime }) => runtime).join(", ");
console.log(`Verified packaged ASAR ${builtAsar}.`);
console.log(`Verified ${cleanCount} executable clean-source runtimes, deterministic ASAR hashes, native dependencies, bundle identity, and code signature.`);
console.log(`Documented non-clean runtime boundaries: ${fallbackNames}. Packaged electron-main and host carry the clean-source banner. Repository: ${repoRoot}`);
