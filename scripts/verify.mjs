import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { extractFile, listPackage } from "@electron/asar";

import {
  outputApp,
  reconstructedBundleId,
  reconstructedName,
  repoRoot,
  sourceAppDir,
  upstreamAsarSha256,
} from "./lib/config.mjs";
import { prepareReconstructedElectronMainArtifactFallback } from "./lib/build-asar.mjs";
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

async function walkFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, target));
    else if (entry.isFile()) files.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return files.sort();
}

const electronMain = await readFile(path.join(sourceAppDir, "dist", "electron-main", "main.cjs"), "utf8");
const hostMain = await readFile(path.join(sourceAppDir, "dist", "host", "host-main.cjs"), "utf8");
const sourceMarkers = (electronMain.match(/^\/\/ src\//gm) ?? []).length + (hostMain.match(/^\/\/ src\//gm) ?? []).length;
if (sourceMarkers < 1_000) throw new Error(`Expected at least 1,000 surviving evidence source markers, found ${sourceMarkers}`);

await requirePath(builtAsar);
await requirePath(path.join(builtAsarUnpacked, "dist", "deps", "better-sqlite3", "build", "Release", "better_sqlite3.node"));
await requirePath(verifiedApp);
for (const helper of ["sand-op-launcher", "sand-webauthn-signer"]) {
  const target = path.join(builtAsarUnpacked, "dist", "native", helper);
  try {
    await access(target);
    throw new Error(`Packaged unpacked runtime still contains ${helper}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const listing = new Set(listPackage(builtAsar));
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
const packagedIcon = extractFile(builtAsar, iconPath);

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
const fallbackPaths = new Map([
  ["electron-main", "dist/recovered-source/electron-main/main.cjs"],
  ["host", "dist/recovered-source/host/host-main.cjs"],
]);
for (const runtime of runtimeComposition.filter(({ runtime: name }) => fallbackPaths.has(name))) {
  const fallbackPath = fallbackPaths.get(runtime.runtime);
  if (runtime.mode === "artifact-fallback" && !listing.has(`/${fallbackPath}`)) {
    throw new Error(`Artifact fallback has no packaged recovered-source entry: ${runtime.runtime}`);
  }
  if (runtime.mode === "clean-source" && listing.has(`/${fallbackPath}`)) {
    throw new Error(`Clean runtime still packages recovered-source fallback: ${runtime.runtime}`);
  }
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
const expectedElectronMainVerdict = electronMainComposition?.mode === "clean-source" ? "clean-source" : "blocked-artifact-fallback";
if (compositionAudit.replacementClosures["electron-main"]?.verdict !== expectedElectronMainVerdict) throw new Error(`Electron main composition verdict does not match packaged mode: ${electronMainComposition?.mode}`);
const hostComposition = runtimeComposition.find(runtime => runtime.runtime === "host");
const expectedHostVerdict = hostComposition?.mode === "clean-source" ? "clean-source" : "blocked-artifact-fallback";
if (compositionAudit.replacementClosures.host?.verdict !== expectedHostVerdict) {
  throw new Error(`Host composition verdict does not match packaged mode: ${hostComposition?.mode}`);
}
const rendererComposition = runtimeComposition.find(runtime => runtime.runtime === "renderer");
if (rendererComposition?.mode !== "clean-source") {
  if ((icon.bytes != null && packagedIcon.byteLength !== icon.bytes) || sha256(packagedIcon) !== icon.sha256) {
    throw new Error("Packaged app icon differs from its renderer runtime manifest");
  }
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
if (rendererComposition?.mode === "clean-source") {
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
} else if (rendererComposition?.mode === "checksum-pinned-artifact-runtime") {
  const acceptance = compositionAudit.rendererComposition?.artifactRuntimeAcceptance;
  if (rendererProvenance.schemaVersion !== 1 || rendererProvenance.mode !== rendererComposition.mode || rendererProvenance.upstreamAppAsarSha256 !== upstreamAsarSha256) throw new Error("Packaged artifact renderer provenance has the wrong identity.");
  if (acceptance?.verdict !== "verified" || acceptance.provenance !== rendererProvenancePath || acceptance.fileCount !== rendererProvenance.fileCount || acceptance.inventorySha256 !== rendererProvenance.inventorySha256) throw new Error("Packaged artifact renderer acceptance does not match its provenance.");
  if (!Array.isArray(rendererProvenance.files) || rendererProvenance.files.length !== rendererProvenance.fileCount) throw new Error("Packaged artifact renderer provenance has an invalid file inventory.");
  const declaredPaths = new Set();
  for (const file of rendererProvenance.files) {
    if (typeof file.path !== "string" || declaredPaths.has(file.path)) throw new Error("Packaged artifact renderer provenance contains a missing or duplicate path.");
    declaredPaths.add(file.path);
    const bytes = extractFile(builtAsar, `dist/renderer/${file.path}`);
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Packaged artifact renderer differs from its checksum inventory: ${file.path}`);
  }
  const packagedPaths = rendererListing.filter(entry => entry.startsWith("dist/renderer/")).map(entry => entry.slice("dist/renderer/".length)).filter(Boolean);
  const undeclaredFiles = packagedPaths.filter(candidate => !declaredPaths.has(candidate) && ![...declaredPaths].some(file => file.startsWith(`${candidate}/`)));
  if (undeclaredFiles.length > 0 || [...declaredPaths].some(file => !packagedPaths.includes(file))) throw new Error("Packaged artifact renderer contains undeclared or missing files.");
} else {
  throw new Error(`Unsupported packaged renderer mode: ${rendererComposition?.mode}`);
}

for (const relative of [
  ...(electronMainComposition?.mode === "clean-source" ? [] : ["dist/electron-main/main.cjs"]),
  ...(hostComposition?.mode === "clean-source" ? [] : ["dist/host/host-main.cjs"]),
]) {
  const evidence = await readFile(path.join(sourceAppDir, relative));
  const packaged = extractFile(builtAsar, relative);
  const expected = relative === "dist/electron-main/main.cjs"
    ? Buffer.from(prepareReconstructedElectronMainArtifactFallback(evidence.toString("utf8")))
    : evidence;
  if (sha256(expected) !== sha256(packaged)) throw new Error(`Artifact fallback differs from its deterministic immutable-evidence transform: ${relative}`);
}

for (const relative of [
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
  ...(electronMainComposition?.mode === "clean-source" ? ["dist/electron-main/main.cjs"] : []),
  ...(hostComposition?.mode === "clean-source" ? ["dist/host/host-main.cjs"] : []),
]) {
  const contents = extractFile(builtAsar, relative).toString("utf8");
  if (!contents.includes("// Deterministic clean-source")) throw new Error(`Runtime did not come from clean source: ${relative}`);
}

if (hostComposition?.mode === "clean-source") {
  if (!listing.has("/dist/host-production-bindings.json")) throw new Error("Clean host has no packaged binding provenance manifest.");
  const provenance = JSON.parse(extractFile(builtAsar, "dist/host-production-bindings.json").toString("utf8"));
  if (provenance.status !== "validated-clean-source" || provenance.executableGraph.forbiddenInputs.length > 0 || provenance.executableGraph.forbiddenOutputReferences.length > 0) {
    throw new Error("Clean host binding provenance is not fail-closed.");
  }
  for (const binding of provenance.bindings) {
    if (binding.module.includes("src/app") || binding.module.includes("dist/deps") || binding.module.includes("recovered/source-capsules")) {
      throw new Error(`Clean host binding smuggles first-party artifact code: ${binding.path}`);
    }
  }
}

if (electronMainComposition?.mode === "clean-source") {
  if (!listing.has("/dist/electron-main-production-bindings.json")) throw new Error("Clean Electron main has no packaged binding provenance manifest.");
  const provenance = JSON.parse(extractFile(builtAsar, "dist/electron-main-production-bindings.json").toString("utf8"));
  if (provenance.status !== "validated-clean-source" || provenance.executableGraph.forbiddenInputs.length > 0 || provenance.executableGraph.forbiddenOutputReferences.length > 0) throw new Error("Clean Electron-main binding provenance is not fail-closed.");
  for (const binding of provenance.bindings) {
    if (binding.module.includes("src/app") || binding.module.includes("dist/deps") || binding.module.includes("recovered/source-capsules")) throw new Error(`Clean Electron-main binding smuggles first-party artifact code: ${binding.path}`);
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
console.log(`Documented non-clean runtime boundaries: ${fallbackNames}. Evidence markers checked: ${sourceMarkers}. Repository: ${repoRoot}`);
