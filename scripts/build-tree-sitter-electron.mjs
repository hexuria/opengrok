import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronVersion = "42.1.0";
const electronAbi = "146";
const electronNodeVersion = "24.15.0";
const headersUrl = `https://artifacts.electronjs.org/headers/dist/v${electronVersion}/node-v${electronVersion}-headers.tar.gz`;
const packages = ["tree-sitter", "tree-sitter-bash"];

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(repoRoot, relative), "utf8"));
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

const headersDir = process.env.ELECTRON_HEADERS_DIR;
if (!headersDir) {
  throw new Error(`ELECTRON_HEADERS_DIR is required; obtain the official Electron ${electronVersion} headers from ${headersUrl}`);
}

const headerVersion = await readFile(path.join(headersDir, "node_version.h"), "utf8").catch(async () => readFile(path.join(headersDir, "include", "node", "node_version.h"), "utf8"));
if (!new RegExp(`#define NODE_MODULE_VERSION ${electronAbi}\\b`).test(headerVersion)) {
  throw new Error(`Electron headers at ${headersDir} do not declare NODE_MODULE_VERSION ${electronAbi}`);
}
if (!headerVersion.includes("#define NODE_MAJOR_VERSION 24") || !headerVersion.includes("#define NODE_MINOR_VERSION 15")) {
  throw new Error(`Electron ${electronVersion} headers at ${headersDir} are not the retained Node ${electronNodeVersion} headers`);
}

const packageJson = await readJson("package.json");
if (packageJson.devDependencies?.electron !== electronVersion) throw new Error("package.json Electron target drifted");
if (packageJson.devDependencies?.["node-addon-api"] !== "8.5.0" || packageJson.overrides?.["node-addon-api"] !== "8.5.0") {
  throw new Error("node-addon-api@8.5.0 must remain both the direct build identity and the global override");
}

const env = {
  ...process.env,
  npm_config_runtime: "electron",
  npm_config_target: electronVersion,
  npm_config_disturl: "https://artifacts.electronjs.org/headers/dist",
};
const gyp = process.platform === "win32"
  ? path.join(repoRoot, "node_modules/.bin/node-gyp.cmd")
  : path.join(repoRoot, "node_modules/.bin/node-gyp");

for (const packageName of packages) {
  const packageRoot = path.join(repoRoot, "node_modules", packageName);
  await run(gyp, ["rebuild", "--directory", packageRoot, "--release", "--nodedir", headersDir, "--jobs", "max"], env);
}

console.log(JSON.stringify({
  electron: electronVersion,
  node: electronNodeVersion,
  modules: Number(electronAbi),
  headers: headersDir,
  packages,
  platform: process.platform,
  arch: process.arch,
}, null, 2));
