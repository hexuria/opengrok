#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { extractFile } from "@electron/asar";

import { buildFidelityReconstructedAsar } from "./clean-build.mjs";
import { signAppBundle } from "./lib/codesign.mjs";
import { outputDir, repoRoot, sourceAppDir } from "./lib/config.mjs";
import {
  verifyChecksumPinnedRendererPackage,
  verifyOfficialMacReference,
  verifyReconstructedMacPackage,
} from "./lib/macos-package-verification.mjs";
import { run } from "./lib/process.mjs";
import { resolveRuntimeApp } from "./lib/runtime.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";

if (process.platform !== "darwin") throw new Error("The fidelity diagnostic app can only be packaged on macOS");

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const diagnosticRoot = path.join(repoRoot, ".build", "diagnostic-fidelity");
const stageRoot = path.join(diagnosticRoot, "app");
const archivePath = path.join(diagnosticRoot, "app.asar");
const unpackedRoot = `${archivePath}.unpacked`;
const cleanOutputRoot = path.join(repoRoot, ".build", "diagnostic-fidelity-clean");

for (const selector of [
  path.join(repoRoot, ".build", "fidelity", "e2e-candidate.json"),
  path.join(repoRoot, ".build", "fidelity", "release-candidate.json"),
]) {
  if (existsSync(selector)) throw new Error(`Diagnostic packaging refuses a selected release candidate: ${selector}`);
}

await buildFidelityReconstructedAsar({
  buildRoot: diagnosticRoot,
  stageRoot,
  archivePath,
  unpackedRoot,
  cleanOutputRoot,
});
// Official shell/asar hashes stay on this diagnostic path only. Default
// packaging wraps npm Electron 42.1.0 and does not require Anysphere Mach-O
// identity.
const runtimeApp = await resolveRuntimeApp();
await verifyOfficialMacReference({ runtimeApp });
const officialArchivePath = path.join(runtimeApp, "Contents", "Resources", "app.asar");
const renderer = await verifyChecksumPinnedRendererPackage({
  archivePath,
  sourceRendererRoot: path.join(sourceAppDir, "dist", "renderer"),
  officialArchivePath,
});
const asarSha256 = sha256(await readFile(archivePath));
const shortHash = asarSha256.slice(0, 12);
const appName = `Grok Bot 0.18 Fidelity Diagnostic-${shortHash}.app`;
const stagedApp = path.join(outputDir, appName);
const installedApp = path.join("/Applications", appName);
if (existsSync(stagedApp) || existsSync(installedApp)) {
  throw new Error(`Diagnostic app path already exists; refusing overwrite: ${existsSync(installedApp) ? installedApp : stagedApp}`);
}

await mkdir(outputDir, { recursive: true });
await run(SYSTEM_TOOLS.ditto, [runtimeApp, stagedApp]);
await run(SYSTEM_TOOLS.xattr, ["-cr", stagedApp]);
const resources = path.join(stagedApp, "Contents", "Resources");
const packagedAsar = path.join(resources, "app.asar");
const packagedUnpacked = `${packagedAsar}.unpacked`;
await rm(packagedAsar, { force: true });
await rm(packagedUnpacked, { recursive: true, force: true });
await cp(archivePath, packagedAsar);
await cp(unpackedRoot, packagedUnpacked, { recursive: true, dereference: false, preserveTimestamps: true });

const infoPlist = path.join(stagedApp, "Contents", "Info.plist");
await run(SYSTEM_TOOLS.plutil, ["-remove", "ElectronAsarIntegrity", infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-replace", "CFBundleIdentifier", "-string", `bot.opengrok.app.fidelity.diagnostic.build${shortHash}`, infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-replace", "CFBundleDisplayName", "-string", `Grok Bot 0.18 Fidelity Diagnostic-${shortHash}`, infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-remove", "CFBundleURLTypes", infoPlist]);
await rm(path.join(stagedApp, "Contents", "_CodeSignature"), { recursive: true, force: true });
await signAppBundle(stagedApp);
await run(SYSTEM_TOOLS.codesign, ["--verify", "--deep", "--strict", stagedApp]);
await verifyReconstructedMacPackage({
  officialApp: runtimeApp,
  reconstructedApp: stagedApp,
  sourceUnpackedRoot: unpackedRoot,
  packagedUnpackedRoot: packagedUnpacked,
});
if (sha256(await readFile(packagedAsar)) !== asarSha256) throw new Error("Diagnostic packaged ASAR drifted");

await run(SYSTEM_TOOLS.ditto, [stagedApp, installedApp]);
await run(SYSTEM_TOOLS.codesign, ["--verify", "--deep", "--strict", installedApp]);
const installedAsar = path.join(installedApp, "Contents", "Resources", "app.asar");
if (sha256(await readFile(installedAsar)) !== asarSha256) throw new Error("Installed diagnostic ASAR drifted");

const reconstructionManifest = JSON.parse(extractFile(archivePath, "dist/reconstruction-build.json").toString("utf8"));
const outputs = new Map(reconstructionManifest.outputs.map(row => [row.path, row]));
const hashFor = relative => {
  const bytes = extractFile(archivePath, relative);
  const digest = sha256(bytes);
  const declared = outputs.get(relative);
  if (declared?.sha256 !== digest || declared.bytes !== bytes.length) throw new Error(`Diagnostic runtime identity drifted: ${relative}`);
  return { path: relative, bytes: bytes.length, sha256: digest };
};
const executablePath = path.join(installedApp, "Contents", "MacOS", "Grok Bot");
const executableRealpath = await realpath(executablePath);
const report = {
  status: "diagnostic-only",
  skippedReleaseGates: ["prebuild", "postbuild"],
  selectorsPublished: false,
  appPath: installedApp,
  stagedAppPath: stagedApp,
  asarPath: installedAsar,
  asarSha256,
  executable: { path: executableRealpath, sha256: sha256(await readFile(executableRealpath)) },
  runtimes: {
    electronMain: hashFor("dist/electron-main/main.cjs"),
    primaryPreload: hashFor("dist/electron-preload/preload.cjs"),
    host: hashFor("dist/host/host-main.cjs"),
    boxExecDaemon: hashFor("dist/box-exec-daemon/main.cjs"),
    localExecDaemon: hashFor("dist/local-exec-daemon/main.cjs"),
  },
  renderer,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
