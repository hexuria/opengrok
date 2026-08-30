import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { listPackage, statFile } from "@electron/asar";

import { repoRoot } from "./config.mjs";
import { run } from "./process.mjs";

const unpackedPrefixes = ["dist/deps/", "dist/native/", "dist/node-deps/"];

async function walkFiles(root, current = root) {
  const found = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) found.push(...await walkFiles(root, target));
    else if (entry.isFile()) found.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return found.sort();
}

async function sha256(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

function isUnpackedRuntimeFile(relative) {
  return unpackedPrefixes.some(prefix => relative.startsWith(prefix));
}

async function snapshotFiles(root) {
  const files = await walkFiles(root);
  return new Map(await Promise.all(files.map(async relative => {
    const target = path.join(root, relative);
    return [relative, { bytes: (await stat(target)).size, sha256: await sha256(target) }];
  })));
}

function snapshotDiff(before, after) {
  const differences = [];
  for (const [relative, expected] of before) {
    const actual = after.get(relative);
    if (actual == null) differences.push({ relative, kind: "removed", expected });
    else if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) differences.push({ relative, kind: "staged-mutation", expected, actual });
  }
  for (const [relative, actual] of after) if (!before.has(relative)) differences.push({ relative, kind: "added", actual });
  return differences;
}

async function archiveFileEntries(archivePath) {
  const entries = new Map();
  for (const raw of listPackage(archivePath)) {
    const relative = raw.replace(/^\//, "");
    try {
      const entry = statFile(archivePath, relative);
      if (typeof entry.size === "number") entries.set(relative, entry);
    } catch {
      // listPackage includes directories; statFile is the file boundary.
    }
  }
  return entries;
}

export async function verifyStagedPackageIntegrity({ stageRoot, archivePath, unpackedRoot, before }) {
  const after = await snapshotFiles(stageRoot);
  const differences = snapshotDiff(before, after);
  const archive = await archiveFileEntries(archivePath);
  for (const [relative, expected] of before) {
    const entry = archive.get(relative);
    if (entry == null) {
      differences.push({ relative, kind: "missing-archive-entry", expected });
      continue;
    }
    if (entry.size !== expected.bytes || entry.integrity?.hash !== expected.sha256) {
      differences.push({ relative, kind: isUnpackedRuntimeFile(relative) ? "unpacked-archive-metadata" : "archive-mutation", expected, actual: { bytes: entry.size, sha256: entry.integrity?.hash } });
    }
    if (isUnpackedRuntimeFile(relative)) {
      const unpackedFile = path.join(unpackedRoot, relative);
      try {
        const actual = { bytes: (await stat(unpackedFile)).size, sha256: await sha256(unpackedFile) };
        if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) differences.push({ relative, kind: "unpacked-mutation", expected, actual });
      } catch {
        differences.push({ relative, kind: "missing-unpacked-entry", expected });
      }
    }
  }
  for (const relative of archive.keys()) if (!before.has(relative)) differences.push({ relative, kind: "stale-archive-entry", actual: archive.get(relative) });
  if (differences.length > 0) throw new Error(`Staged package changed or ASAR drifted after snapshot: ${JSON.stringify(differences)}`);
  return { fileCount: before.size, archiveFileCount: archive.size };
}

export async function packStagedAppWithIntegrity({
  stageRoot,
  archivePath,
  unpackedRoot,
  asarCli = path.join(repoRoot, "node_modules", "@electron", "asar", "bin", "asar.mjs"),
} = {}) {
  if (stageRoot == null || archivePath == null || unpackedRoot == null) {
    throw new TypeError("packStagedAppWithIntegrity requires explicit stageRoot, archivePath, and unpackedRoot outputs");
  }
  const before = await snapshotFiles(stageRoot);
  const outputDirectory = path.dirname(path.resolve(archivePath));
  const temporaryDirectory = await mkdtemp(path.join(outputDirectory, `.${path.basename(archivePath)}.pack-`));
  const temporaryArchive = path.join(temporaryDirectory, path.basename(archivePath));
  const temporaryUnpacked = `${temporaryArchive}.unpacked`;
  const previousArchive = path.join(temporaryDirectory, `${path.basename(archivePath)}.previous`);
  const previousUnpacked = path.join(temporaryDirectory, `${path.basename(unpackedRoot)}.previous`);
  const exists = async target => {
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  };
  const hadArchive = await exists(archivePath);
  const hadUnpacked = await exists(unpackedRoot);

  try {
    await run(process.execPath, [asarCli, "pack", stageRoot, temporaryArchive, "--unpack-dir", "dist/{deps,native,node-deps}"]);
    await verifyStagedPackageIntegrity({
      stageRoot,
      archivePath: temporaryArchive,
      unpackedRoot: temporaryUnpacked,
      before,
    });

    let archivedPrevious = false;
    let unpackedPrevious = false;
    try {
      if (hadArchive) {
        await rename(archivePath, previousArchive);
        archivedPrevious = true;
      }
      if (hadUnpacked) {
        await rename(unpackedRoot, previousUnpacked);
        unpackedPrevious = true;
      }
      await rename(temporaryArchive, archivePath);
      if (await exists(temporaryUnpacked)) await rename(temporaryUnpacked, unpackedRoot);
      else await rm(unpackedRoot, { recursive: true, force: true });
      const result = await verifyStagedPackageIntegrity({ stageRoot, archivePath, unpackedRoot, before });
      await rm(previousArchive, { force: true });
      await rm(previousUnpacked, { recursive: true, force: true });
      return { ...result, before };
    } catch (error) {
      await rm(archivePath, { force: true });
      await rm(unpackedRoot, { recursive: true, force: true });
      if (unpackedPrevious && await exists(previousUnpacked)) await rename(previousUnpacked, unpackedRoot);
      if (archivedPrevious && await exists(previousArchive)) await rename(previousArchive, archivePath);
      throw error;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
