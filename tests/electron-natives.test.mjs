import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertElectronNativeDeps,
  createElectronRuntimeDepsManifest,
  deferredElectronNativePackages,
  electronAbi,
  electronNativeDepsRoot,
  electronNativeJsDependencies,
  electronNativeNodeFiles,
  electronNativePackages,
  electronVersion,
  omittedElectronNativePackages,
  rebuildElectronNativeDeps,
  stageElectronNativeDeps,
} from "../scripts/build-electron-natives.mjs";
import { NPM_ELECTRON_VERSION } from "../scripts/lib/electron-shell.mjs";
import { stageElectronRuntimeDependencyResolution } from "../scripts/lib/build-asar.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function writeFakeRebuiltDeps(root, { includeNodeGypBuild = true } = {}) {
  const manifest = createElectronRuntimeDepsManifest({ platform: "darwin", arch: "arm64" });
  for (const relative of electronNativeNodeFiles) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `fake:${relative}\n`);
  }
  if (includeNodeGypBuild) {
    const packageDir = path.join(root, "node-gyp-build");
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "node-gyp-build", version: "4.8.4" }, null, 2)}\n`);
    await writeFile(path.join(packageDir, "index.js"), "module.exports = () => {};\n");
  }
  await writeFile(path.join(root, "runtime-deps-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

test("electron native rebuild inventory is public ABI packages, not 0.18 private natives", () => {
  assert.equal(electronVersion, "42.1.0");
  assert.equal(electronVersion, NPM_ELECTRON_VERSION);
  assert.equal(electronAbi, "146");
  assert.deepEqual([...electronNativePackages], ["better-sqlite3", "tree-sitter", "tree-sitter-bash"]);
  assert.deepEqual([...electronNativeJsDependencies], ["bindings", "file-uri-to-path", "node-addon-api", "node-gyp-build"]);
  assert.deepEqual([...deferredElectronNativePackages], ["whichlang-node", "tree-chunk-napi"]);
  assert.deepEqual([...omittedElectronNativePackages], ["cursor-proclist"]);
  assert.ok(!electronNativePackages.includes("cursor-proclist"));
  const manifest = createElectronRuntimeDepsManifest({ platform: "linux", arch: "x64" });
  assert.equal(manifest.platform, "linux");
  assert.deepEqual(manifest.required, [...electronNativePackages]);
  assert.deepEqual(manifest.nodeFiles, [...electronNativeNodeFiles]);
  assert.ok(!manifest.copied.includes("cursor-proclist"));
  assert.ok(!manifest.copied.includes("whichlang-node"));
  assert.ok(!manifest.copied.includes("tree-chunk-napi"));
  assert.ok(!manifest.nodeFiles.some(file => file.includes("cursor-proclist")));
  assert.match(electronNativeDepsRoot(), /electron-deps\/146\//);
  assert.doesNotMatch(electronNativeDepsRoot(), /app\.asar\.unpacked/);
});

test("buildAsar copies rebuilt electron deps, not 0.18 unpacked", async () => {
  const buildAsarSource = await readFile(path.join(repoRoot, "scripts", "lib", "build-asar.mjs"), "utf8");
  const nativesSource = await readFile(path.join(repoRoot, "scripts", "build-electron-natives.mjs"), "utf8");
  const cleanBuild = await readFile(path.join(repoRoot, "scripts", "lib", "clean-build.mjs"), "utf8");
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

  assert.match(buildAsarSource, /from "\.\.\/build-electron-natives\.mjs"/);
  assert.match(buildAsarSource, /ensureElectronNativeDeps/);
  assert.match(buildAsarSource, /stageElectronNativeDeps\(stageRoot, depsRoot\)/);
  assert.match(buildAsarSource, /stageElectronRuntimeDependencyResolution\(path\.join\(stageRoot, "dist", "deps"\)\)/);
  assert.doesNotMatch(buildAsarSource, /\["deps", "native"\]/);
  assert.doesNotMatch(buildAsarSource, /path\.join\(runtimeUnpacked,\s*["']deps["']\)/);
  assert.match(buildAsarSource, /path\.join\(runtimeUnpacked, "native"\)/);

  assert.match(nativesSource, /better-sqlite3/);
  assert.match(nativesSource, /tree-sitter-bash/);
  assert.match(nativesSource, /ELECTRON_HEADERS_DIR is required/);
  assert.match(nativesSource, /omittedElectronNativePackages = Object\.freeze\(\["cursor-proclist"\]\)/);
  assert.doesNotMatch(nativesSource, /electronNativePackages = Object\.freeze\(\[[^\]]*cursor-proclist/);
  assert.match(nativesSource, /whichlang-node/);
  assert.match(nativesSource, /tree-chunk-napi/);

  assert.match(cleanBuild, /rebuilt against Electron 42\.1\.0 \(ABI 146\)/);
  assert.doesNotMatch(cleanBuild, /ABI-matched native and packaged dependencies are copied from the checksum-pinned 0\.18 runtime/);
  assert.equal(pkg.scripts["native:build:electron"], "node scripts/build-electron-natives.mjs");
  assert.equal(pkg.dependencies["better-sqlite3"], "12.6.2");
});

test("stageElectronNativeDeps copies the rebuilt tree into dist/deps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opengrok-electron-natives-"));
  try {
    const rebuilt = path.join(root, "rebuilt");
    const stageRoot = path.join(root, "stage");
    const unpacked = path.join(root, "app.asar.unpacked", "dist", "deps");
    await mkdir(unpacked, { recursive: true });
    await writeFile(path.join(unpacked, "from-0.18"), "no\n");
    await mkdir(path.join(unpacked, "cursor-proclist"), { recursive: true });
    await writeFile(path.join(unpacked, "cursor-proclist", "package.json"), "{\"name\":\"cursor-proclist\"}\n");
    await writeFakeRebuiltDeps(rebuilt);

    const destination = await stageElectronNativeDeps(stageRoot, rebuilt);
    assert.equal(destination, path.join(stageRoot, "dist", "deps"));
    assert.equal(
      await readFile(path.join(destination, "better-sqlite3", "build", "Release", "better_sqlite3.node"), "utf8"),
      "fake:better-sqlite3/build/Release/better_sqlite3.node\n",
    );
    await assert.rejects(readFile(path.join(destination, "from-0.18")));
    await assert.rejects(readFile(path.join(destination, "cursor-proclist", "package.json")));
    await assertElectronNativeDeps(destination);

    const closure = await stageElectronRuntimeDependencyResolution(destination);
    assert.equal(closure.mode, "byte-exact-sibling-package-copy");
    assert.equal(closure.packages[0]?.name, "node-gyp-build");
    assert.equal(
      await readFile(path.join(destination, "node_modules", "node-gyp-build", "index.js"), "utf8"),
      "module.exports = () => {};\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("electron native rebuild requires ELECTRON_HEADERS_DIR", async () => {
  const previous = process.env.ELECTRON_HEADERS_DIR;
  delete process.env.ELECTRON_HEADERS_DIR;
  try {
    await assert.rejects(() => rebuildElectronNativeDeps({ env: { ...process.env } }), /ELECTRON_HEADERS_DIR is required/);
  } finally {
    if (previous == null) delete process.env.ELECTRON_HEADERS_DIR;
    else process.env.ELECTRON_HEADERS_DIR = previous;
  }
});
