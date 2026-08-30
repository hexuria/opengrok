import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { repoRoot } from "./lib/config.mjs";

const packages = ["tree-sitter", "tree-sitter-bash"];
const dependencies = ["node-addon-api", "node-gyp-build"];

function nodeRuntimeCacheRoot() {
  return path.join(repoRoot, ".cache", "tree-sitter-node", process.versions.modules, `${process.platform}-${process.arch}`);
}

function runNodeGyp(target) {
  const command = process.platform === "win32"
    ? path.join(repoRoot, "node_modules", ".bin", "node-gyp.cmd")
    : path.join(repoRoot, "node_modules", ".bin", "node-gyp");
  const environment = { ...process.env };
  for (const key of ["npm_config_runtime", "npm_config_target", "npm_config_disturl", "npm_config_nodedir"]) delete environment[key];
  environment.npm_config_build_from_source = "true";
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["rebuild", "--directory", target, "--release"], {
      cwd: repoRoot,
      env: environment,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`node-gyp exited with ${code} for ${path.basename(target)}`)));
  });
}

async function hasNodeRuntimeBinaries(root) {
  for (const relative of [
    "tree-sitter/build/Release/tree_sitter_runtime_binding.node",
    "tree-sitter-bash/build/Release/tree_sitter_bash_binding.node",
  ]) {
    try { await readFile(path.join(root, relative)); }
    catch { return false; }
  }
  return true;
}

export async function ensureNodeTreeSitterRuntime() {
  const cacheRoot = nodeRuntimeCacheRoot();
  if (await hasNodeRuntimeBinaries(cacheRoot)) return cacheRoot;

  const temporaryRoot = await mkdtemp(path.join(repoRoot, ".tmp-tree-sitter-node-"));
  try {
    const packageRoot = path.join(temporaryRoot, "node_modules");
    await mkdir(packageRoot, { recursive: true });
    for (const packageName of [...packages, ...dependencies]) {
      await cp(
        path.join(repoRoot, "node_modules", packageName),
        path.join(packageRoot, packageName),
        { recursive: true, dereference: true },
      );
    }
    for (const packageName of packages) await runNodeGyp(path.join(packageRoot, packageName));
    await rm(cacheRoot, { recursive: true, force: true });
    await mkdir(path.dirname(cacheRoot), { recursive: true });
    await cp(packageRoot, cacheRoot, { recursive: true, dereference: true });
    return cacheRoot;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function stageNodeTreeSitterRuntime(outputRoot) {
  const cacheRoot = await ensureNodeTreeSitterRuntime();
  const destination = path.join(outputRoot, "dist", "node-deps");
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(cacheRoot, destination, { recursive: true, dereference: true });
  const runtimeNodeModules = path.join(destination, "node_modules");
  await mkdir(runtimeNodeModules, { recursive: true });
  for (const packageName of dependencies) {
    await cp(path.join(cacheRoot, packageName), path.join(runtimeNodeModules, packageName), { recursive: true, dereference: true });
  }
  return destination;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify({ node: process.version, modules: process.versions.modules, output: await ensureNodeTreeSitterRuntime() }, null, 2));
}
