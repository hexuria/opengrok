import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";

import { auditRendererClosure, rendererClosureSnapshot } from "./audit-renderer-closure.mjs";
import { auditUiProvenance } from "./audit-ui-provenance.mjs";
import {
  copyKatexRuntimeAssets,
  copyRuntimeAssets,
  isForbiddenRendererGraphInput,
  isForbiddenRuntimeAssetSource,
  isSrcAppArtifactRoot,
  normalize,
  rewritePdfAssetReferences,
  sha256,
  walk,
} from "./lib/renderer-runtime-assets.mjs";

export {
  copyKatexRuntimeAssets,
  copyRuntimeAssets,
  generateRendererPlaceholderAsset,
  isForbiddenRendererGraphInput,
  isForbiddenRuntimeAssetSource,
  isSrcAppArtifactRoot,
  planRuntimeAssetCopy,
  rewritePdfAssetReferences,
  validateRuntimeAssetBytes,
} from "./lib/renderer-runtime-assets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const rendererProductionEntrypoint = "frontend/src/main.tsx";
export const rendererProductionOutput = "dist/renderer";
export const rendererProductionProvenance = `${rendererProductionOutput}/renderer-source-provenance.json`;
const deterministicBanner = `"Deterministic clean-source renderer: ${rendererProductionEntrypoint}";`;

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(repoRoot, relative), "utf8"));
}

async function validateBootstrapEvidence() {
  const catalog = await readJson("frontend/manifests/renderer-bootstrap.json");
  const artifactPath = path.join(repoRoot, catalog.artifact);
  if (isSrcAppArtifactRoot(catalog.artifact) || await isForbiddenRuntimeAssetSource(artifactPath)) {
    // Byte-offset needles live in the 0.18 bundle. The Vite build must not
    // require those bytes; lazy-boundary names in the catalog still apply.
    return { ...catalog, artifactVerified: false, artifactSkipped: "src-app-artifact" };
  }
  const artifact = await readFile(artifactPath);
  const anchors = [
    ...catalog.mount.anchors,
    catalog.runtimeAcquisition.desktop,
    catalog.runtimeAcquisition.coordinatorPort,
    ...catalog.providerOrder.map(({ anchor, byteOffset }) => ({ needle: anchor, byteOffset })),
  ];
  for (const anchor of anchors) {
    const actual = artifact.indexOf(Buffer.from(anchor.needle));
    if (actual !== anchor.byteOffset) {
      throw new Error(`Renderer bootstrap anchor drifted: ${anchor.needle} (expected ${anchor.byteOffset}, found ${actual})`);
    }
  }
  return { ...catalog, artifactVerified: true };
}

export async function validateCleanGraph() {
  const result = await esbuild({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: [path.join(repoRoot, rendererProductionEntrypoint)],
    format: "esm",
    // The graph audit only needs every asset to resolve so it shows up as an
    // input; how it would be emitted is Vite's business, not esbuild's.
    loader: { ".css": "empty", ".woff2": "dataurl", ".wav": "dataurl" },
    logLevel: "silent",
    metafile: true,
    platform: "browser",
    write: false,
  });
  const inputs = Object.keys(result.metafile.inputs).map(input => normalize(path.relative(repoRoot, path.resolve(repoRoot, input)))).sort();
  const forbiddenInputs = inputs.filter(input => isForbiddenRendererGraphInput(input));
  if (forbiddenInputs.length > 0) throw new Error(`Clean renderer graph reaches immutable evidence: ${forbiddenInputs.join(", ")}`);
  return { entrypoint: rendererProductionEntrypoint, inputs, forbiddenInputs };
}

async function validateEvidenceClosure() {
  if (!existsSync(path.join(repoRoot, "recovered", "frontend", "reports", "imports.tsv"))) {
    const closure = await readJson("manifests/reconstruction/renderer-closure.json");
    if (closure.schemaVersion !== 1 || closure.verdict?.canReplaceShippedBundleWithoutFeatureLoss !== true) {
      throw new Error("Checked renderer closure does not authorize the clean source renderer.");
    }
    if (closure.summary?.high !== 0 || closure.summary?.findings !== 0 || closure.summary?.composedFeatureSurfaces !== 5 || closure.summary?.shippedFeatureRoutes !== 11) {
      throw new Error("Checked renderer closure is incomplete.");
    }
    if (!Array.isArray(closure.routes) || closure.routes.length !== 11 || closure.routes.some((route) => route.reviewed !== true || route.cleanComposition !== "present")) {
      throw new Error("Checked renderer routes are incomplete.");
    }
    const uiCatalog = await readJson("frontend/manifests/ui-evidence-anchors.json");
    if (uiCatalog.schemaVersion !== 1 || !Array.isArray(uiCatalog.entries) || uiCatalog.entries.length === 0) {
      throw new Error("Checked renderer UI catalog is invalid.");
    }
    const cleanPaths = new Set();
    let anchorCount = 0;
    for (const entry of uiCatalog.entries) {
      if (typeof entry.cleanPath !== "string" || cleanPaths.has(entry.cleanPath) || !Array.isArray(entry.anchors) || entry.anchors.length === 0) {
        throw new Error("Checked renderer UI catalog has a missing, duplicate, or empty source entry.");
      }
      cleanPaths.add(entry.cleanPath);
      await readFile(path.join(repoRoot, entry.cleanPath));
      for (const anchor of entry.anchors) {
        if (typeof anchor.value !== "string" || anchor.value.length === 0 || typeof anchor.artifact !== "string") {
          throw new Error(`Checked renderer UI catalog has an invalid anchor: ${entry.cleanPath}`);
        }
        // Recovery registries are historical annotation sources and are
        // intentionally omitted from the clean publication tree. Checked-in
        // publication registries remain live build inputs and must exist.
        if (anchor.registry != null && !anchor.registry.startsWith("recovered/")) await readFile(path.join(repoRoot, anchor.registry));
        anchorCount += 1;
      }
    }
    if (anchorCount !== closure.summary.uiAnchors) throw new Error("Checked renderer UI anchor count differs from the closure report.");
    return { closure, ui: { summary: { catalogErrors: 0, findings: 0 }, source: "checked-publication-catalog" } };
  }
  const [closure, ui] = await Promise.all([auditRendererClosure(repoRoot), auditUiProvenance(repoRoot)]);
  if (!closure.verdict.canReplaceShippedBundleWithoutFeatureLoss || closure.summary.high !== 0 || closure.summary.findings !== 0) {
    throw new Error(`Renderer closure is not green: ${closure.summary.high} high / ${closure.summary.findings} findings`);
  }
  if (closure.summary.composedFeatureSurfaces !== 5 || closure.summary.shippedFeatureRoutes !== 11 || closure.summary.shippedRoutesAbsentFromCleanComposition !== 0) {
    throw new Error("Renderer closure no longer covers the exact 5 feature surfaces and 11 shipped routes");
  }
  if (ui.summary.catalogErrors !== 0 || ui.summary.findings !== 0) {
    throw new Error(`Renderer UI provenance is not green: ${ui.summary.catalogErrors} catalog errors / ${ui.summary.findings} findings`);
  }
  return { closure: rendererClosureSnapshot(closure), ui };
}

/**
 * Vite can describe the HTML entry as its own dynamic import when manifest
 * generation sees the HTML shell. It is not a JavaScript lazy boundary and
 * must not be exposed as one in the authoritative renderer manifest.
 */
export function normalizeRendererManifestDynamicImports(manifest) {
  const entry = manifest?.["index.html"];
  if (entry != null && Array.isArray(entry.dynamicImports)) {
    entry.dynamicImports = entry.dynamicImports.filter((candidate) => candidate !== "index.html");
  }
  return manifest;
}

async function emittedRecords(rendererRoot, exemptBannerPaths = new Set()) {
  const records = [];
  for (const relative of await walk(rendererRoot)) {
    if (relative === "renderer-source-provenance.json") continue;
    const bytes = await readFile(path.join(rendererRoot, relative));
    if (/\.(?:html|js|css|json)$/.test(relative)) {
      const text = bytes.toString("utf8");
      if (relative.endsWith(".js") && !text.includes(deterministicBanner) && !exemptBannerPaths.has(relative)) {
        throw new Error(`Emitted renderer chunk lacks the clean-source banner: ${relative}`);
      }
    }
    records.push({ path: `${rendererProductionOutput}/${relative}`, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  return records;
}

export async function buildProductionRenderer({ outputRoot }) {
  if (typeof outputRoot !== "string" || outputRoot.length === 0) throw new TypeError("buildProductionRenderer requires outputRoot");
  if (!existsSync(path.join(repoRoot, rendererProductionEntrypoint))) {
    throw new Error(`Vite renderer build requires ${rendererProductionEntrypoint} (restore frontend/ from stow)`);
  }
  const rendererRoot = path.join(outputRoot, rendererProductionOutput);
  const [bootstrap, graph, evidence] = await Promise.all([
    validateBootstrapEvidence(),
    validateCleanGraph(),
    validateEvidenceClosure(),
  ]);
  await rm(rendererRoot, { recursive: true, force: true });
  await viteBuild({
    base: "./",
    configFile: false,
    root: path.join(repoRoot, "frontend"),
    publicDir: false,
    plugins: [react(), {
      name: "renderer-clean-source-banner",
      enforce: "post",
      renderChunk(code) {
        return { code: `${deterministicBanner}\n${code}`, map: null };
      },
    }],
    build: {
      assetsDir: "assets",
      emptyOutDir: true,
      manifest: true,
      minify: "esbuild",
      outDir: rendererRoot,
      reportCompressedSize: false,
      sourcemap: false,
      // index.html pins `media-src 'self' sand-media:`, so an inlined `data:`
      // audio asset would be blocked by the renderer's own CSP. This build
      // passes `configFile: false`, so frontend/vite.config.ts cannot supply it.
      assetsInlineLimit: filePath => filePath.endsWith(".wav") ? false : undefined,
    },
    logLevel: "silent",
  });
  const { copied: assets, skipped: skippedAssets } = await copyRuntimeAssets(rendererRoot);
  const katex = await copyKatexRuntimeAssets(rendererRoot);
  const pdfAssetRewrite = await rewritePdfAssetReferences(rendererRoot);
  const viteManifest = normalizeRendererManifestDynamicImports(JSON.parse(await readFile(path.join(rendererRoot, ".vite", "manifest.json"), "utf8")));
  await writeFile(path.join(rendererRoot, ".vite", "manifest.json"), `${JSON.stringify(viteManifest, null, 2)}\n`);
  const emittedLazyEntries = [...(viteManifest["index.html"]?.dynamicImports ?? [])].sort();
  const expectedLazyEntries = bootstrap.lazyBoundaries.map(boundary => boundary.cleanDynamicEntry).sort();
  if (JSON.stringify(emittedLazyEntries) !== JSON.stringify(expectedLazyEntries)) {
    throw new Error(`Renderer lazy boundaries drifted; expected ${expectedLazyEntries.join(",")}, emitted ${emittedLazyEntries.join(",")}`);
  }
  for (const entry of emittedLazyEntries) {
    if (viteManifest[entry]?.isDynamicEntry !== true) throw new Error(`Renderer lazy boundary is not independently emitted: ${entry}`);
  }
  const outputs = await emittedRecords(rendererRoot, new Set(assets.map(({ file }) => `assets/${file}`)));
  const provenance = {
    schemaVersion: 1,
    runtime: "renderer",
    mode: "clean-source",
    entrypoint: rendererProductionEntrypoint,
    graph,
    evidence: {
      closureSha256: sha256(Buffer.from(JSON.stringify(evidence.closure))),
      closureSummary: evidence.closure.summary,
      routeContracts: evidence.closure.routes.map(({ route, family, kind, reviewed, cleanComposition }) => ({ route, family, kind, reviewed, cleanComposition })),
      uiSummary: evidence.ui.summary,
      bootstrap,
      emittedLazyEntries,
      pdfAssetRewrite,
    },
    assets,
    skippedAssets,
    katex,
    outputs,
  };
  const provenancePath = path.join(outputRoot, rendererProductionProvenance);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  const provenanceBytes = await readFile(provenancePath);
  return {
    outputRoot,
    rendererRoot,
    provenance,
    provenancePath,
    outputs: [...outputs, { path: rendererProductionProvenance, bytes: provenanceBytes.byteLength, sha256: sha256(provenanceBytes) }].sort((left, right) => left.path.localeCompare(right.path)),
  };
}
