import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildDir,
  builtAsar,
  builtAsarUnpacked,
  repoRoot,
  sourceAppDir,
  stagedAppDir
} from "./config.mjs";
import { packStagedAppWithIntegrity } from "./asar-integrity.mjs";
import { resolveRuntimeApp } from "./runtime.mjs";
import { ensureElectronNativeDeps, stageElectronNativeDeps } from "../build-electron-natives.mjs";

export const reconstructedUpdaterGuard = [
  "// Reconstructed-build guard: do not consume official update or telemetry services.",
  "process.env.SAND_DISABLE_UPDATES ??= \"1\";",
  "process.env.SAND_DISABLE_SENTRY ??= \"1\";",
  "process.env.SAND_DISABLE_TELEMETRY ??= \"1\";",
  ""
].join("\n");

export function applyReconstructedUpdaterGuard(source) {
  if (typeof source !== "string") throw new TypeError("Electron-main source must be a string");
  return source.startsWith(reconstructedUpdaterGuard) ? source : `${reconstructedUpdaterGuard}${source}`;
}

// The prebuilt tree-sitter runtime entries evaluate only node-gyp-build. The
// other declared packages are install/build-time or alternate-runtime edges,
// so duplicating them would change the shipped runtime inventory needlessly.
const electronRuntimeResolutionPackages = Object.freeze(["node-gyp-build"]);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function directoryInventory(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await directoryInventory(root, target));
    else if (entry.isFile()) {
      const bytes = await readFile(target);
      files.push({ path: path.relative(root, target).split(path.sep).join("/"), bytes: bytes.byteLength, sha256: sha256(bytes) });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function stageElectronRuntimeDependencyResolution(depsRoot) {
  if (typeof depsRoot !== "string" || depsRoot.length === 0) throw new TypeError("An explicit Electron depsRoot is required");
  const packages = [];
  for (const packageName of electronRuntimeResolutionPackages) {
    const source = path.join(depsRoot, packageName);
    const destination = path.join(depsRoot, "node_modules", packageName);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
    const [sourceFiles, destinationFiles] = await Promise.all([directoryInventory(source), directoryInventory(destination)]);
    if (JSON.stringify(sourceFiles) !== JSON.stringify(destinationFiles)) throw new Error(`Electron runtime resolution copy drifted for ${packageName}`);
    packages.push({
      name: packageName,
      source: packageName,
      destination: `node_modules/${packageName}`,
      fileCount: sourceFiles.length,
      inventorySha256: sha256(JSON.stringify(sourceFiles)),
    });
  }
  const manifestPath = path.join(depsRoot, "runtime-deps-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.resolutionClosure = {
    mode: "byte-exact-sibling-package-copy",
    packages,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.resolutionClosure;
}

function enableReconstructedDevSeams(source) {
  const replacements = [
    {
      from: "var devToolsGate = createDevToolsGate({ isDevBuild: !import_electron51.app.isPackaged });",
      to: "var devToolsGate = createDevToolsGate({ isDevBuild: process.env.GROK_BOT_RECONSTRUCTED_DEV === \"1\" || !import_electron51.app.isPackaged });"
    },
    {
      from: "registerDevWiring({\n    ipcMain: import_electron51.ipcMain,\n    isPackaged: import_electron51.app.isPackaged,",
      to: "registerDevWiring({\n    ipcMain: import_electron51.ipcMain,\n    isPackaged: process.env.GROK_BOT_RECONSTRUCTED_DEV === \"1\" ? false : import_electron51.app.isPackaged,"
    }
  ];

  let patched = source;
  for (const { from, to } of replacements) {
    if (!patched.includes(from)) {
      throw new Error(`Cannot enable reconstructed dev seam; upstream anchor changed: ${from}`);
    }
    patched = patched.replace(from, to);
  }
  return patched;
}

function enableReconstructedRuntimeSeams(source) {
  const replacements = [
    {
      from: "var isSandLabBuild2 = appPackageJson.sandLab === true;",
      to: "var isSandLabBuild2 = appPackageJson.sandLab === true || process.env.GROK_BOT_RECONSTRUCTED_DEV === \"1\";"
    },
    {
      from: "var isPrimaryInstance = !import_electron51.app.isPackaged || import_electron51.app.requestSingleInstanceLock();",
      to: "var isPrimaryInstance = process.env.GROK_BOT_RECONSTRUCTED_DEV === \"1\" || !import_electron51.app.isPackaged || import_electron51.app.requestSingleInstanceLock();"
    }
  ];
  let patched = source;
  for (const { from, to } of replacements) {
    if (!patched.includes(from)) {
      throw new Error(`Cannot enable reconstructed runtime seam; upstream anchor changed: ${from}`);
    }
    patched = patched.replace(from, to);
  }
  return patched;
}

/**
 * The artifact Electron main is a blocked fallback, but the reconstructed app
 * still has to disable the official updater and isolate its app instance. Keep
 * that packaging-only transform deterministic so verification can prove the
 * staged fallback came from the exact immutable bytes plus these explicit
 * safety seams.
 */
export function prepareReconstructedElectronMainArtifactFallback(source, { dev = false } = {}) {
  if (typeof source !== "string") throw new TypeError("Electron-main artifact fallback must be a string");
  let prepared = enableReconstructedRuntimeSeams(source);
  if (dev) prepared = enableReconstructedDevSeams(prepared);
  return applyReconstructedUpdaterGuard(prepared);
}

export async function buildAsar({
  pack = true,
  buildRoot = buildDir,
  stageRoot = stagedAppDir,
  archivePath = builtAsar,
  unpackedRoot = builtAsarUnpacked,
} = {}) {
  const runtimeApp = await resolveRuntimeApp();
  const resources = path.join(runtimeApp, "Contents", "Resources");
  const runtimeUnpacked = path.join(resources, "app.asar.unpacked", "dist");

  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  await cp(sourceAppDir, stageRoot, { recursive: true, dereference: false, preserveTimestamps: true });

  if (process.env.GROK_BOT_BUILD_DEV_APP === "1") {
    const stagedPackagePath = path.join(stageRoot, "package.json");
    const stagedPackage = JSON.parse(await readFile(stagedPackagePath, "utf8"));
    stagedPackage.sandLab = true;
    stagedPackage.productName = "Grok Bot 0.18 Dev";
    await writeFile(stagedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`);
  }

  const nativeSource = path.join(runtimeUnpacked, "native");
  const nativeDestination = path.join(stageRoot, "dist", "native");
  await rm(nativeDestination, { recursive: true, force: true });
  await cp(nativeSource, nativeDestination, { recursive: true, dereference: false, preserveTimestamps: true });

  const depsRoot = await ensureElectronNativeDeps();
  await stageElectronNativeDeps(stageRoot, depsRoot);
  await stageElectronRuntimeDependencyResolution(path.join(stageRoot, "dist", "deps"));

  const mainBundle = path.join(stageRoot, "dist", "electron-main", "main.cjs");
  let mainSource = await readFile(mainBundle, "utf8");
  const dev = process.env.GROK_BOT_BUILD_DEV_APP === "1";
  mainSource = prepareReconstructedElectronMainArtifactFallback(mainSource, { dev });
  if (dev) console.log("Enabled reconstructed development seams (DevTools + control server).");
  await writeFile(mainBundle, mainSource);

  const rendererOverride = process.env.GROK_BOT_RENDERER_SOURCE?.trim();
  if (rendererOverride) {
    const rendererSource = path.resolve(repoRoot, rendererOverride);
    await readFile(path.join(rendererSource, "index.html"), "utf8");
    const stagedRenderer = path.join(stageRoot, "dist", "renderer");
    await rm(stagedRenderer, { recursive: true, force: true });
    await cp(rendererSource, stagedRenderer, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true
    });
    console.log(`Renderer override: ${rendererSource}`);
  }

  if (pack) {
    await packStagedAppWithIntegrity({ stageRoot, archivePath, unpackedRoot });
    console.log(`ASAR ready: ${archivePath}`);
    console.log(`Unpacked runtime payload: ${unpackedRoot}`);
  } else {
    console.log(`Base ASAR staging ready: ${stageRoot}`);
  }
  return { builtAsar: archivePath, builtAsarUnpacked: unpackedRoot, stagedAppDir: stageRoot, runtimeApp };
}
