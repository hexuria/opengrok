import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

  await rm(path.join(stageRoot, "dist", "native"), { recursive: true, force: true });

  const depsRoot = await ensureElectronNativeDeps();
  await stageElectronNativeDeps(stageRoot, depsRoot);
  await stageElectronRuntimeDependencyResolution(path.join(stageRoot, "dist", "deps"));

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
