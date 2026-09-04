import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertElectronNativeDeps,
  createElectronRuntimeDepsManifest,
  electronAbi,
  electronNativeDepsRoot,
  electronNativeIdentityKey,
  electronNativeJsDependencies,
  electronNativeNodeFiles,
  electronNativePackages,
  electronNativeRebuildIdentity,
  electronVersion,
  omittedElectronNativePackages,
  packagedElectronRuntimePackages,
  rebuildElectronNativeDeps,
  rebuiltElectronCopiedPackages,
  retainedElectronNativeNodeFiles,
  retainedElectronNativePackages,
  retainedElectronNativePackagesFromMetafile,
  canonicalizeRetainedElectronNativePackages,
  stageElectronNativeDeps,
  stageRetainedElectronNatives,
} from "../scripts/build-electron-natives.mjs";
import { NPM_ELECTRON_VERSION } from "../scripts/lib/electron-shell.mjs";
import { stageElectronRuntimeDependencyResolution } from "../scripts/lib/build-asar.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function writePackage(root, name, extraFiles = {}) {
  const directory = path.join(root, ...name.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({ name, version: "0.0.0" }, null, 2)}\n`);
  await writeFile(path.join(directory, "index.js"), "module.exports = {};\n");
  for (const [relative, contents] of Object.entries(extraFiles)) {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

async function writeFakeRebuiltDeps(root) {
  const manifest = createElectronRuntimeDepsManifest({ platform: "darwin", arch: "arm64" });
  for (const name of manifest.copied) await writePackage(root, name);
  for (const relative of electronNativeNodeFiles) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `fake:${relative}\n`);
  }
  await writeFile(path.join(root, "runtime-deps-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function writeFakeUnpackedDeps(root) {
  await writePackage(root, "whichlang-node");
  await writePackage(root, "whichlang-node-darwin-arm64", {
    "whichlang-node.darwin-arm64.node": "fake-whichlang\n",
  });
  await writePackage(root, "@anysphere/tree-chunk-napi", {
    "tree-chunk-napi.darwin-arm64.node": "fake-tree-chunk\n",
  });
  await writePackage(root, "cursor-proclist", {
    "build/Release/cursor_proclist.node": "fake-proclist\n",
  });
}

test("electron native rebuild inventory is public ABI packages, not 0.18 private natives", () => {
  assert.equal(electronVersion, "42.1.0");
  assert.equal(electronVersion, NPM_ELECTRON_VERSION);
  assert.equal(electronAbi, "146");
  assert.deepEqual([...electronNativePackages], ["better-sqlite3", "tree-sitter", "tree-sitter-bash"]);
  assert.deepEqual([...electronNativeJsDependencies], ["bindings", "file-uri-to-path", "node-addon-api", "node-gyp-build"]);
  assert.deepEqual([...retainedElectronNativePackages], [
    "@anysphere/tree-chunk-napi",
    "whichlang-node",
    "whichlang-node-darwin-arm64",
  ]);
  assert.deepEqual([...omittedElectronNativePackages], ["cursor-proclist"]);
  assert.ok(!electronNativePackages.includes("cursor-proclist"));
  const identity = electronNativeRebuildIdentity();
  assert.equal(identity["better-sqlite3"], "12.6.2");
  assert.equal(identity["tree-sitter"], "0.21.1");
  assert.equal(identity["tree-sitter-bash"], "0.21.0");
  assert.match(electronNativeIdentityKey(identity), /^[0-9a-f]{16}$/);
  assert.notEqual(
    electronNativeIdentityKey({ ...identity, "better-sqlite3": "12.6.3" }),
    electronNativeIdentityKey(identity),
  );
  const manifest = createElectronRuntimeDepsManifest({ platform: "linux", arch: "x64" });
  assert.equal(manifest.platform, "linux");
  assert.deepEqual(manifest.required, [...electronNativePackages]);
  assert.deepEqual(manifest.copied, rebuiltElectronCopiedPackages());
  assert.deepEqual(manifest.nodeFiles, [...electronNativeNodeFiles]);
  assert.deepEqual(manifest.rebuildIdentity, identity);
  assert.ok(!manifest.copied.includes("cursor-proclist"));
  assert.ok(!manifest.copied.includes("whichlang-node"));
  assert.ok(!manifest.copied.includes("@anysphere/tree-chunk-napi"));
  assert.ok(!manifest.nodeFiles.some(file => file.includes("cursor-proclist")));
  assert.match(electronNativeDepsRoot(), /electron-deps\/146\/[0-9a-f]{16}\//);
  assert.doesNotMatch(electronNativeDepsRoot(), /app\.asar\.unpacked/);
  const packaged = packagedElectronRuntimePackages();
  assert.ok(packaged.copied.has("better-sqlite3"));
  assert.ok(!packaged.copied.has("whichlang-node"));
  assert.ok(!packaged.copied.has("@anysphere/tree-chunk-napi"));
  assert.ok(!packaged.copied.has("cursor-proclist"));
  assert.ok(packaged.native.has("better-sqlite3"));
  assert.ok(!packaged.native.has("@anysphere/tree-chunk-napi"));
  const retained = packagedElectronRuntimePackages({ retained: [...retainedElectronNativePackages] });
  assert.ok(retained.copied.has("whichlang-node"));
  assert.ok(retained.native.has("@anysphere/tree-chunk-napi"));
});

test("buildAsar copies rebuilt electron deps, not 0.18 unpacked", async () => {
  const buildAsarSource = await readFile(path.join(repoRoot, "scripts", "lib", "build-asar.mjs"), "utf8");
  const nativesSource = await readFile(path.join(repoRoot, "scripts", "build-electron-natives.mjs"), "utf8");
  const cleanBuild = await readFile(path.join(repoRoot, "scripts", "lib", "clean-build.mjs"), "utf8");
  const hostActivation = await readFile(path.join(repoRoot, "scripts", "host-production-activation.mjs"), "utf8");
  const electronMainActivation = await readFile(path.join(repoRoot, "scripts", "electron-main-production-activation.mjs"), "utf8");
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

  assert.match(buildAsarSource, /from "\.\.\/build-electron-natives\.mjs"/);
  assert.match(buildAsarSource, /ensureElectronNativeDeps/);
  assert.match(buildAsarSource, /stageElectronNativeDeps\(stageRoot, depsRoot\)/);
  assert.doesNotMatch(buildAsarSource, /stageRetainedElectronNatives/);
  assert.match(buildAsarSource, /stageElectronRuntimeDependencyResolution\(path\.join\(stageRoot, "dist", "deps"\)\)/);
  assert.doesNotMatch(buildAsarSource, /\["deps", "native"\]/);
  assert.doesNotMatch(buildAsarSource, /path\.join\(runtimeUnpacked, "deps"\)/);
  assert.match(buildAsarSource, /path\.join\(runtimeUnpacked, "native"\)/);

  assert.match(nativesSource, /better-sqlite3/);
  assert.match(nativesSource, /tree-sitter-bash/);
  assert.match(nativesSource, /ELECTRON_HEADERS_DIR is required/);
  assert.match(nativesSource, /omittedElectronNativePackages = Object\.freeze\(\["cursor-proclist"\]\)/);
  assert.match(nativesSource, /retainedElectronNativePackages/);
  assert.doesNotMatch(nativesSource, /deferredElectronNativePackages/);
  assert.doesNotMatch(nativesSource, /electronNativePackages = Object\.freeze\(\[[^\]]*cursor-proclist/);
  assert.match(nativesSource, /const output = await rebuildElectronNativeDeps\(\)/);
  assert.doesNotMatch(nativesSource, /const output = await ensureElectronNativeDeps\(\)/);

  assert.match(cleanBuild, /rebuilt against Electron 42\.1\.0 \(ABI 146\)/);
  assert.match(cleanBuild, /whichlang-node and @anysphere\/tree-chunk-napi are copied from the 0\.18 unpacked tree only when a production esbuild metafile mentions them/);
  assert.doesNotMatch(cleanBuild, /ABI-matched native and packaged dependencies are copied from the checksum-pinned 0\.18 runtime/);
  assert.match(hostActivation, /packagedElectronRuntimePackages/);
  assert.doesNotMatch(hostActivation, /sourceAppDir, "dist\/deps\/runtime-deps-manifest\.json"/);
  assert.match(electronMainActivation, /packagedElectronRuntimePackages/);
  assert.doesNotMatch(electronMainActivation, /sourceAppDir, "dist\/deps\/runtime-deps-manifest\.json"/);
  assert.equal(pkg.scripts["native:build:electron"], "node scripts/build-electron-natives.mjs");
  assert.equal(pkg.optionalDependencies["better-sqlite3"], "12.6.2");
  assert.equal(pkg.dependencies["better-sqlite3"], undefined);
});

test("stageElectronNativeDeps copies the rebuilt tree into dist/deps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opengrok-electron-natives-"));
  try {
    const rebuilt = path.join(root, "rebuilt");
    const stageRoot = path.join(root, "stage");
    const unpacked = path.join(root, "app.asar.unpacked", "dist", "deps");
    await writeFakeUnpackedDeps(unpacked);
    await writeFakeRebuiltDeps(rebuilt);

    const destination = await stageElectronNativeDeps(stageRoot, rebuilt);
    assert.equal(destination, path.join(stageRoot, "dist", "deps"));
    assert.equal(
      await readFile(path.join(destination, "better-sqlite3", "build", "Release", "better_sqlite3.node"), "utf8"),
      "fake:better-sqlite3/build/Release/better_sqlite3.node\n",
    );
    for (const name of rebuiltElectronCopiedPackages()) {
      assert.match(await readFile(path.join(destination, ...name.split("/"), "package.json"), "utf8"), new RegExp(`"name": "${name}"`));
    }
    await assert.rejects(readFile(path.join(destination, "from-0.18")));
    await assert.rejects(readFile(path.join(destination, "cursor-proclist", "package.json")));
    await assertElectronNativeDeps(destination);

    const omitted = await stageRetainedElectronNatives(destination, unpacked, { packages: [] });
    assert.deepEqual(omitted.retained, { source: "esbuild-metafile", packages: [] });
    await assert.rejects(readFile(path.join(destination, "whichlang-node", "package.json")));
    await assert.rejects(readFile(path.join(destination, "@anysphere", "tree-chunk-napi", "package.json")));

    const selected = retainedElectronNativePackagesFromMetafile({
      inputs: { "node_modules/whichlang-node/index.js": {} },
      outputs: { "host-main.cjs": { imports: [{ path: "@anysphere/tree-chunk-napi" }] } },
    });
    assert.deepEqual(selected, [...retainedElectronNativePackages]);
    const retained = await stageRetainedElectronNatives(destination, unpacked, { packages: selected });
    assert.deepEqual(retained.retained, { source: "esbuild-metafile", packages: [...retainedElectronNativePackages] });
    assert.equal(
      await readFile(path.join(destination, "whichlang-node-darwin-arm64", "whichlang-node.darwin-arm64.node"), "utf8"),
      "fake-whichlang\n",
    );
    assert.equal(
      await readFile(path.join(destination, "@anysphere", "tree-chunk-napi", "tree-chunk-napi.darwin-arm64.node"), "utf8"),
      "fake-tree-chunk\n",
    );
    await assert.rejects(readFile(path.join(destination, "cursor-proclist", "package.json")));
    for (const relative of retainedElectronNativeNodeFiles) {
      assert.ok(retained.nodeFiles.includes(relative));
    }
    await assert.rejects(
      () => stageRetainedElectronNatives(destination, unpacked, { packages: ["cursor-proclist"] }),
      /Unknown retained native package/,
    );

    const closure = await stageElectronRuntimeDependencyResolution(destination);
    assert.equal(closure.mode, "byte-exact-sibling-package-copy");
    assert.equal(closure.packages[0]?.name, "node-gyp-build");
    assert.equal(
      await readFile(path.join(destination, "node_modules", "node-gyp-build", "index.js"), "utf8"),
      "module.exports = {};\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertElectronNativeDeps rejects a tree with natives but no JS packages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opengrok-electron-natives-js-"));
  try {
    const manifest = createElectronRuntimeDepsManifest({ platform: "darwin", arch: "arm64" });
    for (const relative of electronNativeNodeFiles) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `fake:${relative}\n`);
    }
    await writeFile(path.join(root, "runtime-deps-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(() => assertElectronNativeDeps(root), /missing JS package/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertElectronNativeDeps rejects a cache whose package identity drifted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opengrok-electron-natives-id-"));
  try {
    await writeFakeRebuiltDeps(root);
    const manifestPath = path.join(root, "runtime-deps-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.rebuildIdentity = { ...manifest.rebuildIdentity, "better-sqlite3": "12.6.3" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(() => assertElectronNativeDeps(root), /identity drifted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retained native staging order is the catalog order, not host-then-electron-main insertion", () => {
  assert.deepEqual(
    canonicalizeRetainedElectronNativePackages(["whichlang-node", "@anysphere/tree-chunk-napi", "whichlang-node-darwin-arm64"]),
    [...retainedElectronNativePackages],
  );
});

test("esbuild metafile presence decides which 0.18 natives are retained", () => {
  assert.deepEqual(retainedElectronNativePackagesFromMetafile({ inputs: {}, outputs: {} }), []);
  assert.deepEqual(retainedElectronNativePackagesFromMetafile(null), []);
  assert.deepEqual(
    retainedElectronNativePackagesFromMetafile({
      inputs: { "node_modules/whichlang-node/index.js": {} },
    }),
    ["whichlang-node", "whichlang-node-darwin-arm64"],
  );
  assert.deepEqual(
    retainedElectronNativePackagesFromMetafile({
      outputs: { "host-main.cjs": { imports: [{ path: "@anysphere/tree-chunk-napi" }] } },
    }),
    ["@anysphere/tree-chunk-napi"],
  );
  assert.deepEqual(
    retainedElectronNativePackagesFromMetafile({
      inputs: { "node_modules/@anysphere/tree-chunk-napi/index.js": {}, "node_modules/whichlang-node/index.js": {} },
    }),
    [...retainedElectronNativePackages],
  );
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
