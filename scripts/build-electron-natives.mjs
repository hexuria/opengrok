import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { cacheDir, repoRoot } from "./lib/config.mjs";

export const electronVersion = "42.1.0";
export const electronAbi = "146";
export const electronNodeVersion = "24.15.0";
export const electronHeadersUrl = `https://artifacts.electronjs.org/headers/dist/v${electronVersion}/node-v${electronVersion}-headers.tar.gz`;

export const electronNativePackages = Object.freeze(["better-sqlite3", "tree-sitter", "tree-sitter-bash"]);
export const electronNativeJsDependencies = Object.freeze(["bindings", "file-uri-to-path", "node-addon-api", "node-gyp-build"]);
// 0.18 copies; staged only when a production esbuild metafile mentions them.
export const retainedElectronNativePackages = Object.freeze([
  "@anysphere/tree-chunk-napi",
  "whichlang-node",
  "whichlang-node-darwin-arm64",
]);
export const omittedElectronNativePackages = Object.freeze(["cursor-proclist"]);
export const electronNativeNodeFiles = Object.freeze([
  "better-sqlite3/build/Release/better_sqlite3.node",
  "tree-sitter/build/Release/tree_sitter_runtime_binding.node",
  "tree-sitter-bash/build/Release/tree_sitter_bash_binding.node",
]);
export const retainedElectronNativeNodeFiles = Object.freeze([
  "@anysphere/tree-chunk-napi/tree-chunk-napi.darwin-arm64.node",
  "whichlang-node-darwin-arm64/whichlang-node.darwin-arm64.node",
]);

export function retainedElectronNativePackagesFromMetafile(metafile) {
  const text = typeof metafile === "string" ? metafile : JSON.stringify(metafile ?? {});
  return retainedElectronNativePackages.filter(name => (
    name.includes("tree-chunk-napi") ? text.includes("tree-chunk-napi")
      : name.includes("whichlang") ? text.includes("whichlang")
        : text.includes(name)
  ));
}

export function retainedElectronNativeNodeFilesFor(packages) {
  const selected = new Set(packages);
  return retainedElectronNativeNodeFiles.filter(relative => selected.has(relativeNativePackageName(relative)));
}

const forbiddenElectronNativeNames = Object.freeze(["cursor-proclist"]);

function readRootPackageJson() {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
}

export function electronNativeRebuildIdentity(pkg = readRootPackageJson()) {
  return {
    electron: electronVersion,
    abi: electronAbi,
    node: electronNodeVersion,
    "better-sqlite3": pkg.optionalDependencies?.["better-sqlite3"] ?? pkg.dependencies?.["better-sqlite3"] ?? null,
    "tree-sitter": pkg.dependencies?.["tree-sitter"] ?? null,
    "tree-sitter-bash": pkg.dependencies?.["tree-sitter-bash"] ?? null,
    "node-addon-api": pkg.devDependencies?.["node-addon-api"] ?? null,
    "node-gyp-build": pkg.devDependencies?.["node-gyp-build"] ?? null,
  };
}

export function electronNativeIdentityKey(identity = electronNativeRebuildIdentity()) {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
}

export function electronNativeDepsRoot() {
  return path.join(cacheDir, "electron-deps", electronAbi, electronNativeIdentityKey(), `${process.platform}-${process.arch}`);
}

export function rebuiltElectronCopiedPackages() {
  return [...electronNativePackages, ...electronNativeJsDependencies].sort();
}

function relativeNativePackageName(relative) {
  if (relative.startsWith("@")) return relative.split("/").slice(0, 2).join("/");
  return relative.split("/")[0];
}

export function packagedElectronRuntimePackages({ retained = [] } = {}) {
  const nodeFiles = [...electronNativeNodeFiles, ...retainedElectronNativeNodeFilesFor(retained)];
  return {
    copied: new Set([...electronNativePackages, ...electronNativeJsDependencies, ...retained]),
    native: new Set(nodeFiles.map(relativeNativePackageName)),
  };
}

export function createElectronRuntimeDepsManifest({
  platform = process.platform,
  arch = process.arch,
  identity = electronNativeRebuildIdentity(),
} = {}) {
  return {
    platform,
    arch,
    rebuildIdentity: identity,
    required: [...electronNativePackages],
    copied: rebuiltElectronCopiedPackages(),
    nodeFiles: [...electronNativeNodeFiles],
  };
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(repoRoot, relative), "utf8"));
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function hasPackageJson(target) {
  try {
    await readFile(path.join(target, "package.json"));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function resolveInstalledPackage(name) {
  const candidates = [
    path.join(repoRoot, "node_modules", name),
    path.join(repoRoot, "node_modules", "better-sqlite3", "node_modules", name),
    path.join(repoRoot, "node_modules", "bindings", "node_modules", name),
  ];
  for (const candidate of candidates) {
    if (await hasPackageJson(candidate)) return candidate;
  }
  throw new Error(`Missing ${name} in node_modules; run npm ci`);
}

function mentionsForbiddenNative(value) {
  if (typeof value !== "string") return false;
  return forbiddenElectronNativeNames.some(name => value === name || value.startsWith(`${name}/`) || value.includes(`/${name}/`) || value.endsWith(`/${name}`));
}

function packageDirectory(root, packageName) {
  return path.join(root, ...packageName.split("/"));
}

export async function assertElectronNativeDeps(depsRoot) {
  if (typeof depsRoot !== "string" || depsRoot.length === 0) throw new TypeError("An explicit Electron depsRoot is required");
  const manifestPath = path.join(depsRoot, "runtime-deps-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const expectedCopied = rebuiltElectronCopiedPackages();
  if (JSON.stringify(manifest.required) !== JSON.stringify([...electronNativePackages])) {
    throw new Error("Rebuilt Electron deps required packages drifted");
  }
  if (JSON.stringify(manifest.copied ?? []) !== JSON.stringify(expectedCopied)) {
    throw new Error("Rebuilt Electron deps copied packages drifted");
  }
  if (JSON.stringify(manifest.nodeFiles) !== JSON.stringify([...electronNativeNodeFiles])) {
    throw new Error("Rebuilt Electron deps nodeFiles drifted");
  }
  if (JSON.stringify(manifest.rebuildIdentity) !== JSON.stringify(electronNativeRebuildIdentity())) {
    throw new Error("Rebuilt Electron deps identity drifted");
  }
  const listed = [...(manifest.required ?? []), ...(manifest.copied ?? []), ...(manifest.nodeFiles ?? [])];
  for (const entry of listed) {
    if (mentionsForbiddenNative(entry)) throw new Error(`Rebuilt Electron deps must not include ${entry}`);
  }
  for (const relative of electronNativeNodeFiles) {
    const target = path.join(depsRoot, relative);
    if (!(await exists(target)) || !(await stat(target)).isFile()) {
      throw new Error(`Rebuilt Electron native is missing ${relative} at ${depsRoot}`);
    }
  }
  for (const name of expectedCopied) {
    if (!(await hasPackageJson(packageDirectory(depsRoot, name)))) {
      throw new Error(`Rebuilt Electron deps are missing JS package ${name}`);
    }
  }
  for (const name of forbiddenElectronNativeNames) {
    if (await exists(packageDirectory(depsRoot, name))) {
      throw new Error(`Rebuilt Electron deps must not include ${name}`);
    }
  }
  return manifest;
}

export async function stageElectronNativeDeps(stageRoot, depsRoot = electronNativeDepsRoot()) {
  if (typeof stageRoot !== "string" || stageRoot.length === 0) throw new TypeError("An explicit stageRoot is required");
  if (typeof depsRoot !== "string" || depsRoot.length === 0) throw new TypeError("An explicit Electron depsRoot is required");
  await assertElectronNativeDeps(depsRoot);
  const destination = path.join(stageRoot, "dist", "deps");
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(depsRoot, destination, { recursive: true, dereference: false, preserveTimestamps: true });
  return destination;
}

export async function stageRetainedElectronNatives(depsRoot, unpackedDepsRoot, { packages = [] } = {}) {
  if (typeof depsRoot !== "string" || depsRoot.length === 0) throw new TypeError("An explicit Electron depsRoot is required");
  const unknown = packages.filter(name => !retainedElectronNativePackages.includes(name));
  if (unknown.length > 0) throw new Error(`Unknown retained native package: ${unknown.join(", ")}`);
  const selected = retainedElectronNativePackages.filter(name => packages.includes(name));
  const selectedNodeFiles = retainedElectronNativeNodeFilesFor(selected);
  if (selected.length > 0) {
    if (typeof unpackedDepsRoot !== "string" || unpackedDepsRoot.length === 0) {
      throw new TypeError("An explicit 0.18 unpacked depsRoot is required");
    }
    for (const packageName of selected) {
      const source = packageDirectory(unpackedDepsRoot, packageName);
      const destination = packageDirectory(depsRoot, packageName);
      if (!(await hasPackageJson(source))) {
        throw new Error(`0.18 unpacked deps are missing retained native ${packageName} at ${source}`);
      }
      await rm(destination, { recursive: true, force: true });
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
    }
    for (const relative of selectedNodeFiles) {
      const target = path.join(depsRoot, relative);
      if (!(await exists(target)) || !(await stat(target)).isFile()) {
        throw new Error(`Retained Electron native is missing ${relative}`);
      }
    }
  }
  await rm(packageDirectory(depsRoot, "cursor-proclist"), { recursive: true, force: true });
  const manifestPath = path.join(depsRoot, "runtime-deps-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.copied = [...new Set([...(manifest.copied ?? []).filter(name => !retainedElectronNativePackages.includes(name)), ...selected])].sort();
  manifest.nodeFiles = [...electronNativeNodeFiles, ...selectedNodeFiles];
  manifest.retained = {
    source: "esbuild-metafile",
    packages: selected,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function hasElectronNativeBinaries(root) {
  try {
    await assertElectronNativeDeps(root);
    return true;
  } catch {
    return false;
  }
}

function requireElectronHeaders(env = process.env) {
  const headersDir = env.ELECTRON_HEADERS_DIR;
  if (!headersDir) {
    throw new Error(`ELECTRON_HEADERS_DIR is required; obtain the official Electron ${electronVersion} headers from ${electronHeadersUrl}`);
  }
  return headersDir;
}

async function validateElectronHeaders(headersDir) {
  const headerVersion = await readFile(path.join(headersDir, "node_version.h"), "utf8").catch(async () => (
    readFile(path.join(headersDir, "include", "node", "node_version.h"), "utf8")
  ));
  if (!new RegExp(`#define NODE_MODULE_VERSION ${electronAbi}\\b`).test(headerVersion)) {
    throw new Error(`Electron headers at ${headersDir} do not declare NODE_MODULE_VERSION ${electronAbi}`);
  }
  if (!headerVersion.includes("#define NODE_MAJOR_VERSION 24") || !headerVersion.includes("#define NODE_MINOR_VERSION 15")) {
    throw new Error(`Electron ${electronVersion} headers at ${headersDir} are not the retained Node ${electronNodeVersion} headers`);
  }
}

async function validateRebuildIdentity() {
  const packageJson = await readJson("package.json");
  const identity = electronNativeRebuildIdentity(packageJson);
  if (packageJson.devDependencies?.electron !== electronVersion) throw new Error("package.json Electron target drifted");
  if (identity["better-sqlite3"] !== "12.6.2") {
    throw new Error("better-sqlite3@12.6.2 must remain the Electron native rebuild identity");
  }
  if (identity["node-addon-api"] !== "8.5.0" || packageJson.overrides?.["node-addon-api"] !== "8.5.0") {
    throw new Error("node-addon-api@8.5.0 must remain both the direct build identity and the global override");
  }
}

function electronGypEnv(env) {
  return {
    ...env,
    npm_config_runtime: "electron",
    npm_config_target: electronVersion,
    npm_config_disturl: "https://artifacts.electronjs.org/headers/dist",
    npm_config_build_from_source: "true",
  };
}

function nodeGypCommand() {
  return process.platform === "win32"
    ? path.join(repoRoot, "node_modules", ".bin", "node-gyp.cmd")
    : path.join(repoRoot, "node_modules", ".bin", "node-gyp");
}

export async function rebuildElectronNativeDeps({ env = process.env } = {}) {
  const headersDir = requireElectronHeaders(env);
  await validateElectronHeaders(headersDir);
  await validateRebuildIdentity();

  const gypEnv = electronGypEnv(env);
  const gyp = nodeGypCommand();
  const cacheRoot = electronNativeDepsRoot();
  const temporaryRoot = await mkdtemp(path.join(repoRoot, ".tmp-electron-deps-"));
  try {
    const packageRoot = path.join(temporaryRoot, "node_modules");
    await mkdir(packageRoot, { recursive: true });
    for (const packageName of [...electronNativePackages, ...electronNativeJsDependencies]) {
      await cp(
        await resolveInstalledPackage(packageName),
        path.join(packageRoot, packageName),
        { recursive: true, dereference: true },
      );
    }
    for (const packageName of electronNativePackages) {
      const packageDirectoryPath = path.join(packageRoot, packageName);
      await rm(path.join(packageDirectoryPath, "prebuilds"), { recursive: true, force: true });
      await run(gyp, ["rebuild", "--directory", packageDirectoryPath, "--release", "--nodedir", headersDir, "--jobs", "max"], gypEnv);
    }
    await writeFile(
      path.join(packageRoot, "runtime-deps-manifest.json"),
      `${JSON.stringify(createElectronRuntimeDepsManifest(), null, 2)}\n`,
    );
    await assertElectronNativeDeps(packageRoot);
    await rm(cacheRoot, { recursive: true, force: true });
    await mkdir(path.dirname(cacheRoot), { recursive: true });
    await cp(packageRoot, cacheRoot, { recursive: true, dereference: true });
    return cacheRoot;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function ensureElectronNativeDeps() {
  const cacheRoot = electronNativeDepsRoot();
  if (await hasElectronNativeBinaries(cacheRoot)) return cacheRoot;
  return rebuildElectronNativeDeps();
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await rebuildElectronNativeDeps();
  console.log(JSON.stringify({
    electron: electronVersion,
    node: electronNodeVersion,
    modules: Number(electronAbi),
    identity: electronNativeRebuildIdentity(),
    headers: process.env.ELECTRON_HEADERS_DIR ?? null,
    packages: [...electronNativePackages],
    retainedCandidates: [...retainedElectronNativePackages],
    omitted: [...omittedElectronNativePackages],
    output,
    platform: process.platform,
    arch: process.arch,
  }, null, 2));
}
