import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { extractFile, listPackage, statFile } from "@electron/asar";

import {
  expectedSignatureExcludedMachOHash,
  inspectReconstructedMacShell,
  officialMacReleaseAsarHash,
  officialMacReleaseShellHash,
} from "./macos-shell-invariant.mjs";

// Electron and daemon-native payloads are separate runtime domains. Both are
// unpacked from the ASAR and must remain byte-identical to their staged trees;
// collapsing them would let a package silently omit the daemon ABI payload.
const RUNTIME_ROOTS = ["dist/deps", "dist/native", "dist/node-deps"];
const MANIFEST_RELATIVE = "dist/deps/runtime-deps-manifest.json";
const CSNAPS_RELATIVE = "dist/host/extensions/codebase-telemetry/csnaps";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function verifyChecksumPinnedRendererPackage({
  archivePath,
  sourceRendererRoot,
  officialArchivePath,
  provenancePath = "dist/renderer-artifact-provenance.json",
  buildManifestPath = "dist/reconstruction-build.json",
  rendererExtensionPath = "dist/renderer-router-extension.json",
} = {}) {
  if ([archivePath, sourceRendererRoot].some(value => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("Explicit archivePath and sourceRendererRoot paths are required");
  }
  const buildManifest = JSON.parse(extractFile(archivePath, buildManifestPath).toString("utf8"));
  const renderer = buildManifest.runtimeComposition?.find(runtime => runtime.runtime === "renderer");
  if (renderer?.mode !== "checksum-pinned-artifact-runtime" || renderer.provenance !== provenancePath) {
    throw new Error(`Fidelity renderer has an invalid runtime classification: ${renderer?.mode}`);
  }
  const provenanceBytes = extractFile(archivePath, provenancePath);
  const provenance = JSON.parse(provenanceBytes.toString("utf8"));
  if (provenance.mode !== renderer.mode || provenance.hashAlgorithm !== "sha256" || !Array.isArray(provenance.files)) {
    throw new Error("Fidelity renderer provenance contract is invalid");
  }
  if (provenance.upstreamAppAsarSha256 !== officialMacReleaseAsarHash) {
    throw new Error("Fidelity renderer provenance is not bound to the canonical shipped 0.18 Mac ASAR");
  }
  const expectedFiles = new Map();
  for (const record of provenance.files) {
    assertSafeRelative(record.path);
    if (expectedFiles.has(record.path) || typeof record.bytes !== "number" || !/^[0-9a-f]{64}$/.test(record.sha256)) {
      throw new Error(`Invalid renderer provenance entry: ${JSON.stringify(record)}`);
    }
    const source = await readFile(path.join(sourceRendererRoot, record.path));
    const sourceRecord = { path: record.path, bytes: source.byteLength, sha256: sha256(source) };
    if (sourceRecord.bytes !== record.bytes || sourceRecord.sha256 !== record.sha256) {
      throw new Error(`Shipped renderer source drift at ${record.path}`);
    }
    expectedFiles.set(record.path, record);
  }
  const sourceFiles = await walkFiles(sourceRendererRoot);
  if (JSON.stringify(sourceFiles) !== JSON.stringify([...expectedFiles.keys()])) {
    throw new Error("Shipped renderer source inventory differs from embedded provenance");
  }
  if (provenance.fileCount !== expectedFiles.size || provenance.inventorySha256 !== sha256(JSON.stringify([...expectedFiles.values()]))) {
    throw new Error("Fidelity renderer aggregate inventory hash is invalid");
  }
  if (officialArchivePath != null) {
    if (sha256(await readFile(officialArchivePath)) !== officialMacReleaseAsarHash) {
      throw new Error("Renderer verification received a non-canonical official Mac ASAR");
    }
    const officialFiles = [];
    for (const raw of listPackage(officialArchivePath)) {
      const relative = raw.replace(/^\/+/, "");
      if (!relative.startsWith("dist/renderer/")) continue;
      try {
        const entry = statFile(officialArchivePath, relative);
        if (typeof entry.size === "number") officialFiles.push(relative.slice("dist/renderer/".length));
      } catch {
        // Directory entries are intentionally excluded from the byte inventory.
      }
    }
    officialFiles.sort();
    if (JSON.stringify(officialFiles) !== JSON.stringify([...expectedFiles.keys()])) {
      throw new Error("Renderer provenance inventory differs from the canonical shipped 0.18 Mac ASAR");
    }
    for (const [relative, expected] of expectedFiles) {
      const official = extractFile(officialArchivePath, `dist/renderer/${relative}`);
      if (official.byteLength !== expected.bytes || sha256(official) !== expected.sha256) {
        throw new Error(`Renderer provenance differs from the canonical shipped Mac ASAR at ${relative}`);
      }
    }
  }
  let rendererExtension = null;
  try {
    const bytes = extractFile(archivePath, rendererExtensionPath);
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (parsed?.schemaVersion !== 1 || parsed?.mode !== "original-renderer-settings-extension" || !Array.isArray(parsed.chunks)) {
      throw new Error("Renderer extension provenance contract is invalid");
    }
    // brandCounts joined the record when the brand pass began reporting per-chunk counts; the
    // contract had not been told, so this diagnostic would have refused a record the packager
    // writes on every build. It is diagnostic-only, which is why packaging never noticed.
    const allowedKeys = ["schemaVersion", "mode", "chunks", "features", "transformations", "brandCounts"];
    if (Object.keys(parsed).sort().join("\0") !== allowedKeys.sort().join("\0")) throw new Error("Renderer extension provenance has unknown fields");
    const chunks = new Map();
    for (const row of parsed.chunks) {
      const relative = typeof row?.path === "string" && row.path.startsWith("dist/renderer/") ? row.path.slice("dist/renderer/".length) : null;
      // "card" joined "registry" and "panel" when the approval card's own lazily imported chunk
      // began carrying a patch. The contract is widened by exactly one named role, not relaxed:
      // an unknown role is still refused, a chunk is still named, still counted once, and still
      // matched byte for byte against both its recorded hashes below.
      if (relative == null || !expectedFiles.has(relative) || chunks.has(relative) || !["registry", "panel", "card"].includes(row.role)
        || !Number.isInteger(row.original?.bytes) || !/^[0-9a-f]{64}$/.test(row.original?.sha256)
        || !Number.isInteger(row.patched?.bytes) || !/^[0-9a-f]{64}$/.test(row.patched?.sha256)) {
        throw new Error("Renderer extension chunk provenance is invalid");
      }
      const expected = expectedFiles.get(relative);
      if (row.original.bytes !== expected.bytes || row.original.sha256 !== expected.sha256) throw new Error(`Renderer extension source identity drift at ${relative}`);
      chunks.set(relative, row);
    }
    if (chunks.size < 1 || chunks.size > 3) throw new Error("Renderer extension chunk cardinality is invalid");
    // Roles are unique: two rows claiming "registry" would let one patched chunk vouch for another.
    const roles = parsed.chunks.map((row) => row.role);
    if (new Set(roles).size !== roles.length) throw new Error("Renderer extension roles are not unique");
    rendererExtension = { bytes, parsed, chunks };
  } catch (error) {
    if (!(error instanceof Error) || !/not found in archive|Cannot find/.test(error.message)) throw error;
  }
  const packagedFiles = [];
  for (const raw of listPackage(archivePath)) {
    const relative = raw.replace(/^\/+/, "");
    if (!relative.startsWith("dist/renderer/")) continue;
    try {
      const entry = statFile(archivePath, relative);
      if (typeof entry.size === "number") packagedFiles.push(relative.slice("dist/renderer/".length));
    } catch {
      // Directory entries are intentionally excluded from the byte inventory.
    }
  }
  packagedFiles.sort();
  if (JSON.stringify(packagedFiles) !== JSON.stringify([...expectedFiles.keys()])) {
    throw new Error("Packaged renderer file inventory differs from the exact shipped renderer");
  }
  for (const [relative, expected] of expectedFiles) {
    const packaged = extractFile(archivePath, `dist/renderer/${relative}`);
    const extension = rendererExtension?.chunks.get(relative);
    const wanted = extension?.patched ?? expected;
    if (packaged.byteLength !== wanted.bytes || sha256(packaged) !== wanted.sha256) {
      throw new Error(`Packaged renderer drift at ${relative}`);
    }
  }
  return {
    mode: renderer.mode,
    provenancePath,
    provenanceSha256: sha256(provenanceBytes),
    fileCount: expectedFiles.size,
    inventorySha256: provenance.inventorySha256,
    upstreamAppAsarSha256: provenance.upstreamAppAsarSha256,
    ...(rendererExtension == null ? {} : {
      extension: {
        path: rendererExtensionPath,
        sha256: sha256(rendererExtension.bytes),
        chunks: rendererExtension.parsed.chunks,
      },
    }),
  };
}

export function verifyFidelityActivationPayloads({ archivePath } = {}) {
  if (typeof archivePath !== "string" || archivePath.length === 0) throw new TypeError("An explicit archivePath is required");
  const contracts = [
    {
      runtime: "electron-main",
      path: "dist/electron-main/main.cjs",
      activation: "cursor-auth",
      markers: ["createCursorAuthWiring", "SUPPORTED_DASHBOARD_ACTIONS", "local-tool-ceiling", "requestLimitIncrease"],
    },
    {
      runtime: "host",
      path: "dist/host/host-main.cjs",
      activation: "typed-tool-producer",
      markers: ["ClientSideToolV2Producer", "encodeClientSideToolV2Message", "protobuf-base64", "aiserver.v1.ClientSideToolV2Call"],
    },
    {
      runtime: "node-agent-coordinator",
      path: "dist/node-agent-coordinator/main.cjs",
      activation: "typed-tool-relay",
      markers: ["ClientSideToolV2Relay", "parseClientSideToolV2TransportEvent", "materializeClientSideToolV2RendererEvent", "aiserver.v1.ClientSideToolV2Result"],
    },
  ];
  return contracts.map(contract => {
    const bytes = extractFile(archivePath, contract.path);
    const source = bytes.toString("utf8");
    const missingMarkers = contract.markers.filter(marker => !source.includes(marker));
    if (missingMarkers.length > 0) {
      throw new Error(`Fidelity activation is absent from ${contract.path}: ${missingMarkers.join(", ")}`);
    }
    return {
      runtime: contract.runtime,
      path: contract.path,
      activation: contract.activation,
      sha256: sha256(bytes),
      markers: contract.markers,
      verdict: "verified-in-packaged-executable",
    };
  });
}

export async function verifyCsnapsCarrierClassification({ archivePath, unpackedRoot } = {}) {
  if ([archivePath, unpackedRoot].some(value => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("Explicit archivePath and unpackedRoot paths are required");
  }
  const listing = new Set(listPackage(archivePath).map(entry => entry.replace(/^\/+/, "")));
  if (listing.has(CSNAPS_RELATIVE)) {
    throw new Error("A csnaps carrier was packaged even though no shipped carrier is recoverable");
  }
  try {
    await stat(path.join(unpackedRoot, CSNAPS_RELATIVE));
    throw new Error("A physical csnaps carrier was staged outside the ASAR without shipped provenance");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const host = extractFile(archivePath, "dist/host/host-main.cjs").toString("utf8");
  const markers = [
    "resolveCsnapsCapability",
    "Codebase Telemetry unavailable: csnaps",
    "not-executable",
    "flushPendingUploads",
  ];
  const missingMarkers = markers.filter(marker => !host.includes(marker));
  if (missingMarkers.length > 0) {
    throw new Error(`Packaged host is missing the csnaps availability/no-op gate: ${missingMarkers.join(", ")}`);
  }
  if (!/Codebase Telemetry unavailable: csnaps[\s\S]{0,800}?flushPendingUploads/.test(host)) {
    throw new Error("Packaged host does not return the no-op telemetry API from the unavailable csnaps branch");
  }
  return {
    classification: "shipped-carrier-unavailable",
    carrierPath: CSNAPS_RELATIVE,
    packagedCarrier: "absent",
    behavior: "availability-gated-no-op-no-spawn",
    markers,
    verdict: "verified-in-packaged-executable",
  };
}

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

export async function verifyOfficialMacReference({ runtimeApp } = {}) {
  if (typeof runtimeApp !== "string" || runtimeApp.length === 0) throw new TypeError("An explicit official runtime app path is required");
  const shellPath = path.join(runtimeApp, "Contents", "MacOS", "Grok Bot");
  const asarPath = path.join(runtimeApp, "Contents", "Resources", "app.asar");
  const [shell, asar] = await Promise.all([readFile(shellPath), readFile(asarPath)]);
  const shellHash = sha256(shell);
  const asarHash = sha256(asar);
  if (shellHash !== officialMacReleaseShellHash) throw new Error(`Official Mac shell reference drifted: ${shellHash}`);
  if (asarHash !== officialMacReleaseAsarHash) throw new Error(`Official Mac app.asar reference drifted: ${asarHash}`);
  return { shellPath, asarPath, shellHash, asarHash };
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

export async function verifyReconstructedMacPackage({ officialApp, reconstructedApp, sourceUnpackedRoot, packagedUnpackedRoot } = {}) {
  if ([officialApp, reconstructedApp, sourceUnpackedRoot, packagedUnpackedRoot].some(value => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("Explicit officialApp, reconstructedApp, sourceUnpackedRoot, and packagedUnpackedRoot paths are required");
  }
  const officialShellPath = path.join(officialApp, "Contents", "MacOS", "Grok Bot");
  const reconstructedShellPath = path.join(reconstructedApp, "Contents", "MacOS", "Grok Bot");
  const officialAsarPath = path.join(officialApp, "Contents", "Resources", "app.asar");
  const reconstructedAsarPath = path.join(reconstructedApp, "Contents", "Resources", "app.asar");
  const [officialShell, reconstructedShell, officialAsar, reconstructedAsar] = await Promise.all([
    readFile(officialShellPath),
    readFile(reconstructedShellPath),
    readFile(officialAsarPath),
    readFile(reconstructedAsarPath),
  ]);
  const invariant = inspectReconstructedMacShell(officialShell, reconstructedShell);
  if (invariant.officialHash !== officialMacReleaseShellHash) throw new Error("Reconstructed verification received a non-canonical official shell reference");
  if (invariant.officialNormalizedHash !== expectedSignatureExcludedMachOHash || invariant.reconstructedNormalizedHash !== expectedSignatureExcludedMachOHash || !invariant.structuralMatch) {
    throw new Error("Reconstructed Mac shell failed the signature-excluded Electron structural invariant");
  }
  if (invariant.reconstructedHash === officialMacReleaseShellHash) throw new Error("Reconstructed package must not copy the official signed shell");
  if (sha256(officialAsar) !== officialMacReleaseAsarHash) throw new Error("Reconstructed verification received a non-canonical official app.asar reference");
  if (sha256(reconstructedAsar) === officialMacReleaseAsarHash) throw new Error("Reconstructed package must not copy the official app.asar");
  const runtime = await verifyUnpackedRuntimeManifest({ sourceUnpackedRoot, packagedUnpackedRoot });
  return { invariant, reconstructedAsarHash: sha256(reconstructedAsar), runtime };
}
