import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { helperInfoPlistPath, MACOS_EXECUTABLE_NAME, reconstructedHelperIdentities } from "./macos-helper-identity.mjs";
import { inspectReconstructedMacShell } from "./macos-shell-invariant.mjs";
import { capture } from "./process.mjs";
import { SYSTEM_TOOLS } from "./system-tools.mjs";

// Electron and daemon-native payloads are separate runtime domains. Both are
// unpacked from the ASAR and must remain byte-identical to their staged trees;
// collapsing them would let a package silently omit the daemon ABI payload.
const RUNTIME_ROOTS = ["dist/deps", "dist/node-deps"];
const MANIFEST_RELATIVE = "dist/deps/runtime-deps-manifest.json";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function walkFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, target));
    else if (entry.isFile()) files.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return files.sort();
}

function assertSafeRelative(relative) {
  if (typeof relative !== "string" || relative.length === 0 || path.posix.isAbsolute(relative) || relative.split("/").some(part => part === ".." || part === "")) {
    throw new Error(`Runtime manifest contains an unsafe relative path: ${JSON.stringify(relative)}`);
  }
}

async function assertNoNativeRuntime(root, label) {
  const nativeRoot = path.join(root, "dist", "native");
  let files;
  try {
    files = await walkFiles(nativeRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (files.length > 0) throw new Error(`${label} still contains dist/native: ${files.join(", ")}`);
}

async function runtimeSnapshot(root) {
  const files = [];
  for (const relativeRoot of RUNTIME_ROOTS) {
    const target = path.join(root, relativeRoot);
    let entries;
    try {
      entries = await walkFiles(target);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`Missing unpacked runtime root ${relativeRoot}`);
      throw error;
    }
    files.push(...entries.map(relative => path.posix.join(relativeRoot, relative)));
  }
  return new Map(await Promise.all(files.sort().map(async relative => {
    const bytes = await readFile(path.join(root, relative));
    return [relative, { bytes: bytes.byteLength, sha256: sha256(bytes) }];
  })));
}

async function relativeInventory(root) {
  const files = [];
  for (const relative of await walkFiles(root)) {
    const bytes = await readFile(path.join(root, relative));
    files.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function verifyUnpackedRuntimeManifest({ sourceUnpackedRoot, packagedUnpackedRoot, platform = "darwin", arch = "arm64" } = {}) {
  if (typeof sourceUnpackedRoot !== "string" || typeof packagedUnpackedRoot !== "string") {
    throw new TypeError("Explicit sourceUnpackedRoot and packagedUnpackedRoot paths are required");
  }
  const sourceManifestPath = path.join(sourceUnpackedRoot, MANIFEST_RELATIVE);
  const packagedManifestPath = path.join(packagedUnpackedRoot, MANIFEST_RELATIVE);
  const [sourceManifestBytes, packagedManifestBytes] = await Promise.all([
    readFile(sourceManifestPath),
    readFile(packagedManifestPath),
  ]);
  if (sha256(sourceManifestBytes) !== sha256(packagedManifestBytes)) throw new Error("Packaged runtime-deps-manifest.json differs from the staged manifest");
  const manifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  if (manifest.platform !== platform || manifest.arch !== arch) throw new Error(`Unexpected unpacked runtime platform/arch: ${manifest.platform}/${manifest.arch}`);
  if (!Array.isArray(manifest.nodeFiles) || manifest.nodeFiles.length === 0) throw new Error("runtime-deps-manifest.json must list native nodeFiles");
  for (const relative of manifest.nodeFiles) {
    assertSafeRelative(relative);
    const target = path.join("dist/deps", relative);
    if (!(await stat(path.join(packagedUnpackedRoot, target))).isFile()) throw new Error(`Manifest native file is not a regular packaged file: ${relative}`);
  }
  await assertNoNativeRuntime(sourceUnpackedRoot, "Staged unpacked runtime");
  await assertNoNativeRuntime(packagedUnpackedRoot, "Packaged unpacked runtime");
  if (manifest.resolutionClosure?.mode !== "byte-exact-sibling-package-copy" || !Array.isArray(manifest.resolutionClosure.packages) || manifest.resolutionClosure.packages.length === 0) {
    throw new Error("runtime-deps-manifest.json is missing the Electron package resolution closure");
  }
  for (const record of manifest.resolutionClosure.packages) {
    assertSafeRelative(record.source);
    assertSafeRelative(record.destination);
    const sourcePackage = path.join(packagedUnpackedRoot, "dist/deps", record.source);
    const resolutionPackage = path.join(packagedUnpackedRoot, "dist/deps", record.destination);
    const [sourceFiles, resolutionFiles] = await Promise.all([relativeInventory(sourcePackage), relativeInventory(resolutionPackage)]);
    if (JSON.stringify(sourceFiles) !== JSON.stringify(resolutionFiles)) throw new Error(`Electron runtime resolution package drift at ${record.name}`);
    if (record.fileCount !== sourceFiles.length || record.inventorySha256 !== sha256(JSON.stringify(sourceFiles))) {
      throw new Error(`Electron runtime resolution manifest drift at ${record.name}`);
    }
  }
  const [source, packaged] = await Promise.all([runtimeSnapshot(sourceUnpackedRoot), runtimeSnapshot(packagedUnpackedRoot)]);
  if (source.size !== packaged.size) throw new Error(`Unpacked runtime file count changed: ${source.size} -> ${packaged.size}`);
  for (const [relative, expected] of source) {
    const actual = packaged.get(relative);
    if (actual == null || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`Packaged unpacked runtime drift at ${relative}`);
    }
  }
  return { platform, arch, nodeFileCount: manifest.nodeFiles.length, runtimeFileCount: source.size, manifestSha256: sha256(sourceManifestBytes) };
}

export async function verifyReconstructedHelperIdentities({ reconstructedApp, parentBundleId } = {}) {
  if (typeof reconstructedApp !== "string" || reconstructedApp.length === 0) {
    throw new TypeError("An explicit reconstructedApp path is required");
  }
  const helpers = [];
  for (const { folder, bundleId } of reconstructedHelperIdentities(parentBundleId)) {
    const plist = helperInfoPlistPath(reconstructedApp, folder);
    const actual = await capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleIdentifier", "raw", plist]);
    if (actual !== bundleId) throw new Error(`Helper ${folder} bundle id is ${actual}, expected ${bundleId}`);
    helpers.push({ folder, bundleId });
  }
  return helpers;
}

export async function verifyNpmElectronMacShell({ electronApp, reconstructedApp } = {}) {
  if ([electronApp, reconstructedApp].some(value => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("Explicit electronApp and reconstructedApp paths are required");
  }
  const electronShellPath = path.join(electronApp, "Contents", "MacOS", "Electron");
  const reconstructedShellPath = path.join(reconstructedApp, "Contents", "MacOS", MACOS_EXECUTABLE_NAME);
  const [electronShell, reconstructedShell] = await Promise.all([
    readFile(electronShellPath),
    readFile(reconstructedShellPath),
  ]);
  const invariant = inspectReconstructedMacShell(electronShell, reconstructedShell);
  if (!invariant.structuralMatch || invariant.officialNormalizedHash !== invariant.reconstructedNormalizedHash) {
    throw new Error("Reconstructed Mac shell failed the signature-excluded npm Electron structural invariant");
  }
  if (invariant.reconstructedHash === invariant.officialHash) {
    throw new Error("Reconstructed package must not copy a vendor-signed Electron stub unchanged");
  }
  return invariant;
}

export async function verifyReconstructedMacPackage({ reconstructedApp, sourceUnpackedRoot, packagedUnpackedRoot } = {}) {
  if ([reconstructedApp, sourceUnpackedRoot, packagedUnpackedRoot].some(value => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("Explicit reconstructedApp, sourceUnpackedRoot, and packagedUnpackedRoot paths are required");
  }
  const reconstructedAsarPath = path.join(reconstructedApp, "Contents", "Resources", "app.asar");
  const reconstructedAsar = await readFile(reconstructedAsarPath);
  const runtime = await verifyUnpackedRuntimeManifest({ sourceUnpackedRoot, packagedUnpackedRoot });
  return { reconstructedAsarHash: sha256(reconstructedAsar), runtime };
}
