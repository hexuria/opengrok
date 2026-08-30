#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

export const RENDERER_CLOSURE_INPUTS = Object.freeze({
  cleanEntry: "frontend/src/main.tsx",
  cleanRoot: "frontend/src",
  immutableRenderer: "src/app/dist/renderer",
  expandedMain: "recovered/frontend/app/assets/index-UbX-y3il.js",
  shippedMain: "src/app/dist/renderer/assets/index-UbX-y3il.js",
  assetManifest: "recovered/frontend/reports/manifest.json",
  importInventory: "recovered/frontend/reports/imports.tsv",
  jsxCandidates: "recovered/frontend/reports/react-component-candidates.tsv",
  featureReport: "recovered/frontend/reports/features.json",
  componentNames: "frontend/manifests/component-names.json",
  conversationBindings: "frontend/manifests/conversation-evidence.json",
  semanticSymbols: "frontend/manifests/semantic-symbols.json",
  uiAnchors: "frontend/manifests/ui-evidence-anchors.json",
  checkedReport: "manifests/reconstruction/renderer-closure.json",
});

const CLEAN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".css"];
// These renderer contracts consume existing shared first-party owners. They
// live outside frontend/src because host/preload consumers use the same
// protocol definitions; keep them in the closure graph instead of copying
// validators or event descriptions into renderer-local shims.
const CLEAN_SHARED_DEPENDENCIES = [
  "source/shared/rpc/coordinator.ts",
  "source/shared/sand-timeline-events.ts",
];
const ROUTE_PATTERN = /\.\/features\/[A-Za-z0-9_./-]+\/(?:entrypoint\.ts|view\.tsx)/g;

function slash(value) { return value.split(path.sep).join("/"); }
function unique(values) { return [...new Set(values)]; }
function byPath(left, right) { return left.path.localeCompare(right.path); }

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function walk(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

export function exactLocation(text, token, fromIndex = 0) {
  const index = text.indexOf(token, fromIndex);
  if (index < 0) return null;
  const before = text.slice(0, index);
  const lastNewline = before.lastIndexOf("\n");
  return {
    utf8ByteOffset: Buffer.byteLength(before),
    utf16Offset: index,
    line: before.split("\n").length,
    column: index - lastNewline,
    length: token.length,
  };
}

export function allExactLocations(text, token, limit = 8) {
  const locations = [];
  let cursor = 0;
  while (locations.length < limit) {
    const location = exactLocation(text, token, cursor);
    if (location == null) break;
    locations.push(location);
    cursor = location.utf16Offset + Math.max(1, token.length);
  }
  return locations;
}

export function parseCleanImports(source) {
  const imports = [];
  const seen = new Set();
  const add = (specifier, kind, typeOnly, index) => {
    const key = `${kind}\0${specifier}\0${index}`;
    if (!seen.has(key)) { seen.add(key); imports.push({ specifier, kind, typeOnly, index }); }
  };
  for (const match of source.matchAll(/(?<!@)\bimport\s+(type\s+)?(?:[\w*$,\s{}]+?\s+from\s+)?["']([^"']+)["']/g)) {
    add(match[2], "static", match[1] != null, match.index);
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) add(match[1], "dynamic", false, match.index);
  for (const match of source.matchAll(/\bexport\s+(type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/g)) {
    add(match[2], "reexport", match[1] != null, match.index);
  }
  // CSS is part of the renderer graph too: workspace/view.css imports the
  // PDF leaf with the standard url() form. Treat stylesheet imports as
  // runtime edges while leaving TS/TSX type-only imports non-runtime.
  for (const match of source.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?/g)) {
    add(match[1], "style", false, match.index);
  }
  return imports.sort((left, right) => left.index - right.index);
}

function resolveCleanImport(importer, specifier, fileSet) {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = path.posix.extname(base) === ""
    ? [...CLEAN_EXTENSIONS.map((extension) => `${base}${extension}`), ...CLEAN_EXTENSIONS.map((extension) => `${base}/index${extension}`)]
    : [base];
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

export async function buildCleanImportGraph(repoRoot, entry = RENDERER_CLOSURE_INPUTS.cleanEntry) {
  const root = path.join(repoRoot, RENDERER_CLOSURE_INPUTS.cleanRoot);
  const frontendFiles = (await walk(root))
    .map((file) => slash(path.relative(repoRoot, file)))
    .filter((file) => CLEAN_EXTENSIONS.includes(path.posix.extname(file)))
    .sort();
  const sharedFiles = [];
  for (const relative of CLEAN_SHARED_DEPENDENCIES) {
    try {
      await readFile(path.join(repoRoot, relative));
      sharedFiles.push(relative);
    } catch {
      // The import remains unresolved when the canonical shared owner is absent.
    }
  }
  const files = [...frontendFiles, ...sharedFiles].sort();
  const fileSet = new Set(files);
  const sourceByPath = new Map(await Promise.all(files.map(async (file) => [file, await readFile(path.join(repoRoot, file), "utf8")])));
  const edges = [];
  const unresolved = [];
  for (const file of files) {
    const source = sourceByPath.get(file) ?? "";
    for (const item of parseCleanImports(source)) {
      if (!item.specifier.startsWith(".")) continue;
      const target = resolveCleanImport(file, item.specifier, fileSet);
      const edge = { from: file, to: target, specifier: item.specifier, kind: item.kind, typeOnly: item.typeOnly };
      edges.push(edge);
      if (target == null) unresolved.push(edge);
    }
  }
  const runtimeEdges = edges.filter((edge) => !edge.typeOnly && edge.to != null);
  const outgoing = new Map();
  for (const edge of runtimeEdges) {
    const values = outgoing.get(edge.from) ?? [];
    values.push(edge.to);
    outgoing.set(edge.from, values);
  }
  const reachable = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || reachable.has(current) || !fileSet.has(current)) continue;
    reachable.add(current);
    queue.push(...(outgoing.get(current) ?? []));
  }
  return { entry, files, fileSet, sourceByPath, edges, unresolved, reachable };
}

function parseTsv(text) {
  const [header = "", ...lines] = text.trimEnd().split("\n");
  const keys = header.split("\t");
  return lines.filter(Boolean).map((line) => Object.fromEntries(line.split("\t").map((value, index) => [keys[index], value])));
}

function artifactPathFromRecovered(value) {
  return value?.replace(/^recovered\/frontend\/app\//, "src/app/dist/renderer/") ?? null;
}

function cleanFeatureFamily(cleanPath) {
  return cleanPath.match(/^frontend\/src\/recovered\/features\/([^/]+)\//)?.[1] ?? null;
}

function routeFeatureFamily(route) {
  return route.match(/^\.\/features\/([^/]+)\//)?.[1] ?? null;
}

function anchorVariants(anchor) {
  const value = typeof anchor === "string" ? anchor : anchor.value;
  const category = typeof anchor === "string" ? null : anchor.category;
  if (category === "selector" && /^[.#]/.test(value)) return [value, value.slice(1)];
  return [value];
}

function sourceContainsAnchor(source, anchor) {
  return anchorVariants(anchor).some((value) => source.includes(value));
}

function evidenceLocations(text, anchor) {
  const variants = anchorVariants(anchor)
    .map((value, order) => ({ value, order }))
    .sort((left, right) => right.value.length - left.value.length || left.order - right.order);
  const matches = variants.flatMap(({ value, order }) => allExactLocations(text, value).map((location) => ({ ...location, order })));
  const selected = [];
  for (const match of matches.sort((left, right) => left.utf16Offset - right.utf16Offset || right.length - left.length || left.order - right.order)) {
    const matchEnd = match.utf16Offset + match.length;
    if (selected.some((existing) => match.utf16Offset < existing.utf16Offset + existing.length && existing.utf16Offset < matchEnd)) continue;
    const { order: _order, ...location } = match;
    selected.push(location);
  }
  return selected;
}

function makeFinding(code, severity, confidence, category, subject, message, evidence, remediation) {
  return { code, severity, confidence, category, subject, message, evidence, remediation };
}

function cleanModuleKind(cleanPath, source) {
  if (cleanPath.endsWith(".css")) return "ui-style";
  if (cleanPath.endsWith(".tsx")) return "ui-or-wrapper";
  if (/\/entrypoint\.ts$/.test(cleanPath)) return "feature-entrypoint";
  if (/\/(?:desktop-preview|catalog|runtime\/entrypoints)\.[jt]sx?$/.test(cleanPath)) return "registry-or-preview";
  const withoutTypes = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*(?:export\s+)?(?:interface|type)\b[^\n]*(?:\n\s+[^\n]+)*?/gm, "");
  return /\b(?:function|class|const|let|var)\b/.test(withoutTypes) ? "runtime-library" : "type-contract";
}

// These are deliberately exact paths, rather than namespace-wide waivers. They
// describe recovered support surfaces which are proven by the current source
// graph and existing tests to be developer/catalog/contract infrastructure. A
// path not listed here remains a product orphan and must be investigated on its
// own evidence; this helper does not change reachability or findings.
const INTENTIONAL_ORPHAN_POLICIES = Object.freeze({
  "frontend/src/dev/dev-shell.css": {
    classification: "intentional-dev",
    disposition: "retain-unreachable",
    reason: "Developer-shell styling has no production entry edge and belongs only to the opt-in DevShell surface.",
    removalPrerequisites: ["remove the DevShell entry surface and its preview controls"],
  },
  "frontend/src/dev/DevShell.tsx": {
    classification: "intentional-dev",
    disposition: "retain-unreachable",
    reason: "DevShell is an opt-in reconstruction inspector, not the production renderer entry.",
    removalPrerequisites: ["remove the development launcher/control route and its integration tests"],
  },
  "frontend/src/dev/dom-inspector.ts": {
    classification: "intentional-dev",
    disposition: "retain-unreachable",
    reason: "DOM inspection is only consumed by DevShell's developer tooling.",
    removalPrerequisites: ["remove DevShell's inspector controls and catalog capture flow"],
  },
  "frontend/src/env.d.ts": {
    classification: "intentional-type-support",
    disposition: "retain-unreachable",
    reason: "The declaration file contributes Window/Root type contracts and no runtime edge.",
    removalPrerequisites: ["remove every declared global contract and its TypeScript consumers"],
  },
  "frontend/src/recovered/catalog.ts": {
    classification: "intentional-catalog",
    disposition: "retain-unreachable",
    reason: "The recovered boundary catalog is an inspector lookup used by DevShell, not a product view.",
    removalPrerequisites: ["remove component-names evidence and DevShell boundary inspection"],
  },
  "frontend/src/recovered/contracts/main-rpc.ts": {
    classification: "intentional-contract-support",
    disposition: "retain-unreachable",
    reason: "The main-RPC method/event table is a typed edge contract exercised by contract tests, not a renderer view.",
    removalPrerequisites: ["remove the main-RPC contract consumers and their protocol tests"],
  },
  "frontend/src/recovered/contracts/rpc-edge.ts": {
    classification: "intentional-contract-support",
    disposition: "retain-unreachable",
    reason: "The generic RPC edge envelope/channel helpers are protocol support without a production UI consumer.",
    removalPrerequisites: ["remove the edge transport contract and all protocol tests"],
  },
  "frontend/src/recovered/features/access/cover/rebuild-signal.ts": {
    classification: "intentional-dev-control",
    disposition: "retain-unreachable",
    reason: "The payloadless dev-box-rebuild listener is a developer-control seam; production AccessCover consumes the typed computer-rebuild stores instead.",
    removalPrerequisites: ["remove the dev-box-rebuild preload event and its signal lifecycle tests"],
  },
  "frontend/src/recovered/features/conversation/workspace/conversation-workspace-controller.ts": {
    classification: "intentional-composition-duplicate",
    disposition: "retain-unreachable",
    reason: "The root composes the same reply, pagination, and reaction owners directly; this aggregate controller is a tested non-root compatibility composition.",
    removalPrerequisites: ["consolidate or remove its non-root controller consumers and focused lifecycle tests"],
  },
  "frontend/src/recovered/features/conversation/workspace/view.tsx": {
    classification: "intentional-dev-preview",
    disposition: "retain-unreachable",
    reason: "The standalone workspace preview is an explicit null/evidence boundary rendered only by DevShell; the production root renders the workspace inline.",
    removalPrerequisites: ["remove the DevShell conversation preview control and its evidence-boundary test"],
  },
  "frontend/src/recovered/features/root-resilience/connection-state.tsx": {
    classification: "intentional-compatibility-wrapper",
    disposition: "retain-unreachable",
    reason: "This same-stem TSX wrapper re-exports the controller and preserves the shipped host shape; ProductionRenderer imports the source-compatible .ts host directly.",
    removalPrerequisites: ["remove the compatibility export and the TSX host provenance test after all consumers migrate"],
  },
  "frontend/src/recovered/features/hidden-chats/overlay/entrypoint.ts": {
    classification: "intentional-route-metadata",
    disposition: "retain-unreachable",
    reason: "The entrypoint is the recovered lazy-route metadata boundary; the mounted root uses the semantic view directly.",
    removalPrerequisites: ["remove the immutable Hidden Chats route metadata and lazy-entry contract"],
  },
  "frontend/src/recovered/features/plugins/overlay/desktop-preview.tsx": {
    classification: "intentional-dev-preview",
    disposition: "retain-unreachable",
    reason: "This is a compatibility export for the opt-in DevShell preview; production uses PluginsDesktopSurface.",
    removalPrerequisites: ["remove the DevShell Plugins preview and compatibility export"],
  },
  "frontend/src/recovered/features/plugins/overlay/entrypoint.ts": {
    classification: "intentional-route-metadata",
    disposition: "retain-unreachable",
    reason: "The entrypoint records the shipped Plugins lazy route while the production root composes its recovered surface directly.",
    removalPrerequisites: ["remove the immutable Plugins route metadata and lazy-entry contract"],
  },
  "frontend/src/recovered/features/settings/overlay/desktop-preview.tsx": {
    classification: "intentional-dev-preview",
    disposition: "retain-unreachable",
    reason: "This is a compatibility export for the opt-in DevShell preview; production uses SettingsDesktopSurface.",
    removalPrerequisites: ["remove the DevShell Settings preview and compatibility export"],
  },
  "frontend/src/recovered/features/settings/overlay/entrypoint.ts": {
    classification: "intentional-route-metadata",
    disposition: "retain-unreachable",
    reason: "The entrypoint records the shipped Settings lazy route while the production root composes its recovered surface directly.",
    removalPrerequisites: ["remove the immutable Settings route metadata and lazy-entry contract"],
  },
  "frontend/src/recovered/runtime/coordinator-source-claimant.ts": {
    classification: "intentional-contract-support",
    disposition: "retain-unreachable",
    reason: "The claimant is an independently tested coordinator-port ownership adapter, not an additional renderer route.",
    removalPrerequisites: ["remove the coordinator-source claimant contract and its lifecycle tests"],
  },
  "frontend/src/recovered/runtime/coordinator-source.ts": {
    classification: "intentional-contract-support",
    disposition: "retain-unreachable",
    reason: "The source adapter is the typed coordinator transport boundary; type-only production imports do not create a runtime graph edge.",
    removalPrerequisites: ["remove the typed coordinator source boundary and every adapter/controller consumer"],
  },
  "frontend/src/recovered/runtime/entrypoints.ts": {
    classification: "intentional-catalog",
    disposition: "retain-unreachable",
    reason: "The recovered entrypoint registry is displayed by DevShell and mirrors immutable route metadata.",
    removalPrerequisites: ["remove DevShell's recovered-entrypoint catalog and route metadata tests"],
  },
  "frontend/src/upstream.ts": {
    classification: "intentional-dev-bootstrap",
    disposition: "retain-unreachable",
    reason: "The manifest bootstrap is an alternate development loader and is explicitly excluded from production main.",
    removalPrerequisites: ["remove the development manifest server and upstream bootstrap path"],
  },
});

export function classifyOrphanPolicy(cleanPath) {
  return INTENTIONAL_ORPHAN_POLICIES[cleanPath] ?? {
    classification: "genuine-product-orphan",
    disposition: "investigate",
    reason: "No exact intentional dev/catalog/type-support policy applies; retain as a production-gap candidate until its consumer is resolved.",
    removalPrerequisites: ["trace immutable consumer, producer/protocol, and production composition before removal or mounting"],
  };
}

export function immutableEvidence(pathValue, anchor, sourceByArtifact) {
  const text = sourceByArtifact.get(pathValue);
  const token = typeof anchor === "string" ? anchor : anchor.value;
  const locations = text == null ? [] : evidenceLocations(text, anchor);
  return { artifact: pathValue, token, occurrences: locations.length, locations };
}

function expandedLine(text, token) {
  const location = exactLocation(text, token);
  return location?.line ?? null;
}

function candidateForPoint(candidates, line, symbol = null) {
  const matches = candidates.filter((candidate) => candidate.startLine <= line && line <= candidate.endLine);
  const exact = symbol == null ? null : matches.find((candidate) => candidate.name === symbol);
  return exact ?? matches.sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine))[0] ?? null;
}

function definitionEvidence(shippedMainText, candidate) {
  const patterns = [`function ${candidate.name}(`, `const ${candidate.name}=`, `let ${candidate.name}=`, `var ${candidate.name}=`];
  for (const token of patterns) {
    const locations = allExactLocations(shippedMainText, token, 2);
    if (locations.length > 0) return { token, locations };
  }
  return { token: candidate.name, locations: allExactLocations(shippedMainText, candidate.name, 2) };
}

function cleanIpcClaims(graph) {
  const claims = [];
  const seen = new Set();
  for (const cleanPath of [...graph.reachable].sort()) {
    const source = graph.sourceByPath.get(cleanPath) ?? "";
    for (const match of source.matchAll(/\bclient\.(call|subscribe)\(\s*["']([^"']+)["']/g)) {
      const key = `coordinator-${match[1]}\0${match[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        claims.push({ kind: `coordinator-${match[1]}`, value: match[2], cleanPath, line: source.slice(0, match.index).split("\n").length });
      }
    }
    for (const match of source.matchAll(/\bbridge\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)) {
      const value = match[1];
      const key = `desktop-bridge\0${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        claims.push({ kind: "desktop-bridge", value, cleanPath, line: source.slice(0, match.index).split("\n").length });
      }
    }
  }
  return claims.sort((left, right) => left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value));
}

export async function auditRendererClosure(repoRoot = DEFAULT_REPO_ROOT) {
  const absolute = (relative) => path.join(repoRoot, relative);
  const [graph, assetManifest, importText, candidateText, featureReport, componentNames, conversationBindings, semanticSymbols, anchorCatalog, shippedMainText, expandedMainText] = await Promise.all([
    buildCleanImportGraph(repoRoot),
    readJson(absolute(RENDERER_CLOSURE_INPUTS.assetManifest), { files: [] }),
    readFile(absolute(RENDERER_CLOSURE_INPUTS.importInventory), "utf8"),
    readFile(absolute(RENDERER_CLOSURE_INPUTS.jsxCandidates), "utf8"),
    readJson(absolute(RENDERER_CLOSURE_INPUTS.featureReport), { features: [], evidence: null }),
    readJson(absolute(RENDERER_CLOSURE_INPUTS.componentNames), { components: [], entry: null }),
    readJson(absolute(RENDERER_CLOSURE_INPUTS.conversationBindings), { bindings: [], entry: null }),
    readJson(absolute(RENDERER_CLOSURE_INPUTS.semanticSymbols), { modules: [] }),
    readJson(absolute(RENDERER_CLOSURE_INPUTS.uiAnchors), { entries: [] }),
    readFile(absolute(RENDERER_CLOSURE_INPUTS.shippedMain), "utf8"),
    readFile(absolute(RENDERER_CLOSURE_INPUTS.expandedMain), "utf8"),
  ]);

  const findings = [];
  const reachableUnresolved = graph.unresolved.filter((edge) => graph.reachable.has(edge.from));
  for (const edge of reachableUnresolved) {
    findings.push(makeFinding("unresolved-clean-import", "high", "high", "clean-import", edge.from, `Relative ${edge.kind} import does not resolve inside the clean frontend graph.`, edge, "Restore the evidenced module or remove the unresolved edge before treating the clean renderer as closed."));
  }

  const immutableFiles = (await walk(absolute(RENDERER_CLOSURE_INPUTS.immutableRenderer))).sort();
  const sourceByArtifact = new Map();
  for (const file of immutableFiles) {
    if (![".js", ".mjs", ".css", ".html", ".svg"].includes(path.extname(file))) continue;
    sourceByArtifact.set(slash(path.relative(repoRoot, file)), await readFile(file, "utf8"));
  }

  const anchors = [];
  for (const entry of anchorCatalog.entries ?? []) {
    const cleanSource = graph.sourceByPath.get(entry.cleanPath);
    for (const anchor of entry.anchors ?? []) {
      const artifactSource = sourceByArtifact.get(anchor.artifact);
      const valid = cleanSource != null && artifactSource != null && sourceContainsAnchor(cleanSource, anchor) && anchorVariants(anchor).some((value) => artifactSource.includes(value));
      const record = { cleanPath: entry.cleanPath, ...anchor, valid, cleanReachable: graph.reachable.has(entry.cleanPath), evidence: immutableEvidence(anchor.artifact, anchor, sourceByArtifact) };
      anchors.push(record);
      if (!valid) findings.push(makeFinding("invalid-ui-anchor", "high", "high", "ui-anchor", entry.cleanPath, "A catalog anchor does not resolve in both clean source and immutable evidence.", record, "Repair or remove the invalid anchor; it cannot contribute to renderer closure."));
    }
  }

  const features = [];
  for (const feature of featureReport.features ?? []) {
    const family = routeFeatureFamily(feature.entrypoint);
    const cleanModules = graph.files.filter((cleanPath) => cleanFeatureFamily(cleanPath) === family);
    const reachableModules = cleanModules.filter((cleanPath) => graph.reachable.has(cleanPath));
    const routeEvidence = immutableEvidence(RENDERER_CLOSURE_INPUTS.shippedMain, feature.entrypoint, sourceByArtifact);
    const viewEvidence = immutableEvidence(RENDERER_CLOSURE_INPUTS.shippedMain, feature.view, sourceByArtifact);
    const chunkToken = `./${path.posix.basename(feature.chunk)}`;
    const chunkEvidence = immutableEvidence(RENDERER_CLOSURE_INPUTS.shippedMain, chunkToken, sourceByArtifact);
    const status = reachableModules.length > 0 ? "composed" : "artifact-only";
    const record = { id: feature.id, name: feature.name, family, status, recovery: feature.recovery, cleanModules, reachableModules, originalEntrypoint: feature.entrypoint, originalView: feature.view, productionChunk: feature.chunk, evidence: { route: routeEvidence, view: viewEvidence, chunkImport: chunkEvidence } };
    features.push(record);
    if (status === "artifact-only") {
      findings.push(makeFinding("artifact-only-product-surface", "high", "high", "reviewed-feature-surface", feature.id, `${feature.name} is a reviewed shipped feature whose clean modules are unreachable from frontend/src/main.tsx.`, record.evidence, "Compose the already-recovered feature through an evidence-backed production route, or retain the shipped renderer; do not invent a replacement surface."));
    }
  }

  const routeMatches = unique([...shippedMainText.matchAll(ROUTE_PATTERN)].map((match) => match[0])).sort();
  const reviewedFamilies = new Set(features.map((feature) => feature.family));
  const conversationMainArtifact = artifactPathFromRecovered(conversationBindings.entry);
  const conversationComposed = conversationMainArtifact === RENDERER_CLOSURE_INPUTS.shippedMain
    && [...graph.reachable].some((cleanPath) => cleanFeatureFamily(cleanPath) === "conversation")
    && anchors.some((anchor) => anchor.valid && anchor.cleanReachable && cleanFeatureFamily(anchor.cleanPath) === "conversation" && anchor.artifact === conversationMainArtifact);
  const routes = routeMatches.map((route) => {
    const family = routeFeatureFamily(route);
    const composed = family === "chat" ? conversationComposed : features.some((feature) => feature.family === family && feature.status === "composed");
    return { route, family, kind: route.endsWith("entrypoint.ts") ? "entrypoint" : "view", reviewed: family === "chat" || reviewedFamilies.has(family), cleanComposition: composed ? "present" : "absent", evidence: immutableEvidence(RENDERER_CLOSURE_INPUTS.shippedMain, route, sourceByArtifact) };
  });
  for (const route of routes.filter((record) => record.reviewed && record.cleanComposition === "absent")) {
    findings.push(makeFinding("shipped-route-absent-from-clean-composition", "high", "high", "shipped-route", route.route, "A reviewed shipped feature route has no reachable clean composition.", route.evidence, "Connect the corresponding recovered entry/view using the shipped route contract, or preserve this as an explicit replacement blocker."));
  }

  const reachedFamilies = unique([...graph.reachable].map(cleanFeatureFamily).filter(Boolean)).sort();
  const cleanRoutesWithoutEvidence = reachedFamilies.filter((family) => {
    if (family === "conversation") return !conversationComposed;
    return !features.some((feature) => feature.family === family) && !anchors.some((anchor) => anchor.valid && anchor.cleanReachable && cleanFeatureFamily(anchor.cleanPath) === family);
  });
  for (const family of cleanRoutesWithoutEvidence) {
    findings.push(makeFinding("clean-feature-without-shipped-evidence", "high", "high", "clean-route", family, "A reachable clean feature family has neither a reviewed shipped route nor a validated immutable UI anchor.", { family, reachableModules: [...graph.reachable].filter((cleanPath) => cleanFeatureFamily(cleanPath) === family) }, "Remove the unevidenced composition or attach it to exact immutable route/UI evidence."));
  }

  const reachableSources = [...graph.reachable].map((cleanPath) => ({ cleanPath, source: graph.sourceByPath.get(cleanPath) ?? "" }));
  const reviewedComponents = (componentNames.components ?? []).map((component) => {
    const selectorToken = component.selector.replace(/^[.#]/, "");
    const cleanMatches = reachableSources.filter(({ source }) => source.includes(component.selector) || source.includes(selectorToken)).map(({ cleanPath }) => cleanPath).sort();
    const evidence = immutableEvidence(RENDERER_CLOSURE_INPUTS.shippedMain, component.selector, sourceByArtifact);
    return { ...component, cleanComposition: cleanMatches.length > 0 ? "present" : "absent", cleanMatches, evidence };
  });
  for (const component of reviewedComponents.filter((record) => record.cleanComposition === "absent")) {
    findings.push(makeFinding("artifact-only-reviewed-component", "high", "high", "reviewed-component", component.name, `${component.name} has a reviewed shipped selector/binding but no matching selector in the reachable clean graph.`, component.evidence, "Recover and compose this reviewed component from its exact artifact region, or retain it as an explicit feature-loss blocker."));
  }

  const candidates = parseTsv(candidateText).map((record) => ({
    name: record.name,
    kind: record.kind,
    startLine: Number.parseInt(record.start_line, 10),
    endLine: Number.parseInt(record.end_line, 10),
    jsxCalls: Number.parseInt(record.jsx_calls, 10),
    createElementCalls: Number.parseInt(record.create_element_calls, 10),
  }));
  const candidateLinks = new Map();
  const linkCandidate = (candidate, link) => {
    if (candidate == null) return;
    const values = candidateLinks.get(candidate) ?? [];
    values.push(link);
    candidateLinks.set(candidate, values);
  };
  for (const component of componentNames.components ?? []) linkCandidate(candidateForPoint(candidates, component.line, component.symbol), { kind: "reviewed-component", name: component.name, symbol: component.symbol, line: component.line });
  for (const binding of conversationBindings.bindings ?? []) linkCandidate(candidateForPoint(candidates, binding.line, binding.symbol), { kind: "reviewed-binding", name: binding.name, symbol: binding.symbol, line: binding.line });
  for (const anchor of anchors.filter((record) => record.valid && record.artifact === RENDERER_CLOSURE_INPUTS.shippedMain)) {
    const line = expandedLine(expandedMainText, anchor.value.replace(/^[.#]/, ""));
    if (line != null) linkCandidate(candidateForPoint(candidates, line), { kind: "validated-ui-anchor", cleanPath: anchor.cleanPath, value: anchor.value, line });
  }
  const linkedCandidates = [...candidateLinks.entries()].map(([candidate, links]) => ({ ...candidate, links, shippedDefinition: definitionEvidence(shippedMainText, candidate), cleanComposition: links.some((link) => link.kind === "validated-ui-anchor" ? anchors.some((anchor) => anchor.cleanPath === link.cleanPath && anchor.cleanReachable) : link.kind === "reviewed-component" ? reviewedComponents.some((component) => component.name === link.name && component.cleanComposition === "present") : false) ? "present" : "not-demonstrated" })).sort((left, right) => left.startLine - right.startLine);

  const importRows = parseTsv(importText).map((row) => ({ source: row.source, kind: row.kind, target: row.target }));
  const mainAsset = featureReport.evidence ?? path.posix.basename(RENDERER_CLOSURE_INPUTS.shippedMain);
  const mainReportPath = mainAsset.startsWith("assets/") ? mainAsset : `assets/${mainAsset}`;
  const mainDynamicTargets = new Set(importRows.filter((row) => row.source === mainReportPath && row.kind === "dynamic").map((row) => path.posix.normalize(path.posix.join(path.posix.dirname(row.source), row.target))));
  const reviewedAssetPaths = new Set([mainReportPath]);
  for (const feature of featureReport.features ?? []) {
    reviewedAssetPaths.add(feature.chunk);
    for (const dependency of feature.dependencies ?? []) reviewedAssetPaths.add(dependency);
  }
  for (const anchor of anchors) reviewedAssetPaths.add(anchor.artifact.replace(/^src\/app\/dist\/renderer\//, ""));
  for (const module of semanticSymbols.modules ?? []) {
    const artifact = artifactPathFromRecovered(module.path);
    if (artifact != null) reviewedAssetPaths.add(artifact.replace(/^src\/app\/dist\/renderer\//, ""));
  }
  const artifactInventory = (assetManifest.files ?? []).map((file) => {
    const extension = path.posix.extname(file.path).toLowerCase();
    let classification;
    if (reviewedAssetPaths.has(file.path)) classification = "reviewed-product-evidence";
    else if (mainDynamicTargets.has(file.path) && /^assets\/view-/.test(file.path)) classification = "unreviewed-dynamic-view";
    else if (![".js", ".mjs", ".css", ".html"].includes(extension)) classification = "static-binary-or-vector";
    else if (extension === ".css") classification = "unreviewed-stylesheet";
    else classification = "generated-or-dependency-code";
    return { path: file.path, bytes: file.sourceBytes, transformed: file.transformed, classification };
  }).sort(byPath);
  const unreviewedDynamicViews = artifactInventory.filter((asset) => asset.classification === "unreviewed-dynamic-view").map((asset) => ({ ...asset, importEvidence: immutableEvidence(RENDERER_CLOSURE_INPUTS.shippedMain, `./${path.posix.basename(asset.path)}`, sourceByArtifact) }));

  const ipcClaims = cleanIpcClaims(graph).map((claim) => {
    const token = claim.kind === "desktop-bridge" ? claim.value.split(".").at(-1) : claim.value;
    const evidence = immutableEvidence(RENDERER_CLOSURE_INPUTS.shippedMain, token, sourceByArtifact);
    return { ...claim, evidenceToken: token, shippedEvidence: evidence.occurrences > 0 ? "present" : "absent", evidence };
  });
  for (const claim of ipcClaims.filter((record) => record.shippedEvidence === "absent")) {
    findings.push(makeFinding("clean-ipc-without-shipped-evidence", "high", "high", "ipc-call", `${claim.kind}:${claim.value}`, "A reachable clean IPC call has no exact method/event token in the shipped renderer main chunk.", claim, "Trace the IPC contract to immutable renderer/preload evidence or remove the unsupported call."));
  }

  const orphans = graph.files.filter((cleanPath) => !graph.reachable.has(cleanPath)).map((cleanPath) => {
    const source = graph.sourceByPath.get(cleanPath) ?? "";
    const feature = features.find((record) => cleanFeatureFamily(cleanPath) === record.family) ?? null;
    const anchorCount = anchors.filter((anchor) => anchor.cleanPath === cleanPath && anchor.valid).length;
    return { path: cleanPath, kind: cleanModuleKind(cleanPath, source), featureId: feature?.id ?? null, validatedAnchors: anchorCount };
  }).sort(byPath);
  for (const orphan of orphans.filter((record) => record.validatedAnchors > 0 || record.kind === "feature-entrypoint" && features.some((feature) => feature.id === record.featureId && feature.status === "artifact-only"))) {
    const feature = features.find((record) => record.id === orphan.featureId);
    findings.push(makeFinding("orphan-clean-product-module", "medium", "high", "clean-reachability", orphan.path, "An evidence-bearing clean product module is not reachable from the production entrypoint.", feature?.evidence ?? { validatedAnchors: orphan.validatedAnchors }, "Connect this module only through its reviewed shipped feature route, or document why the recovered module is intentionally non-production."));
  }

  const severityOrder = { high: 0, medium: 1, low: 2 };
  findings.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity] || left.subject.localeCompare(right.subject) || left.code.localeCompare(right.code));
  const findingCounts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) findingCounts[finding.severity] += 1;
  const assetCounts = {};
  for (const asset of artifactInventory) assetCounts[asset.classification] = (assetCounts[asset.classification] ?? 0) + 1;
  const replacementBlockers = findings.filter((finding) => finding.severity === "high").map((finding) => `${finding.code}:${finding.subject}`);

  return {
    schemaVersion: 1,
    inputs: RENDERER_CLOSURE_INPUTS,
    verdict: {
      canReplaceShippedBundleWithoutFeatureLoss: replacementBlockers.length === 0,
      status: replacementBlockers.length === 0 ? "evidence-closure-demonstrated" : "blocked-by-evidenced-gaps",
      blockers: replacementBlockers,
      caveat: `${candidates.length - linkedCandidates.length} JSX-runtime candidates remain unlinked to reviewed first-party evidence and are not treated as product features or as third-party waivers.`,
    },
    summary: {
      cleanModules: graph.files.length,
      reachableCleanModules: graph.reachable.size,
      orphanCleanModules: orphans.length,
      unresolvedCleanImports: reachableUnresolved.length,
      shippedAssets: artifactInventory.length,
      assetClassifications: assetCounts,
      reviewedFeatureSurfaces: features.length,
      composedFeatureSurfaces: features.filter((feature) => feature.status === "composed").length,
      artifactOnlyFeatureSurfaces: features.filter((feature) => feature.status === "artifact-only").length,
      shippedFeatureRoutes: routes.length,
      shippedRoutesAbsentFromCleanComposition: routes.filter((route) => route.reviewed && route.cleanComposition === "absent").length,
      cleanFeatureFamilies: reachedFamilies.length,
      cleanFeatureFamiliesWithoutEvidence: cleanRoutesWithoutEvidence.length,
      jsxCandidates: candidates.length,
      evidenceLinkedJsxCandidates: linkedCandidates.length,
      unlinkedJsxCandidates: candidates.length - linkedCandidates.length,
      reviewedMainComponents: reviewedComponents.length,
      artifactOnlyReviewedComponents: reviewedComponents.filter((component) => component.cleanComposition === "absent").length,
      uiAnchors: anchors.length,
      validUiAnchors: anchors.filter((anchor) => anchor.valid).length,
      reachableUiAnchors: anchors.filter((anchor) => anchor.valid && anchor.cleanReachable).length,
      cleanIpcClaims: ipcClaims.length,
      cleanIpcClaimsWithoutEvidence: ipcClaims.filter((claim) => claim.shippedEvidence === "absent").length,
      findings: findings.length,
      ...findingCounts,
    },
    cleanGraph: {
      entry: graph.entry,
      reachable: [...graph.reachable].sort(),
      orphans,
      edges: graph.edges,
      unresolved: graph.unresolved.map((edge) => ({ ...edge, importerReachable: graph.reachable.has(edge.from) })),
    },
    artifactInventory,
    unreviewedDynamicViews,
    features,
    routes,
    cleanRoutesWithoutEvidence,
    reviewedComponents,
    jsxCandidateCoverage: {
      source: RENDERER_CLOSURE_INPUTS.jsxCandidates,
      total: candidates.length,
      evidenceLinked: linkedCandidates,
      unlinkedCount: candidates.length - linkedCandidates.length,
      interpretation: "Unlinked candidates are an uncertainty population because the monolithic bundle includes dependency/generated JSX; they are not silently counted as recovered or missing product UI.",
    },
    uiAnchors: anchors,
    ipcClaims,
    findings,
  };
}

export function formatRendererClosure(report, limit = 80) {
  const lines = [
    `Renderer closure: ${report.verdict.status}; replacement without feature loss: ${report.verdict.canReplaceShippedBundleWithoutFeatureLoss ? "yes" : "no"}.`,
    `${report.summary.reachableCleanModules}/${report.summary.cleanModules} clean modules reachable; ${report.summary.artifactOnlyFeatureSurfaces}/${report.summary.reviewedFeatureSurfaces} reviewed feature surfaces artifact-only.`,
    `${report.summary.jsxCandidates} JSX candidates (${report.summary.evidenceLinkedJsxCandidates} evidence-linked); ${report.summary.uiAnchors} UI anchors; ${report.summary.findings} findings.`,
  ];
  for (const finding of report.findings.slice(0, limit)) lines.push("", `[${finding.severity.toUpperCase()}/${finding.confidence}] ${finding.code} — ${finding.subject}`, `  ${finding.message}`, `  Action: ${finding.remediation}`, `  Evidence: ${JSON.stringify(finding.evidence)}`);
  if (report.findings.length > limit) lines.push("", `… ${report.findings.length - limit} findings omitted.`);
  return lines.join("\n");
}

function compactEvidence(evidence) {
  return evidence == null ? evidence : { ...evidence, locations: evidence.locations?.slice(0, 1) ?? [] };
}

export function rendererClosureSnapshot(report) {
  return {
    schemaVersion: report.schemaVersion,
    inputs: report.inputs,
    verdict: report.verdict,
    summary: report.summary,
    cleanGraph: {
      entry: report.cleanGraph.entry,
      reachable: report.cleanGraph.reachable,
      orphans: report.cleanGraph.orphans,
      unresolved: report.cleanGraph.unresolved,
    },
    artifactInventory: report.artifactInventory,
    unreviewedDynamicViews: report.unreviewedDynamicViews.map((asset) => ({ ...asset, importEvidence: compactEvidence(asset.importEvidence) })),
    features: report.features.map((feature) => ({ ...feature, evidence: Object.fromEntries(Object.entries(feature.evidence).map(([key, value]) => [key, compactEvidence(value)])) })),
    routes: report.routes.map((route) => ({ ...route, evidence: compactEvidence(route.evidence) })),
    cleanRoutesWithoutEvidence: report.cleanRoutesWithoutEvidence,
    reviewedComponents: report.reviewedComponents.map((component) => ({ ...component, evidence: compactEvidence(component.evidence) })),
    jsxCandidateCoverage: report.jsxCandidateCoverage,
    uiAnchors: report.uiAnchors.map((anchor) => ({ ...anchor, evidence: compactEvidence(anchor.evidence) })),
    ipcClaims: report.ipcClaims.map((claim) => ({ ...claim, evidence: compactEvidence(claim.evidence) })),
    findings: report.findings,
  };
}

function parseArgs(argv) {
  const options = { json: false, limit: 80, failOn: null, check: null };
  for (const argument of argv) {
    if (argument === "--json") options.json = true;
    else if (argument.startsWith("--limit=")) options.limit = Number.parseInt(argument.slice(8), 10);
    else if (argument.startsWith("--fail-on=")) options.failOn = argument.slice(10);
    else if (argument.startsWith("--check=")) options.check = argument.slice(8);
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/audit-renderer-closure.mjs [--json] [--limit=N] [--fail-on=high|medium] [--check=report.json]");
    return;
  }
  const report = await auditRendererClosure(DEFAULT_REPO_ROOT);
  const snapshot = rendererClosureSnapshot(report);
  if (options.check != null) {
    const checked = await readJson(path.resolve(DEFAULT_REPO_ROOT, options.check), null);
    if (JSON.stringify(checked) !== JSON.stringify(snapshot)) {
      console.error(`Renderer closure report is stale: ${options.check}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(options.json ? JSON.stringify(snapshot, null, 2) : formatRendererClosure(report, options.limit));
  if (options.failOn === "high" && report.summary.high > 0) process.exitCode = 1;
  if (options.failOn === "medium" && report.summary.high + report.summary.medium > 0) process.exitCode = 1;
}

if (process.argv[1] != null && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
