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

export async function resolveOpenGrokServerUrl(env = process.env, envFile = path.join(repoRoot, ".env")) {
  const fromEnv = env.OPENGROK_SERVER_URL?.trim();
  if (fromEnv) return validateServerUrl(fromEnv);
  let text;
  try { text = await readFile(envFile, "utf8"); } catch { return null; }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?OPENGROK_SERVER_URL\s*=\s*(.+?)\s*$/.exec(line);
    if (match) return validateServerUrl(match[1].replace(/^["']|["']$/g, ""));
  }
  return null;
}

function validateServerUrl(value) {
  try { new URL(value); } catch { throw new Error(`OPENGROK_SERVER_URL is not a valid URL: ${JSON.stringify(value)}. Include the scheme, for example http://192.168.1.10:1447`); }
  return value.replace(/\/+$/, "");
}

export async function buildAsar({
  pack = true,
  buildRoot = buildDir,
  stageRoot = stagedAppDir,
  archivePath = builtAsar,
  unpackedRoot = builtAsarUnpacked,
} = {}) {
  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  await cp(sourceAppDir, stageRoot, { recursive: true, dereference: false, preserveTimestamps: true });

  {
    const stagedPackagePath = path.join(stageRoot, "package.json");
    const stagedPackage = JSON.parse(await readFile(stagedPackagePath, "utf8"));
    let changed = false;
    if (process.env.GROK_BOT_BUILD_DEV_APP === "1") {
      stagedPackage.sandLab = true;
      stagedPackage.productName = "Grok Bot 0.18 Dev";
      changed = true;
    }
    // The OpenGrok server this build signs in to. Configuration, not a field on
    // the sign-in page: OPENGROK_SERVER_URL from the environment, else from a
    // repo-root .env. Production points this at an IP or domain.
    const serverUrl = await resolveOpenGrokServerUrl();
    if (serverUrl != null) {
      stagedPackage.opengrokServerUrl = serverUrl;
      changed = true;
      console.log(`OpenGrok server baked into the build: ${serverUrl}`);
    } else {
      console.log("No OPENGROK_SERVER_URL set; the sign-in page will report the build as unconfigured unless the app is launched with it.");
    }
    if (changed) await writeFile(stagedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`);
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
  return { builtAsar: archivePath, builtAsarUnpacked: unpackedRoot, stagedAppDir: stageRoot };
}
