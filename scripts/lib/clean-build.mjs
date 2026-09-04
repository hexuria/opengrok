import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { build as esbuild } from "esbuild";

import { buildAsar } from "./build-asar.mjs";
import {
  buildProductionRenderer,
  rendererProductionEntrypoint,
  rendererProductionProvenance,
} from "../renderer-production-build.mjs";
import {
  buildDir,
  repoRoot,
  stagedAppDir,
} from "./config.mjs";
import { officialMacReleaseAsarHash } from "./macos-shell-invariant.mjs";
import { stageNodeTreeSitterRuntime } from "../build-tree-sitter-node.mjs";
import { run } from "./process.mjs";

export { packStagedAppWithIntegrity, verifyStagedPackageIntegrity } from "./asar-integrity.mjs";

export const cleanBuildDir = path.join(buildDir, "clean-runtime");
export const fidelityCleanBuildDir = path.join(buildDir, "fidelity-clean-runtime");
export const rendererArtifactProvenance = "dist/renderer-artifact-provenance.json";

export const collectionsPageSourceDir = "source/electron-collections/page";
export const collectionsPageOutputDir = "dist/electron-collections/page";
export const collectionsPageStaticAssets = Object.freeze(["collections.html", "collections.css", "collections.js"]);

const executableReplacements = [
  "dist/electron-dev-controls/main.cjs",
  "dist/electron-preload/preload.cjs",
  "dist/electron-preload/preload-dev-controls.cjs",
  "dist/electron-preload/preload-webview.cjs",
  "dist/electron-preload/preload-vnc.cjs",
  "dist/electron-preload/preload-collections.cjs",
  "dist/electron-collections",
  "dist/host/agent-isolation/agent-store-worker.cjs",
  "dist/host/agent-isolation/transcript-mirror-worker.cjs",
  "dist/host/extensions/box-store-sync/box-store-vacuum-worker.cjs",
  "dist/host/extensions/content-search/search-index-worker.cjs",
  "dist/box-exec-daemon/main.cjs",
  "dist/local-exec-daemon/main.cjs",
  "dist/node-agent-coordinator/main.cjs",
  "dist/renderer",
];

export const runtimeComposition = Object.freeze([
  { runtime: "electron-main", path: "dist/electron-main/main.cjs", mode: "clean-source", source: "source/electron-main/main.ts" },
  { runtime: "electron-dev-controls", path: "dist/electron-dev-controls/main.cjs", mode: "clean-source", source: "source/electron-dev-controls/main.ts" },
  { runtime: "primary-preload", path: "dist/electron-preload/preload.cjs", mode: "clean-source", source: "source/electron-preload/preload.ts", entrypoint: "source/electron-preload/runtime/primary.ts" },
  { runtime: "dev-controls-preload", path: "dist/electron-preload/preload-dev-controls.cjs", mode: "clean-source", source: "source/electron-preload/preload-dev-controls.ts", entrypoint: "source/electron-preload/runtime/dev-controls.ts" },
  { runtime: "webview-preload", path: "dist/electron-preload/preload-webview.cjs", mode: "clean-source", source: "source/electron-preload/preload-webview.ts", entrypoint: "source/electron-preload/runtime/webview.ts" },
  { runtime: "vnc-preload", path: "dist/electron-preload/preload-vnc.cjs", mode: "clean-source", source: "source/electron-preload/preload-vnc.ts", entrypoint: "source/electron-preload/runtime/vnc.ts" },
  { runtime: "collections-preload", path: "dist/electron-preload/preload-collections.cjs", mode: "clean-source", source: "source/electron-preload/preload-collections.ts", entrypoint: "source/electron-preload/runtime/collections.ts" },
  { runtime: "collections-page-renderer", path: `${collectionsPageOutputDir}/collection-render.js`, mode: "clean-source", source: "source/shared/collections/collection-render.ts", entrypoint: "source/shared/collections/collection-render.ts" },
  { runtime: "node-agent-coordinator", path: "dist/node-agent-coordinator/main.cjs", mode: "clean-source", source: "source/node-agent-coordinator/main.ts" },
  { runtime: "host", path: "dist/host/host-main.cjs", mode: "clean-source", source: "source/host/main.ts" },
  { runtime: "host-agent-store-worker", path: "dist/host/agent-isolation/agent-store-worker.cjs", mode: "clean-source", source: "source/host/agent-isolation/agent-store-worker.ts" },
  { runtime: "host-transcript-mirror-worker", path: "dist/host/agent-isolation/transcript-mirror-worker.cjs", mode: "clean-source", source: "source/host/agent-isolation/transcript-mirror-worker.ts" },
  { runtime: "host-box-store-vacuum-worker", path: "dist/host/extensions/box-store-sync/box-store-vacuum-worker.cjs", mode: "clean-source", source: "source/host/extensions/box-store-sync/box-store-vacuum-worker.ts" },
  { runtime: "host-search-index-worker", path: "dist/host/extensions/content-search/search-index-worker.cjs", mode: "clean-source", source: "source/host/extensions/content-search/search-index-worker.ts" },
  { runtime: "box-exec-daemon", path: "dist/box-exec-daemon/main.cjs", mode: "clean-source", source: "source/box-exec-daemon/main.ts", entrypoint: "source/box-exec-daemon/cli.ts" },
  { runtime: "local-exec-daemon", path: "dist/local-exec-daemon/main.cjs", mode: "clean-source", source: "source/local-exec-daemon/main.ts" },
  { runtime: "renderer", path: "dist/renderer", mode: "clean-source", source: rendererProductionEntrypoint, entrypoint: rendererProductionEntrypoint, provenance: rendererProductionProvenance },
  { runtime: "electron-runtime-dependencies", path: "dist/deps", mode: "generated-runtime", reason: "Public native addons (better-sqlite3, tree-sitter, tree-sitter-bash) are rebuilt against Electron 42.1.0 (ABI 146) headers and staged as dist/deps; whichlang-node and @anysphere/tree-chunk-napi are copied from the 0.18 unpacked tree only when a production esbuild metafile mentions them; cursor-proclist is omitted and process scan no-ops." },
  { runtime: "electron-runtime-resolution-closure", path: "dist/deps/node_modules", mode: "generated-runtime", provenance: "dist/deps/runtime-deps-manifest.json", reason: "Byte-exact copies of rebuilt sibling packages provide standard Node package resolution for Electron utility-process native dependencies." },
  { runtime: "node-runtime-dependencies", path: "dist/node-deps", mode: "generated-runtime", reason: "Native parser packages are rebuilt for the local-exec daemon Node ABI at clean-build time; binaries are never source-controlled." },
  { runtime: "native-runtime-tools", path: "dist/native", mode: "system-runtime", reason: "1Password uses the system op CLI; WebAuthn stays fail-closed without a signer we own. Anysphere Mach-Os from 0.18 are not copied." },
  { runtime: "electron-shell", path: "Contents/Frameworks/Electron Framework.framework", mode: "artifact-runtime", reason: "The macOS package wraps npm Electron 42.1.0 (ABI-matched to the 0.18 runtime); the official 0.18 shell is diagnostic-only." },
]);

export const fidelityRuntimeComposition = Object.freeze(runtimeComposition.map(runtime => (
  runtime.runtime === "renderer" ? Object.freeze({
    runtime: "renderer",
    path: "dist/renderer",
    mode: "checksum-pinned-artifact-runtime",
    artifactRoot: "src/app/dist/renderer",
    provenance: rendererArtifactProvenance,
    reason: "The exact shipped 0.18 Mac renderer bundle is preserved byte-for-byte and accepted only against its complete embedded SHA-256 inventory.",
  }) : runtime
)));

function nodeBuildOptions(outfile) {
  return {
    absWorkingDir: repoRoot,
    bundle: true,
    define: { "import.meta.url": "__cleanImportMetaUrl" },
    external: ["electron"],
    format: "cjs",
    legalComments: "none",
    logLevel: "silent",
    minify: false,
    outfile,
    platform: "node",
    sourcemap: false,
    target: "node22",
  };
}

function nodeBanner(label) {
  return `const __cleanImportMetaUrl = require("node:url").pathToFileURL(__filename + ".bundled").href;\n// ${label}`;
}

async function bundleSource(entry, outfile) {
  await mkdir(path.dirname(outfile), { recursive: true });
  await esbuild({
    ...nodeBuildOptions(outfile),
    entryPoints: [path.join(repoRoot, entry)],
    banner: { js: nodeBanner(`Deterministic clean-source bundle: ${entry}`) },
  });
}

async function bundlePreloadSource(entry, outfile) {
  await mkdir(path.dirname(outfile), { recursive: true });
  await esbuild({
    ...nodeBuildOptions(outfile),
    define: {},
    entryPoints: [path.join(repoRoot, entry)],
    banner: { js: `// Deterministic clean-source preload bundle: ${entry}` },
  });
}

/**
 * The Collections page is loaded from file://, where ES module imports are
 * blocked by Chromium's opaque file origin, so the shared renderer ships as a
 * classic script that publishes one global. Static assets are copied verbatim.
 */
async function stageCollectionsPage(outputRoot) {
  const pageDir = path.join(outputRoot, collectionsPageOutputDir);
  await mkdir(pageDir, { recursive: true });
  await esbuild({
    absWorkingDir: repoRoot,
    banner: { js: "// Deterministic clean-source collections page bundle: source/shared/collections/collection-render.ts" },
    bundle: true,
    entryPoints: [path.join(repoRoot, "source/shared/collections/collection-render.ts")],
    format: "iife",
    globalName: "SandCollectionRender",
    legalComments: "none",
    logLevel: "silent",
    minify: false,
    outfile: path.join(pageDir, "collection-render.js"),
    platform: "browser",
    sourcemap: false,
    target: "chrome126",
  });
  for (const asset of collectionsPageStaticAssets) {
    await cp(path.join(repoRoot, collectionsPageSourceDir, asset), path.join(pageDir, asset), { preserveTimestamps: true });
  }
}

async function bundleVirtual(name, contents, outfile) {
  await mkdir(path.dirname(outfile), { recursive: true });
  await esbuild({
    ...nodeBuildOptions(outfile),
    stdin: { contents, loader: "ts", resolveDir: repoRoot, sourcefile: `scripts/build-entry/${name}.ts` },
    banner: { js: nodeBanner(`Deterministic clean-source runtime adapter: ${name}`) },
  });
}

const coordinatorEntry = `
import { composeCoordinator } from "./source/node-agent-coordinator/main.ts";

void composeCoordinator().catch((error) => {
  process.stderr.write(\`node-agent-coordinator: composition failure: \${String(error)}\\n\`);
  process.exit(1);
});
`;

const localExecDaemonEntry = `
import { runLocalExecDaemonEntrypoint } from "./source/local-exec-daemon/main.ts";

void runLocalExecDaemonEntrypoint();
`;

async function walkFiles(root, current = root) {
  const found = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) found.push(...await walkFiles(root, target));
    else if (entry.isFile()) found.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return found.sort();
}

async function sha256(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

export async function createRendererArtifactProvenance({
  artifactRoot = path.join(repoRoot, "src", "app", "dist", "renderer"),
} = {}) {
  const relativeRoot = path.relative(repoRoot, artifactRoot).split(path.sep).join("/");
  if (relativeRoot.startsWith("../") || path.isAbsolute(relativeRoot)) {
    throw new Error(`Renderer artifact root must be inside the repository: ${artifactRoot}`);
  }
  const files = [];
  for (const relative of await walkFiles(artifactRoot)) {
    const target = path.join(artifactRoot, relative);
    files.push({ path: relative, bytes: (await stat(target)).size, sha256: await sha256(target) });
  }
  if (files.length === 0 || !files.some(file => file.path === "index.html")) {
    throw new Error(`Shipped renderer inventory is incomplete at ${artifactRoot}`);
  }
  const inventorySha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return {
    schemaVersion: 1,
    upstreamVersion: "0.18.0",
    upstreamAppAsarSha256: officialMacReleaseAsarHash,
    mode: "checksum-pinned-artifact-runtime",
    artifactRoot: relativeRoot,
    hashAlgorithm: "sha256",
    fileCount: files.length,
    inventorySha256,
    files,
  };
}

export function packagedArtifactFallbacks(composition = runtimeComposition) {
  return composition
    .filter(({ mode, sourceBundle }) => mode === "artifact-fallback" && typeof sourceBundle === "string")
    .map(({ sourceBundle }) => sourceBundle);
}

async function buildRuntimeDistribution({ outputRoot, composition, rendererMode }) {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await bundleSource("source/electron-dev-controls/main.ts", path.join(outputRoot, "dist/electron-dev-controls/main.cjs"));
  await bundlePreloadSource("source/electron-preload/runtime/primary.ts", path.join(outputRoot, "dist/electron-preload/preload.cjs"));
  await bundlePreloadSource("source/electron-preload/runtime/dev-controls.ts", path.join(outputRoot, "dist/electron-preload/preload-dev-controls.cjs"));
  await bundlePreloadSource("source/electron-preload/runtime/webview.ts", path.join(outputRoot, "dist/electron-preload/preload-webview.cjs"));
  await bundlePreloadSource("source/electron-preload/runtime/vnc.ts", path.join(outputRoot, "dist/electron-preload/preload-vnc.cjs"));
  await bundlePreloadSource("source/electron-preload/runtime/collections.ts", path.join(outputRoot, "dist/electron-preload/preload-collections.cjs"));
  await stageCollectionsPage(outputRoot);
  await bundleSource("source/host/agent-isolation/agent-store-worker.ts", path.join(outputRoot, "dist/host/agent-isolation/agent-store-worker.cjs"));
  await bundleSource("source/host/agent-isolation/transcript-mirror-worker.ts", path.join(outputRoot, "dist/host/agent-isolation/transcript-mirror-worker.cjs"));
  await bundleSource("source/host/extensions/box-store-sync/box-store-vacuum-worker.ts", path.join(outputRoot, "dist/host/extensions/box-store-sync/box-store-vacuum-worker.cjs"));
  await bundleSource("source/host/extensions/content-search/search-index-worker.ts", path.join(outputRoot, "dist/host/extensions/content-search/search-index-worker.cjs"));
  await run(process.execPath, [
    path.join(repoRoot, "scripts/build-box-exec-daemon.mjs"),
    path.join(outputRoot, "dist/box-exec-daemon/main.cjs"),
  ], { cwd: repoRoot });
  await bundleVirtual("local-exec-daemon", localExecDaemonEntry, path.join(outputRoot, "dist/local-exec-daemon/main.cjs"));
  await stageNodeTreeSitterRuntime(outputRoot);
  await bundleVirtual("node-agent-coordinator", coordinatorEntry, path.join(outputRoot, "dist/node-agent-coordinator/main.cjs"));
  let renderer;
  if (rendererMode === "clean-source") {
    renderer = await buildProductionRenderer({ outputRoot });
  } else if (rendererMode === "checksum-pinned-artifact-runtime") {
    renderer = await createRendererArtifactProvenance();
    const provenancePath = path.join(outputRoot, rendererArtifactProvenance);
    await mkdir(path.dirname(provenancePath), { recursive: true });
    await writeFile(provenancePath, `${JSON.stringify(renderer, null, 2)}\n`);
  } else {
    throw new Error(`Unsupported renderer runtime mode: ${rendererMode}`);
  }

  const files = await walkFiles(outputRoot);
  const outputs = [];
  for (const name of files) outputs.push({ path: name, bytes: (await stat(path.join(outputRoot, name))).size, sha256: await sha256(path.join(outputRoot, name)) });
  const buildManifest = {
    schemaVersion: 1,
    upstreamVersion: "0.18.0",
    buildKind: rendererMode === "clean-source" ? "source-aware-reconstruction" : "fidelity-hybrid-reconstruction",
    deterministicInputs: [
      "source",
      ...(rendererMode === "clean-source" ? [
        "frontend/src",
        "frontend/manifests/renderer-bootstrap.json",
        "frontend/manifests/renderer-runtime-assets.json",
        "frontend/manifests/ui-evidence-anchors.json",
        "manifests/reconstruction/renderer-closure.json",
      ] : ["src/app/dist/renderer"]),
    ],
    runtimeComposition: composition,
    outputs,
  };
  const manifestPath = path.join(outputRoot, "dist", "reconstruction-build.json");
  await writeFile(manifestPath, `${JSON.stringify(buildManifest, null, 2)}\n`);
  return { outputRoot, manifestPath, buildManifest, renderer };
}

export async function buildCleanDistribution({ outputRoot = cleanBuildDir } = {}) {
  return buildRuntimeDistribution({ outputRoot, composition: runtimeComposition, rendererMode: "clean-source" });
}

export async function buildFidelityDistribution({ outputRoot = fidelityCleanBuildDir } = {}) {
  return buildRuntimeDistribution({ outputRoot, composition: fidelityRuntimeComposition, rendererMode: "checksum-pinned-artifact-runtime" });
}

export async function overlayCleanDistribution(outputRoot, { stageRoot = stagedAppDir, composition = runtimeComposition } = {}) {
  const rendererMode = composition.find(runtime => runtime.runtime === "renderer")?.mode;
  for (const relative of executableReplacements.filter(relative => relative !== "dist/renderer" || rendererMode === "clean-source")) {
    const destination = path.join(stageRoot, relative);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(outputRoot, relative), destination, { recursive: true, dereference: false, preserveTimestamps: true });
  }
  for (const relative of [...packagedArtifactFallbacks(composition), "dist/node-deps", "dist/reconstruction-build.json"]) {
    const destination = path.join(stageRoot, relative);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(outputRoot, relative), destination, { recursive: true, dereference: false, preserveTimestamps: true });
  }
  if (rendererMode === "checksum-pinned-artifact-runtime") {
    const destination = path.join(stageRoot, rendererArtifactProvenance);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(outputRoot, rendererArtifactProvenance), destination, { preserveTimestamps: true });
  }
}

export async function buildReconstructedAsar({ pack = false } = {}) {
  if (pack) {
    throw new Error("lib buildReconstructedAsar refuses pack:true; 0.18 electron-main/host would ship without production activation. Use scripts/clean-build.mjs.");
  }
  const fallback = await buildAsar({ pack: false });
  const clean = await buildCleanDistribution();
  await overlayCleanDistribution(clean.outputRoot);
  console.log("Executable clean replacements: renderer, coordinator, box exec-daemon, local-exec daemon, primary/dev-controls/webview/VNC preloads, and four host workers.");
  return { ...fallback, ...clean };
}
