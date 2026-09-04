import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCleanDistribution as buildBaseCleanDistribution,
  buildReconstructedAsar as buildBaseReconstructedAsar,
  cleanBuildDir,
  packStagedAppWithIntegrity,
  runtimeComposition,
} from "./lib/clean-build.mjs";
import {
  builtAsar,
  builtAsarUnpacked,
  repoRoot,
  stagedAppDir,
} from "./lib/config.mjs";
import { compositionAuditPath, writeRuntimeCompositionAudit } from "./audit-runtime-composition.mjs";
import {
  buildProductionHostIfSupplied,
  hostBindingProvenancePath,
} from "./host-production-activation.mjs";
import {
  buildProductionElectronMainIfSupplied,
  electronMainBindingProvenancePath,
} from "./electron-main-production-activation.mjs";
import {
  assertProductionActivationsAreClean,
  compositionWithProductionActivations,
  fallbackSourcesReplacedByActivations as fallbackSourcesFromComposition,
  retainedNativePackagesFromActivations,
} from "./lib/production-activation.mjs";
import { stageRetainedElectronNatives } from "./build-electron-natives.mjs";

const scriptPath = fileURLToPath(import.meta.url);
export const defaultElectronMainBindingManifestPath = path.join(repoRoot, "manifests/reconstruction/electron-main-production-bindings-manifest.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export {
  assertProductionActivationsAreClean,
  compositionWithProductionActivations,
  retainedNativePackagesFromActivations,
};

export function fallbackSourcesReplacedByActivations(hostActivation, electronMainActivation, composition = runtimeComposition) {
  return fallbackSourcesFromComposition(hostActivation, electronMainActivation, composition);
}

async function outputRecord(outputRoot, relative) {
  const target = path.join(outputRoot, relative);
  return { path: relative, bytes: (await stat(target)).size, sha256: sha256(await readFile(target)) };
}

async function prepareProductionActivations(clean, hostBindingManifest, electronMainBindingManifest, composition = runtimeComposition) {
  const [hostActivation, electronMainActivation] = await Promise.all([
    buildProductionHostIfSupplied({ outputRoot: clean.outputRoot, manifestPath: hostBindingManifest }),
    buildProductionElectronMainIfSupplied({ outputRoot: clean.outputRoot, manifestPath: electronMainBindingManifest }),
  ]);
  assertProductionActivationsAreClean(hostActivation, electronMainActivation);
  const activatedComposition = compositionWithProductionActivations(hostActivation, electronMainActivation, composition);
  const excludedFallbacks = new Set(fallbackSourcesReplacedByActivations(hostActivation, electronMainActivation));
  const replacements = new Set([
    "dist/host/host-main.cjs", hostBindingProvenancePath,
    "dist/electron-main/main.cjs", electronMainBindingProvenancePath,
  ]);
  let outputs = clean.buildManifest.outputs.filter(output => !excludedFallbacks.has(output.path) && !replacements.has(output.path));
  for (const relative of replacements) outputs.push(await outputRecord(clean.outputRoot, relative));
  for (const relative of electronMainActivation.runtimePackageFiles ?? []) outputs.push(await outputRecord(clean.outputRoot, relative));
  outputs.sort((left, right) => left.path.localeCompare(right.path));
  return {
    ...clean,
    hostActivation,
    electronMainActivation,
    buildManifest: { ...clean.buildManifest, runtimeComposition: activatedComposition, outputs },
  };
}

async function attachCompositionAudit(clean) {
  const composition = clean.buildManifest.runtimeComposition;
  const auditHostActivation = {
    status: clean.hostActivation.status,
    clean: true,
    requiredBindings: clean.hostActivation.requiredBindings,
    boundBindings: clean.hostActivation.boundBindings,
    unboundBindings: clean.hostActivation.unboundBindings,
    inventory: clean.hostActivation.inventory ?? clean.hostActivation.provenance.inventory,
    activationEvidence: clean.hostActivation.activationEvidence ?? clean.hostActivation.provenance.activationEvidence,
    provenance: clean.hostActivation.provenance,
  };
  const result = await writeRuntimeCompositionAudit({
    outputRoot: clean.outputRoot,
    requireOutputs: true,
    composition,
    hostActivation: auditHostActivation,
    electronMainActivation: {
      status: clean.electronMainActivation.status,
      clean: true,
      provenance: clean.electronMainActivation.provenance,
    },
  });
  const auditStat = await stat(result.path);
  const outputs = clean.buildManifest.outputs
    .filter(output => output.path !== compositionAuditPath)
    .concat({ path: compositionAuditPath, bytes: auditStat.size, sha256: result.sha256 })
    .sort((left, right) => left.path.localeCompare(right.path));
  const buildManifest = {
    ...clean.buildManifest,
    schemaVersion: 2,
    deterministicInputs: [...new Set([
      ...clean.buildManifest.deterministicInputs,
      "manifests/reconstruction/runner-parity-audit.json",
      "scripts/audit-runtime-composition.mjs",
      "scripts/build-box-exec-daemon.mjs",
      "scripts/host-production-activation.mjs",
      "scripts/electron-main-production-activation.mjs",
      "package.json",
      "package-lock.json",
      "src/app/package.json",
      ...[clean.hostActivation.provenance.manifestPath, clean.electronMainActivation.provenance.manifestPath].filter(value => typeof value === "string" && value.length > 0),
    ])],
    hostActivation: {
      status: clean.hostActivation.status,
      bindingManifest: hostBindingProvenancePath,
      manifestSha256: clean.hostActivation.provenance.manifestSha256,
      outputSha256: clean.hostActivation.provenance.output.sha256,
    },
    electronMainActivation: {
      status: clean.electronMainActivation.status,
      bindingManifest: electronMainBindingProvenancePath,
      manifestSha256: clean.electronMainActivation.provenance.manifestSha256,
      outputSha256: clean.electronMainActivation.provenance.output.sha256,
      runtimePackageFiles: clean.electronMainActivation.runtimePackageFiles ?? [],
    },
    compositionAudit: {
      path: compositionAuditPath,
      sha256: result.sha256,
      cleanAccepted: result.audit.summary.cleanAccepted,
      blockedFallbacks: result.audit.summary.blockedFallbacks,
    },
    outputs,
  };
  await writeFile(clean.manifestPath, `${JSON.stringify(buildManifest, null, 2)}\n`);
  return { ...clean, buildManifest, compositionAudit: result.audit, compositionAuditPath: result.path };
}

export async function overlayAuditMetadata(clean, { stageRoot = stagedAppDir } = {}) {
  const relativePaths = [
    compositionAuditPath,
    "dist/reconstruction-build.json",
    "dist/host/host-main.cjs",
    hostBindingProvenancePath,
    "dist/electron-main/main.cjs",
    electronMainBindingProvenancePath,
  ];
  for (const relative of relativePaths) {
    const destination = path.join(stageRoot, relative);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(clean.outputRoot, relative), destination, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
  }
  for (const relative of clean.electronMainActivation.runtimePackageFiles ?? []) {
    const destination = path.join(stageRoot, relative);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(clean.outputRoot, relative), destination, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
  }
  for (const relative of fallbackSourcesReplacedByActivations(clean.hostActivation, clean.electronMainActivation)) {
    await rm(path.join(stageRoot, relative), { recursive: true, force: true });
  }
  await overlayRetainedNativesFromActivations(clean, { stageRoot });
}

async function overlayRetainedNativesFromActivations(clean, { stageRoot }) {
  const packages = retainedNativePackagesFromActivations(clean.hostActivation, clean.electronMainActivation);
  if (packages.length > 0) {
    throw new Error(`Packaging refuses 0.18 retained natives (${packages.join(", ")}); no bootstrap fallback`);
  }
  await stageRetainedElectronNatives(path.join(stageRoot, "dist", "deps"), null, { packages });
}

export { cleanBuildDir, runtimeComposition };

export async function buildCleanDistribution(options = {}) {
  const {
    hostBindingManifest = process.env.GROK_BOT_HOST_BINDINGS_MANIFEST?.trim() || null,
    electronMainBindingManifest = process.env.GROK_BOT_ELECTRON_MAIN_BINDINGS_MANIFEST?.trim()
      || (existsSync(defaultElectronMainBindingManifestPath) ? defaultElectronMainBindingManifestPath : null),
    ...baseOptions
  } = options;
  const base = await buildBaseCleanDistribution(baseOptions);
  return attachCompositionAudit(await prepareProductionActivations(base, hostBindingManifest, electronMainBindingManifest));
}

export async function buildReconstructedAsar({
  hostBindingManifest = process.env.GROK_BOT_HOST_BINDINGS_MANIFEST?.trim() || null,
  electronMainBindingManifest = process.env.GROK_BOT_ELECTRON_MAIN_BINDINGS_MANIFEST?.trim()
    || (existsSync(defaultElectronMainBindingManifestPath) ? defaultElectronMainBindingManifestPath : null),
} = {}) {
  const built = await buildBaseReconstructedAsar({ pack: false });
  const prepared = await prepareProductionActivations(built, hostBindingManifest, electronMainBindingManifest, runtimeComposition);
  const clean = await attachCompositionAudit(prepared);
  await overlayAuditMetadata(clean);
  await packStagedAppWithIntegrity({ stageRoot: stagedAppDir, archivePath: builtAsar, unpackedRoot: builtAsarUnpacked });
  console.log(`Fail-closed composition audit embedded: ${compositionAuditPath} (${sha256(await readFile(clean.compositionAuditPath))})`);
  return { ...built, ...clean };
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === scriptPath) {
  await buildReconstructedAsar();
}
