import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertProductionActivationsAreClean,
  compositionWithProductionActivations,
  fallbackSourcesReplacedByActivations,
  hostBindingProvenancePath,
  electronMainBindingProvenancePath,
  retainedNativePackagesFromActivations,
} from "../scripts/lib/production-activation.mjs";
import {
  hostBindingProvenancePath as hostProvenanceFromActivation,
  validateHostArtifactAnchor,
} from "../scripts/host-production-activation.mjs";
import {
  electronMainBindingProvenancePath as electronMainProvenanceFromActivation,
  electronMainProductionBindingInventorySpecs,
  validateElectronMainArtifactAnchor,
} from "../scripts/electron-main-production-activation.mjs";
import { canonicalizeRetainedElectronNativePackages } from "../scripts/build-electron-natives.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function activation(runtime, { clean, packages = [] } = {}) {
  return {
    clean,
    status: clean ? "validated-clean-source" : "incomplete-evidence-derived-manifest",
    blocker: clean ? undefined : `${runtime} bindings remain unbound`,
    provenance: {
      executableGraph: { retainedNativePackages: packages },
    },
  };
}

test("declared runtime composition ships source electron-main and host only", async () => {
  const cleanBuild = await readFile(path.join(repoRoot, "scripts", "lib", "clean-build.mjs"), "utf8");
  assert.match(cleanBuild, /runtime: "electron-main", path: "dist\/electron-main\/main\.cjs", mode: "clean-source", source: "source\/electron-main\/main\.ts"/);
  assert.match(cleanBuild, /runtime: "host", path: "dist\/host\/host-main\.cjs", mode: "clean-source", source: "source\/host\/main\.ts"/);
  assert.doesNotMatch(cleanBuild, /runtime: "electron-main".*mode: "artifact-fallback"/);
  assert.doesNotMatch(cleanBuild, /runtime: "host".*mode: "artifact-fallback"/);
  assert.doesNotMatch(cleanBuild, /dist\/recovered-source\/electron-main\/main\.cjs/);
  assert.doesNotMatch(cleanBuild, /dist\/recovered-source\/host\/host-main\.cjs/);
});

test("incomplete production activation fails closed instead of shipping a 0.18 artifact", () => {
  const host = activation("host", { clean: false });
  const electronMain = activation("electron-main", { clean: false });
  assert.throws(
    () => assertProductionActivationsAreClean(host, activation("electron-main", { clean: true })),
    /refusing to ship a 0\.18 artifact host/,
  );
  assert.throws(
    () => assertProductionActivationsAreClean(activation("host", { clean: true }), electronMain),
    /refusing to ship a 0\.18 artifact main/,
  );
  assert.throws(
    () => compositionWithProductionActivations(host, activation("electron-main", { clean: true }), []),
    /refusing to ship a 0\.18 artifact host/,
  );
});

test("clean activation rewrites electron-main and host to the production source graph", () => {
  const host = activation("host", { clean: true });
  const electronMain = {
    ...activation("electron-main", { clean: true }),
    runtimePackageFiles: ["node_modules/undici/index.js"],
  };
  const composition = compositionWithProductionActivations(host, electronMain, [
    { runtime: "electron-main", path: "dist/electron-main/main.cjs", mode: "clean-source", source: "source/electron-main/main.ts" },
    { runtime: "host", path: "dist/host/host-main.cjs", mode: "clean-source", source: "source/host/main.ts" },
    { runtime: "renderer", path: "dist/renderer", mode: "clean-source" },
  ]);
  assert.deepEqual(composition.find(runtime => runtime.runtime === "host"), {
    runtime: "host",
    path: "dist/host/host-main.cjs",
    mode: "clean-source",
    source: "source/host/main.ts",
    bindingManifest: hostBindingProvenancePath,
  });
  assert.deepEqual(composition.find(runtime => runtime.runtime === "electron-main"), {
    runtime: "electron-main",
    path: "dist/electron-main/main.cjs",
    mode: "clean-source",
    source: "source/electron-main/main.ts",
    bindingManifest: electronMainBindingProvenancePath,
    runtimePackageFiles: ["node_modules/undici/index.js"],
  });
});

test("retained natives follow the union of production esbuild metafile greps", () => {
  assert.throws(
    () => retainedNativePackagesFromActivations(activation("host", { clean: true }), {}),
    /did not record esbuild-metafile retained native packages/,
  );
  assert.deepEqual(
    retainedNativePackagesFromActivations(
      activation("host", { clean: true, packages: [] }),
      activation("electron-main", { clean: true, packages: [] }),
    ),
    [],
  );
  assert.deepEqual(
    retainedNativePackagesFromActivations(
      activation("host", { clean: true, packages: ["whichlang-node", "whichlang-node-darwin-arm64"] }),
      activation("electron-main", { clean: true, packages: ["@anysphere/tree-chunk-napi"] }),
    ),
    ["@anysphere/tree-chunk-napi", "whichlang-node", "whichlang-node-darwin-arm64"],
  );
  assert.deepEqual(
    canonicalizeRetainedElectronNativePackages(["whichlang-node", "@anysphere/tree-chunk-napi", "whichlang-node"]),
    ["@anysphere/tree-chunk-napi", "whichlang-node"],
  );
});

test("clean-source composition has no recovered-source fallbacks to package", () => {
  assert.deepEqual(
    fallbackSourcesReplacedByActivations(
      activation("host", { clean: true }),
      activation("electron-main", { clean: true }),
      [
        { runtime: "electron-main", path: "dist/electron-main/main.cjs", mode: "clean-source", source: "source/electron-main/main.ts" },
        { runtime: "host", path: "dist/host/host-main.cjs", mode: "clean-source", source: "source/host/main.ts" },
      ],
    ),
    [],
  );
});

test("verify requires the packaged clean-source banner and rejects artifact fallback", async () => {
  const verify = await readFile(path.join(repoRoot, "scripts", "verify.mjs"), "utf8");
  assert.doesNotMatch(verify, /1_000|1000 surviving evidence source markers/);
  assert.doesNotMatch(verify, /prepareReconstructedElectronMainArtifactFallback/);
  assert.match(verify, /Packaged electron-main must be clean-source/);
  assert.match(verify, /Packaged host must be clean-source/);
  assert.match(verify, /Deterministic clean-source production Electron main/);
  assert.match(verify, /Deterministic clean-source production host/);
  assert.match(verify, /Staged retained natives do not match the production esbuild metafile/);
  const asar = await readFile(path.join(repoRoot, "scripts", "lib", "build-asar.mjs"), "utf8");
  assert.doesNotMatch(asar, /prepareReconstructedElectronMainArtifactFallback/);
  const libCleanBuild = await readFile(path.join(repoRoot, "scripts", "lib", "clean-build.mjs"), "utf8");
  assert.doesNotMatch(libCleanBuild, /dist\/recovered-source\/electron-main\/main\.cjs/);
  assert.doesNotMatch(libCleanBuild, /dist\/recovered-source\/host\/host-main\.cjs/);
  const hostActivation = await readFile(path.join(repoRoot, "scripts", "host-production-activation.mjs"), "utf8");
  const electronMainActivation = await readFile(path.join(repoRoot, "scripts", "electron-main-production-activation.mjs"), "utf8");
  const productionActivation = await readFile(path.join(repoRoot, "scripts", "lib", "production-activation.mjs"), "utf8");
  assert.equal(hostBindingProvenancePath, hostProvenanceFromActivation);
  assert.equal(electronMainBindingProvenancePath, electronMainProvenanceFromActivation);
  assert.match(productionActivation, /export \{ hostBindingProvenancePath, electronMainBindingProvenancePath \}/);
  assert.match(hostActivation, /retainedNativePackages: retainedElectronNativePackagesFromMetafile\(result\.metafile\)/);
  assert.match(electronMainActivation, /retainedNativePackages: retainedElectronNativePackagesFromMetafile\(result\.metafile\)/);
  assert.match(libCleanBuild, /refuses pack:true/);
  assert.match(hostActivation, /if \(error\?\.code === "ENOENT"\) return null/);
  assert.match(electronMainActivation, /if \(error\?\.code === "ENOENT"\) return null/);
  const audit = await readFile(path.join(repoRoot, "scripts", "audit-runtime-composition.mjs"), "utf8");
  assert.match(audit, /readOptionalUtf8/);
  assert.match(audit, /artifact-not-present/);
  const packaging = await readFile(path.join(repoRoot, "scripts", "clean-build.mjs"), "utf8");
  assert.doesNotMatch(packaging, /hostActivation\.clean \?/);
  assert.doesNotMatch(packaging, /electronMainActivation\.clean \?/);
});

test("0.18 artifact needles are skipped when absent and fail on drift when present", async () => {
  const spec = electronMainProductionBindingInventorySpecs.find(item => item.path === "startup");
  assert.ok(spec);
  validateElectronMainArtifactAnchor(spec.path, spec.artifactAnchor, null);
  const matching = [];
  matching[spec.artifactAnchor.line - 1] = `prefix ${spec.artifactAnchor.needle} suffix`;
  validateElectronMainArtifactAnchor(spec.path, spec.artifactAnchor, matching);
  assert.throws(
    () => validateElectronMainArtifactAnchor(spec.path, spec.artifactAnchor, ["wrong"]),
    /drifted/,
  );

  const hostAnchor = { line: 2, needle: "executeBoxCopyInFromEnv" };
  assert.deepEqual(await validateHostArtifactAnchor(hostAnchor, null), {
    artifact: "src/app/dist/host/host-main.cjs",
    line: 2,
    needle: "executeBoxCopyInFromEnv",
  });
  assert.deepEqual(
    await validateHostArtifactAnchor(hostAnchor, "// src/host/main.ts\nexecuteBoxCopyInFromEnv();\n"),
    {
      artifact: "src/app/dist/host/host-main.cjs",
      line: 2,
      sourceMarker: "src/host/main.ts",
      needle: "executeBoxCopyInFromEnv",
    },
  );
  await assert.rejects(
    () => validateHostArtifactAnchor(hostAnchor, "// src/host/main.ts\nnot-the-needle\n"),
    /drifted/,
  );
});
