/*
 * Provenance for surfaces ported from a later Grok Bot than 0.18.
 *
 * The 0.18 reconstruction records where each recovered file came from, and
 * `manifests/reconstruction/*.json` is the ledger for that. Ported features
 * are a different claim — "this did not exist in 0.18, it was taken from
 * 0.27" — so they get their own ledger rather than being smuggled into the
 * 0.18 catalogs, whose counts are pinned.
 *
 * This audit only checks that the ledger tells the truth: every path it names
 * exists, sits in an editable tree, is listed once, and cites what it came
 * from.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..");
export const PORTED_FEATURES_MANIFEST = "manifests/reconstruction/ported-features.json";

/** Ported code may only live where hand-authored code is allowed to live. */
const EDITABLE_ROOTS = ["frontend/src/", "source/", "scripts/", "tests/"];

const UPSTREAM_VERSIONS = new Set(["0.27.0"]);

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function problem(findings, id, message) {
  findings.push({ id, message });
}

export async function auditPortedFeatures(root = repoRoot) {
  const findings = [];
  const manifestPath = path.join(root, PORTED_FEATURES_MANIFEST);
  if (!(await exists(manifestPath))) {
    return { findings: [{ id: "manifest-missing", message: `${PORTED_FEATURES_MANIFEST} is missing` }], features: [] };
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return { findings: [{ id: "manifest-unreadable", message: String(error) }], features: [] };
  }

  if (manifest.schemaVersion !== 1) {
    problem(findings, "schema-version", `expected schemaVersion 1, saw ${String(manifest.schemaVersion)}`);
  }

  const features = Array.isArray(manifest.features) ? manifest.features : [];
  if (features.length === 0) problem(findings, "no-features", "the ledger lists no features");

  const seenPaths = new Map();
  for (const feature of features) {
    const id = typeof feature.id === "string" ? feature.id : "(unnamed)";

    if (typeof feature.summary !== "string" || feature.summary.trim().length === 0) {
      problem(findings, "summary-missing", `${id} has no summary`);
    }
    if (!UPSTREAM_VERSIONS.has(feature.upstreamVersion)) {
      problem(findings, "upstream-version", `${id} cites an unknown upstream version ${String(feature.upstreamVersion)}`);
    }
    if (!Array.isArray(feature.upstreamAnchors) || feature.upstreamAnchors.length === 0) {
      problem(findings, "anchor-missing", `${id} cites no upstream artifact`);
    }

    const paths = Array.isArray(feature.cleanPaths) ? feature.cleanPaths : [];
    if (paths.length === 0) problem(findings, "paths-missing", `${id} names no files`);

    for (const cleanPath of paths) {
      if (typeof cleanPath !== "string" || cleanPath.includes("..") || path.isAbsolute(cleanPath)) {
        problem(findings, "path-shape", `${id} names an unusable path ${String(cleanPath)}`);
        continue;
      }
      if (!EDITABLE_ROOTS.some((root_) => cleanPath.startsWith(root_))) {
        problem(findings, "path-root", `${id} names ${cleanPath}, which is outside the editable trees`);
      }
      if (!(await exists(path.join(root, cleanPath)))) {
        problem(findings, "path-absent", `${id} names ${cleanPath}, which does not exist`);
      }
      const owner = seenPaths.get(cleanPath);
      if (owner != null && owner !== id) {
        problem(findings, "path-duplicated", `${cleanPath} is claimed by both ${owner} and ${id}`);
      }
      seenPaths.set(cleanPath, id);
    }
  }

  return { findings, features };
}

if (import.meta.url === pathToFileUrl(process.argv[1])) {
  const { findings, features } = await auditPortedFeatures();
  for (const finding of findings) console.error(`[${finding.id}] ${finding.message}`);
  if (findings.length > 0) {
    console.error(`Ported-feature provenance: ${findings.length} finding(s).`);
    process.exitCode = 1;
  } else {
    console.log(`Ported-feature provenance: ${features.length} feature(s) accounted for.`);
  }
}

function pathToFileUrl(value) {
  if (value == null) return "";
  return new URL(`file://${path.resolve(value)}`).href;
}
