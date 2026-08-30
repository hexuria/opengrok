#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

export const UI_AUDIT_INPUTS = Object.freeze({
  manifest: "recovered/source-capsules/manifest.json",
  coverage: "recovery/full-app-coverage.json",
  immutableRenderer: "src/app/dist/renderer",
  recoveredRenderer: "recovered/frontend/app",
  featureReport: "recovered/frontend/reports/features.json",
  semanticSymbols: "frontend/manifests/semantic-symbols.json",
  componentNames: "frontend/manifests/component-names.json",
  conversationEvidence: "frontend/manifests/conversation-evidence.json",
  productionEvidence: "frontend/src/production/evidence.ts",
  anchorCatalog: "frontend/manifests/ui-evidence-anchors.json",
  cleanRoots: ["frontend/src/recovered", "frontend/src/production"],
  rendererEntrypoint: "frontend/src/main.tsx",
  developmentTooling: "frontend/src/dev",
});

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".css"]);
const EVIDENCE_TEXT_EXTENSIONS = new Set([".js", ".mjs", ".css", ".html", ".svg"]);
const VISIBLE_ATTRIBUTES = new Set(["aria-label", "title", "placeholder", "alt"]);
const ROUTE_ATTRIBUTES = new Set(["href", "to", "route", "path"]);
const ROUTE_PROPERTY_NAMES = new Set(["href", "to", "route"]);
const UI_PROPERTY_NAMES = new Set(["label", "title", "description", "placeholder", "emptyLabel", "emptyMessage", "buttonText", "ctaText"]);
const CONTROL_TAGS = new Set(["button", "input", "select", "textarea", "a"]);
const ANNOTATION_PATTERN = /@(?:artifact-)?evidence\s+([^\s*#]+)(?:#L?(\d+))?/g;
const ALLOWED_ANNOTATION_ROOTS = ["src/app/", "recovered/frontend/", "recovered/source-capsules/", "frontend/manifests/"];
const CATALOG_CATEGORIES = new Set(["visible-string", "selector", "route", "dom-signature", "asset"]);
const REVIEWED_REGISTRIES = new Set([
  UI_AUDIT_INPUTS.featureReport,
  UI_AUDIT_INPUTS.semanticSymbols,
  UI_AUDIT_INPUTS.componentNames,
  UI_AUDIT_INPUTS.conversationEvidence,
  UI_AUDIT_INPUTS.productionEvidence,
]);

function relativePath(value) { return value.split(path.sep).join("/"); }
function decodeEntities(value) {
  return value.replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function normalizedVisible(value) { return decodeEntities(value).replace(/\s+/g, " ").trim(); }
function isMeaningfulVisible(value) {
  return value.length >= 2 && !/^[\d\s.,:;!?+×—–-]+$/.test(value) && (/[A-Z]/.test(value) || /\s/.test(value) || /[…'’]/.test(value));
}
function lineAt(text, index) { return text.slice(0, index).split("\n").length; }
function addClaim(claims, seen, claim) {
  const key = `${claim.category}\0${claim.value}\0${claim.line}`;
  if (!seen.has(key)) { seen.add(key); claims.push(claim); }
}

export function extractUiClaims(cleanPath, text) {
  if (path.extname(cleanPath) === ".css") return extractCssClaims(text);
  if (cleanPath.endsWith("/production/evidence.ts") && /export const PRODUCTION_UI_EVIDENCE\b/.test(text)) return [];
  const claims = [];
  const seen = new Set();
  const add = (category, value, index, context) => {
    const normalized = category === "visible-string" ? normalizedVisible(value) : value.trim();
    if (normalized.length === 0 || (category === "visible-string" && !isMeaningfulVisible(normalized))) return;
    addClaim(claims, seen, { category, value: normalized, line: lineAt(text, index), context });
  };
  if (/\.[jt]sx$/.test(cleanPath)) {
    for (const match of text.matchAll(/\b(aria-label|title|placeholder|alt|href|to|route|path|className|id|data-testid)\s*=\s*["']([^"']+)["']/g)) {
      const [, name, literal] = match;
      if (VISIBLE_ATTRIBUTES.has(name)) add("visible-string", literal, match.index, `jsx-${name}`);
      if (ROUTE_ATTRIBUTES.has(name)) add("route", literal, match.index, `jsx-${name}`);
      if (name === "className") for (const token of literal.split(/\s+/)) add("selector", `.${token}`, match.index, "jsx-className");
      if (name === "id") add("selector", `#${literal}`, match.index, "jsx-id");
      if (name === "data-testid") add("selector", `[data-testid="${literal}"]`, match.index, "jsx-data-testid");
    }
    for (const match of text.matchAll(/<\s*(button|input|select|textarea|a)\b/g)) {
      const tag = match[1].toLowerCase();
      if (CONTROL_TAGS.has(tag)) addClaim(claims, seen, { category: "control", value: tag, line: lineAt(text, match.index), context: "native-control" });
    }
    const jsxTag = "(?:[A-Z][\\w.]*|div|span|p|h[1-6]|strong|small|label|button|input|select|option|textarea|a|section|main|header|footer|aside|nav|ol|ul|li|form|dialog)";
    const childPattern = new RegExp(`<${jsxTag}\\b[^<>]*>([^<>]*)<`, "g");
    for (const match of text.matchAll(childPattern)) {
      if (match.index > 0 && /[A-Za-z0-9_$.)\]]/.test(text[match.index - 1])) continue;
      const openingTag = match[0].slice(0, match[0].indexOf(">"));
      if (/\/\s*$/.test(openingTag)) continue;
      const segment = match[1];
      for (const plain of segment.split(/\{[\s\S]*?\}/g)) if (!/[{}]/.test(plain)) add("visible-string", plain, match.index + match[0].indexOf(">") + 1, "jsx-text");
      for (const expression of segment.matchAll(/\{([\s\S]*?)\}/g)) {
        for (const literal of expression[1].matchAll(/["'`]([^"'`]+)["'`]/g)) add("visible-string", literal[1], match.index + expression.index, "jsx-expression");
      }
    }
    for (const match of text.matchAll(/>([^<>{}\n]+)<\/(?:button|option|label|span|small|strong|p|h[1-6])\s*>/g)) add("visible-string", match[1], match.index + 1, "jsx-closing-text");
  }
  const propertyNames = [...UI_PROPERTY_NAMES, ...ROUTE_PROPERTY_NAMES].join("|");
  const propertyPattern = new RegExp("\\b(" + propertyNames + ")\\s*:\\s*[\\\"']([^\\\"']+)[\\\"']", "g");
  for (const match of text.matchAll(propertyPattern)) {
    if (UI_PROPERTY_NAMES.has(match[1])) add("visible-string", match[2], match.index, `property-${match[1]}`);
    if (ROUTE_PROPERTY_NAMES.has(match[1])) add("route", match[2], match.index, `property-${match[1]}`);
  }
  for (const match of text.matchAll(/\b(label|title|description|placeholder|emptyLabel|emptyMessage|buttonText|ctaText)\s*=\s*["']([^"']+)["']/g)) add("visible-string", match[2], match.index, `default-${match[1]}`);
  for (const block of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*\{([\s\S]*?)\};/g)) {
    if (!/(?:^|_)(?:TEXT|LABELS?|ERRORS?|MESSAGES?|COPY)(?:_|$)/.test(block[1])) continue;
    for (const value of block[2].matchAll(/:\s*["']([^"']+)["']/g)) add("visible-string", value[1], block.index + value.index, `ui-constant-${block[1]}`);
  }
  for (const match of text.matchAll(/\b(navigate|router\.(?:push|replace)|openRoute|openPath)\s*\(\s*["'`]([^"'`]+)["'`]/gi)) add("route", match[2], match.index, `call-${match[1]}`);
  return claims;
}

function extractCssClaims(text) {
  const claims = [];
  const seen = new Set();
  const parseable = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  for (const rule of parseable.matchAll(/(?:^|\})([^{}]+)\{/g)) {
    const selectorPart = rule[1].trim();
    if (!/[.#\[]/.test(selectorPart) || /^@/.test(selectorPart)) continue;
    for (const match of selectorPart.matchAll(/(?:\.[A-Za-z_-][\w-]*|#[A-Za-z_-][\w-]*|\[data-[\w-]+(?:=[^\]]+)?\])/g)) {
      addClaim(claims, seen, { category: "selector", value: match[0], line: lineAt(parseable, rule.index + match.index), context: "css-selector" });
    }
  }
  return claims;
}

async function walkFiles(directory) {
  const output = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(target));
    else output.push(target);
  }
  return output;
}

async function readJsonOr(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function readEvidenceFile(repoRoot, evidencePath) {
  try { return await readFile(path.join(repoRoot, evidencePath), "utf8"); } catch { return null; }
}

function annotationPaths(text) {
  return [...text.matchAll(ANNOTATION_PATTERN)].map((match) => ({ path: relativePath(match[1]), line: match[2] == null ? null : Number.parseInt(match[2], 10) }));
}

function featureFor(cleanPath, features) {
  const prefix = "frontend/src/recovered/";
  if (!cleanPath.startsWith(prefix)) return null;
  const recoveredPath = cleanPath.slice(prefix.length);
  return features.find((feature) => {
    const entry = feature.entrypoint?.replace(/^\.\//, "") ?? "";
    const view = feature.view?.replace(/^\.\//, "") ?? "";
    const root = entry.slice(0, entry.lastIndexOf("/") + 1);
    return recoveredPath === entry || recoveredPath === view || (root.length > 0 && recoveredPath.startsWith(root));
  }) ?? null;
}

function classifyFile(cleanPath, text) {
  if (/export const PRODUCTION_UI_EVIDENCE\b/.test(text)) return "evidence-registry";
  if (/\.gen\.[jt]sx?$/.test(cleanPath) || /generated (?:file|from)|do not edit/i.test(text.slice(0, 500))) return "generated";
  if (/(?:\/entrypoint|\/runtime\/|\/catalog|\/contracts\/|\/desktop(?:-preview)?|\/main)\.[jt]sx?$/.test(cleanPath)) return "wrapper";
  return "implementation";
}

function anchorVariants(claim) {
  if (claim.category === "selector") {
    const bare = claim.value.startsWith(".") || claim.value.startsWith("#") ? claim.value.slice(1) : claim.value;
    return [claim.value, `"${bare}"`, `'${bare}'`, bare];
  }
  const value = claim.value;
  return [value, value.replace(/'/g, "\\'"), value.replace(/"/g, '\\"'), value.replace(/…/g, "\\u2026")];
}

function containsClaim(text, claim) { return text != null && anchorVariants(claim).some((variant) => text.includes(variant)); }

function makeFinding(cleanPath, code, category, severity, confidence, message, evidence, recommendation) {
  return { cleanPath, code, missingEvidenceCategory: category, severity, confidence, message, evidence, recommendation };
}

function invalidCatalogFinding(cleanPath, code, message, evidence) {
  return makeFinding(cleanPath, code, "catalog-anchor", "high", "high", message, evidence, "Replace it with a narrow exact value that resolves in both the clean UI claim and immutable shipped evidence, or remove the catalog entry and preserve the gap.");
}

export function validateCatalogEntry({ entry, cleanText, claims, immutableByPath, availableRegistries }) {
  const cleanPath = typeof entry?.cleanPath === "string" ? relativePath(entry.cleanPath) : "<invalid-catalog-entry>";
  const findings = [];
  const validAnchors = [];
  if (cleanText == null) {
    findings.push(invalidCatalogFinding(cleanPath, "catalog-clean-file-missing", "Catalog entry names a clean file that cannot be read.", { cleanPath }));
    return { cleanPath, validAnchors, findings };
  }
  if (!Array.isArray(entry.anchors) || entry.anchors.length === 0) {
    findings.push(invalidCatalogFinding(cleanPath, "catalog-entry-without-anchors", "Catalog entry has no exact evidence anchors.", { cleanPath }));
    return { cleanPath, validAnchors, findings };
  }
  for (let index = 0; index < entry.anchors.length; index += 1) {
    const anchor = entry.anchors[index];
    const evidence = { index, anchor };
    if (anchor == null || typeof anchor !== "object" || !CATALOG_CATEGORIES.has(anchor.category)) {
      findings.push(invalidCatalogFinding(cleanPath, "catalog-anchor-category", "Catalog anchor has no supported exact evidence category.", evidence));
      continue;
    }
    if (typeof anchor.value !== "string" || anchor.value.trim() !== anchor.value || anchor.value.length < 2 || /[\n\r*]/.test(anchor.value) || /^(?:see|same as|matches?|observed|shipped|upstream|artifact|evidence)\b/i.test(anchor.value)) {
      findings.push(invalidCatalogFinding(cleanPath, "catalog-vague-anchor", "Catalog anchor is empty, wildcarded, or vague prose rather than an exact artifact value.", evidence));
      continue;
    }
    if (typeof anchor.artifact !== "string" || !anchor.artifact.startsWith("src/app/") || anchor.artifact === cleanPath || anchor.artifact === UI_AUDIT_INPUTS.anchorCatalog) {
      findings.push(invalidCatalogFinding(cleanPath, "catalog-self-or-nonimmutable-reference", "Catalog anchor must point to immutable src/app evidence and cannot reference clean source or the catalog itself.", evidence));
      continue;
    }
    if (anchor.registry != null && (typeof anchor.registry !== "string" || anchor.registry === UI_AUDIT_INPUTS.anchorCatalog || !REVIEWED_REGISTRIES.has(anchor.registry) || !availableRegistries.has(anchor.registry))) {
      findings.push(invalidCatalogFinding(cleanPath, "catalog-invalid-registry", "Catalog registry reference is self-referential, unavailable, or not a reviewed evidence registry.", evidence));
      continue;
    }
    const artifactText = immutableByPath.get(anchor.artifact);
    if (artifactText == null) {
      findings.push(invalidCatalogFinding(cleanPath, "catalog-artifact-missing", "Catalog artifact is not a readable immutable renderer asset.", evidence));
      continue;
    }
    const claim = { category: anchor.category, value: anchor.value };
    const artifactLine = anchor.line == null ? null : artifactText.split("\n")[anchor.line - 1];
    if (anchor.line != null && (!Number.isInteger(anchor.line) || anchor.line < 1 || artifactLine == null)) {
      findings.push(invalidCatalogFinding(cleanPath, "catalog-line-missing", "Catalog line does not resolve inside its immutable artifact.", evidence));
      continue;
    }
    if (!containsClaim(artifactLine ?? artifactText, claim)) {
      findings.push(invalidCatalogFinding(cleanPath, "catalog-anchor-not-in-artifact", "Exact catalog value does not occur at the declared immutable artifact location.", evidence));
      continue;
    }
    const cleanClaim = ["visible-string", "selector", "route"].includes(anchor.category)
      ? claims.some((candidate) => candidate.category === anchor.category && candidate.value === anchor.value)
      : cleanText.includes(anchor.value);
    if (!cleanClaim) {
      findings.push(invalidCatalogFinding(cleanPath, "catalog-anchor-not-in-clean-claim", "Catalog value is not an exact UI claim made by the named clean file.", evidence));
      continue;
    }
    validAnchors.push(anchor);
  }
  return { cleanPath, validAnchors, findings };
}

export function analyzeUiFile({ cleanPath, text, claims, provenance, scopedEvidence, globalEvidence, invalidAnnotations = [] }) {
  const findings = [];
  const classification = classifyFile(cleanPath, text);
  const uiClaims = claims.filter((claim) => claim.category !== "control");
  const controls = claims.filter((claim) => claim.category === "control");
  for (const annotation of invalidAnnotations) {
    findings.push(makeFinding(cleanPath, "invalid-evidence-annotation", "annotation-target", "high", "high", `Evidence annotation points to an unavailable or disallowed target: ${annotation.path}.`, annotation, "Point the annotation at a concrete immutable artifact or reviewed recovery metadata path."));
  }
  if (claims.length > 0 && provenance.length === 0) {
    findings.push(makeFinding(cleanPath, "missing-module-provenance", "module-provenance", "high", "high", "UI-facing clean source has no traceable artifact module, reviewed symbol record, central mapping, or valid evidence annotation.", { classification, claimCount: claims.length, controls: controls.length }, "Record a narrow artifact path/line or mapping for this surface; otherwise remove the unsupported product-facing UI claim."));
  }

  const unanchored = [];
  const globalOnly = [];
  for (const claim of uiClaims) {
    const scoped = scopedEvidence.some((entry) => containsClaim(entry.text, claim));
    const global = scoped || containsClaim(globalEvidence, claim);
    if (!global) unanchored.push(claim);
    else if (!scoped && provenance.length > 0) globalOnly.push(claim);
  }
  for (const category of ["visible-string", "route", "selector"]) {
    const missing = unanchored.filter((claim) => claim.category === category);
    if (missing.length === 0) continue;
    const distinctiveSelectors = category === "selector" && missing.some((claim) => /^\.(?:sand-|grok-|recovered-)/.test(claim.value));
    const severity = category === "selector" && !distinctiveSelectors ? "medium" : "high";
    const confidence = category === "selector" && !distinctiveSelectors ? "medium" : "high";
    findings.push(makeFinding(cleanPath, `unanchored-${category}`, category, severity, confidence, `${missing.length} ${category.replace("-", " ")} claim(s) have no exact anchor in immutable shipped renderer assets or the file's declared evidence.`, { examples: missing.slice(0, 12), total: missing.length }, category === "visible-string" ? "Locate the exact shipped string in its renderer chunk or preserve the gap instead of introducing new visible copy." : category === "route" ? "Tie the route to an exact shipped navigation/path anchor or remove the unsupported route." : "Tie the selector to shipped DOM/CSS evidence; do not add a reconstructed product selector solely for convenience."));
  }
  if (globalOnly.length > 0) {
    findings.push(makeFinding(cleanPath, "global-only-anchor", "local-module-anchor", "medium", "medium", "Claims exist somewhere in the shipped renderer but not in this file's traceable artifact region.", { examples: globalOnly.slice(0, 12), total: globalOnly.length, provenance: provenance.map((entry) => entry.kind) }, "Confirm the claim belongs to this recovered module and add a narrow artifact line/symbol annotation if it does."));
  }
  if (controls.length > 0 && scopedEvidence.length === 0) {
    findings.push(makeFinding(cleanPath, "unscoped-control-structure", "control-structure", "medium", "medium", `${controls.length} native control(s) lack file-scoped artifact evidence.`, { examples: controls.slice(0, 12), total: controls.length }, "Trace each control to a shipped JSX/DOM signature or leave the surface explicitly incomplete."));
  }
  return { cleanPath, classification, claims, provenance, findings };
}

export async function auditUiProvenance(repoRoot = DEFAULT_REPO_ROOT, options = {}) {
  const absolute = (relative) => path.join(repoRoot, relative);
  const [manifest, coverage, featureReport, semanticSymbols, componentNames, conversationEvidence, anchorCatalog] = await Promise.all([
    readJsonOr(absolute(UI_AUDIT_INPUTS.manifest), { modules: [] }),
    readJsonOr(absolute(UI_AUDIT_INPUTS.coverage), { mappings: [] }),
    readJsonOr(absolute(UI_AUDIT_INPUTS.featureReport), { features: [] }),
    readJsonOr(absolute(UI_AUDIT_INPUTS.semanticSymbols), { modules: [] }),
    readJsonOr(absolute(UI_AUDIT_INPUTS.componentNames), { components: [], entry: null }),
    readJsonOr(absolute(UI_AUDIT_INPUTS.conversationEvidence), { bindings: [], entry: null }),
    readJsonOr(absolute(UI_AUDIT_INPUTS.anchorCatalog), { schemaVersion: 1, entries: [] }),
  ]);

  const immutableFiles = (await walkFiles(absolute(UI_AUDIT_INPUTS.immutableRenderer))).filter((file) => EVIDENCE_TEXT_EXTENSIONS.has(path.extname(file)));
  const immutableRecords = await Promise.all(immutableFiles.map(async (file) => ({ path: relativePath(path.relative(repoRoot, file)), text: await readFile(file, "utf8") })));
  const globalEvidence = immutableRecords.map((record) => record.text).join("\n");
  const immutableByPath = new Map(immutableRecords.map((record) => [record.path, record.text]));
  const moduleBySource = new Map((manifest.modules ?? []).map((record) => [record.source, record]));
  const productionEvidenceText = await readEvidenceFile(repoRoot, UI_AUDIT_INPUTS.productionEvidence) ?? "";
  const productionEvidencePaths = [...productionEvidenceText.matchAll(/\blocation:\s*["']([^"':]+)(?::\d+(?:,\d+)*)?["']/g)].map((match) => `src/app/dist/renderer/assets/${match[1]}`);
  const centralByClean = new Map();
  for (const mapping of coverage.mappings ?? []) for (const cleanSource of mapping.cleanSources ?? []) {
    const values = centralByClean.get(cleanSource) ?? [];
    values.push(mapping);
    centralByClean.set(cleanSource, values);
  }

  const cleanFiles = [];
  for (const root of UI_AUDIT_INPUTS.cleanRoots) cleanFiles.push(...await walkFiles(absolute(root)));
  cleanFiles.push(absolute(UI_AUDIT_INPUTS.rendererEntrypoint));
  if (options.includeDev === true) cleanFiles.push(...await walkFiles(absolute(UI_AUDIT_INPUTS.developmentTooling)));
  const selectedFiles = [...new Set(cleanFiles)].filter((file) => SOURCE_EXTENSIONS.has(path.extname(file))).sort();
  const selectedCleanPaths = new Set(selectedFiles.map((file) => relativePath(path.relative(repoRoot, file))));
  const availableRegistries = new Set();
  for (const registry of REVIEWED_REGISTRIES) if (await readEvidenceFile(repoRoot, registry) != null) availableRegistries.add(registry);
  const catalogResults = new Map();
  const catalogFindings = [];
  let anchorsValidated = 0;
  const seenCatalogPaths = new Set();
  if (anchorCatalog.schemaVersion !== 1 || !Array.isArray(anchorCatalog.entries)) {
    catalogFindings.push(invalidCatalogFinding(UI_AUDIT_INPUTS.anchorCatalog, "catalog-schema-invalid", "Anchor catalog must use schemaVersion 1 with an entries array.", { schemaVersion: anchorCatalog.schemaVersion }));
  }
  for (const entry of Array.isArray(anchorCatalog.entries) ? anchorCatalog.entries : []) {
    const cleanPath = typeof entry?.cleanPath === "string" ? relativePath(entry.cleanPath) : "<invalid-catalog-entry>";
    if (options.source != null && !cleanPath.includes(options.source)) continue;
    if (seenCatalogPaths.has(cleanPath)) {
      catalogFindings.push(invalidCatalogFinding(cleanPath, "catalog-duplicate-clean-file", "Catalog contains more than one entry for the same clean file.", { cleanPath }));
      continue;
    }
    seenCatalogPaths.add(cleanPath);
    if (!selectedCleanPaths.has(cleanPath)) {
      catalogFindings.push(invalidCatalogFinding(cleanPath, "catalog-outside-ui-scan", "Catalog entry does not name a product UI file in the auditor's clean-source scope.", { cleanPath }));
      continue;
    }
    const cleanText = await readEvidenceFile(repoRoot, cleanPath);
    const claims = cleanText == null ? [] : extractUiClaims(cleanPath, cleanText);
    const result = validateCatalogEntry({ entry, cleanText, claims, immutableByPath, availableRegistries });
    catalogResults.set(cleanPath, result);
    anchorsValidated += result.validAnchors.length;
    catalogFindings.push(...result.findings);
  }
  const audits = [];
  for (const file of selectedFiles) {
    const cleanPath = relativePath(path.relative(repoRoot, file));
    if (options.source != null && !cleanPath.includes(options.source)) continue;
    let text;
    try { text = await readFile(file, "utf8"); } catch { continue; }
    const claims = extractUiClaims(cleanPath, text);
    const provenance = [];
    const evidencePaths = new Set();
    const catalogResult = catalogResults.get(cleanPath);
    if (catalogResult != null && catalogResult.validAnchors.length > 0) {
      provenance.push({ kind: "validated-anchor-catalog", catalog: UI_AUDIT_INPUTS.anchorCatalog, anchors: catalogResult.validAnchors.length });
      for (const anchor of catalogResult.validAnchors) evidencePaths.add(anchor.artifact);
    }
    const centralMappings = centralByClean.get(cleanPath) ?? [];
    for (const mapping of centralMappings) {
      const moduleRecord = moduleBySource.get(mapping.source);
      provenance.push({ kind: "central-mapping", source: mapping.source, level: mapping.level });
      if (moduleRecord?.capsule != null) evidencePaths.add(moduleRecord.capsule);
    }
    if (cleanPath === "frontend/src/production/ProductionRenderer.tsx" && /from\s+["']\.\/evidence["']/.test(text)) {
      provenance.push({ kind: "explicit-evidence-registry", registry: UI_AUDIT_INPUTS.productionEvidence, artifacts: [...new Set(productionEvidencePaths)] });
      for (const evidencePath of productionEvidencePaths) evidencePaths.add(evidencePath);
    }
    const feature = featureFor(cleanPath, featureReport.features ?? []);
    if (feature != null) {
      const artifact = `src/app/dist/renderer/${feature.chunk}`;
      provenance.push({ kind: "feature-report", id: feature.id, originalView: feature.view, artifact });
      evidencePaths.add(artifact);
    }
    if (cleanPath.startsWith("frontend/src/recovered/features/conversation/") || cleanPath === "frontend/src/recovered/catalog.ts") {
      const entry = conversationEvidence.entry ?? componentNames.entry;
      if (entry != null) {
        const artifact = entry.replace(/^recovered\/frontend\/app\//, "src/app/dist/renderer/");
        provenance.push({ kind: "reviewed-renderer-binding", artifact, components: componentNames.components?.length ?? 0, bindings: conversationEvidence.bindings?.length ?? 0 });
        evidencePaths.add(artifact);
      }
    }
    const reviewedModule = (semanticSymbols.modules ?? []).find((record) => {
      const suffix = cleanPath.replace("frontend/src/recovered/", "");
      return record.originalPath === suffix;
    });
    if (reviewedModule != null) {
      const artifact = reviewedModule.path.replace(/^recovered\/frontend\/app\//, "src/app/dist/renderer/");
      provenance.push({ kind: "reviewed-symbol-map", originalPath: reviewedModule.originalPath, artifact });
      evidencePaths.add(artifact);
    }
    const invalidAnnotations = [];
    for (const annotation of annotationPaths(text)) {
      if (!ALLOWED_ANNOTATION_ROOTS.some((root) => annotation.path.startsWith(root))) { invalidAnnotations.push(annotation); continue; }
      const annotationText = await readEvidenceFile(repoRoot, annotation.path);
      if (annotationText == null) { invalidAnnotations.push(annotation); continue; }
      provenance.push({ kind: "explicit-annotation", ...annotation });
      evidencePaths.add(annotation.path);
    }
    const scopedEvidence = [];
    for (const evidencePath of evidencePaths) {
      const evidenceText = immutableByPath.get(evidencePath) ?? await readEvidenceFile(repoRoot, evidencePath);
      if (evidenceText != null) scopedEvidence.push({ path: evidencePath, text: evidenceText });
    }
    audits.push(analyzeUiFile({ cleanPath, text, claims, provenance, scopedEvidence, globalEvidence, invalidAnnotations }));
  }
  const findings = [...audits.flatMap((audit) => audit.findings), ...catalogFindings].sort((left, right) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[left.severity] - order[right.severity] || left.cleanPath.localeCompare(right.cleanPath) || left.code.localeCompare(right.code);
  });
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return {
    schemaVersion: 1,
    inputs: UI_AUDIT_INPUTS,
    generatedAt: new Date().toISOString(),
    summary: { filesAudited: audits.length, filesWithUiClaims: audits.filter((audit) => audit.claims.length > 0).length, catalogEntries: Array.isArray(anchorCatalog.entries) ? anchorCatalog.entries.length : 0, anchorsValidated, catalogErrors: catalogFindings.length, findings: findings.length, ...counts },
    findings,
    audits: options.includeAudits === true ? audits : undefined,
  };
}

export function formatUiReport(report, limit = 100) {
  const lines = [`UI evidence provenance audit: ${report.summary.filesAudited} files, ${report.summary.filesWithUiClaims} UI-bearing; ${report.summary.high} high, ${report.summary.medium} medium, ${report.summary.low} low findings.`];
  for (const finding of report.findings.slice(0, limit)) {
    lines.push("", `[${finding.severity.toUpperCase()}/${finding.confidence}] ${finding.cleanPath} — ${finding.code}`, `  Missing evidence: ${finding.missingEvidenceCategory}`, `  ${finding.message}`, `  Action: ${finding.recommendation}`, `  Evidence: ${JSON.stringify(finding.evidence)}`);
  }
  if (report.findings.length > limit) lines.push("", `… ${report.findings.length - limit} additional findings omitted.`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { json: false, includeAudits: false, includeDev: false, source: null, limit: 100, failOn: null };
  for (const argument of argv) {
    if (argument === "--json") options.json = true;
    else if (argument === "--include-audits") options.includeAudits = true;
    else if (argument === "--include-dev") options.includeDev = true;
    else if (argument.startsWith("--source=")) options.source = argument.slice("--source=".length);
    else if (argument.startsWith("--limit=")) options.limit = Number.parseInt(argument.slice("--limit=".length), 10);
    else if (argument.startsWith("--fail-on=")) options.failOn = argument.slice("--fail-on=".length);
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/audit-ui-provenance.mjs [--json] [--include-audits] [--include-dev] [--source=substring] [--limit=N] [--fail-on=high|medium]");
    return;
  }
  const report = await auditUiProvenance(DEFAULT_REPO_ROOT, options);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatUiReport(report, Number.isFinite(options.limit) ? options.limit : 100));
  if (options.failOn === "high" && report.summary.high > 0) process.exitCode = 1;
  if (options.failOn === "medium" && report.summary.high + report.summary.medium > 0) process.exitCode = 1;
}

if (process.argv[1] != null && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
