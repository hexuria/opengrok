import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { wavBytesForToneFile } from "../generate-notification-tones.mjs";
import { repoRoot } from "./config.mjs";

export const KATEX_VERSION = "0.16.45";
export const KATEX_CSS_FILES = Object.freeze([
  { file: "katex.css", sha256: "be62cce2bb080b2af5d86b115cc4fda61ead12d782e580046bcfe5598534820b" },
  { file: "katex.min.css", sha256: "23aefa0850248a16478b9f55d6b67028f74cc0b46b82b24dc22af068acaa4170" },
]);
export const KATEX_FONT_HASHES = Object.freeze({
  "KaTeX_AMS-Regular.woff2": "0cdd387c9590a1a9f9794560022dbb59654a7d86f187aa0c81495ad42d3a7308",
  "KaTeX_Caligraphic-Bold.woff2": "de7701e42cf1f4cf0b766c03fb27977207eee2f4fd5d76fa82188406da43ea4c",
  "KaTeX_Caligraphic-Regular.woff2": "5d53e70ad607c2352162dec9e0923fb54ecdafaccbf604cd8dcf7d00facb989b",
  "KaTeX_Fraktur-Bold.woff2": "74444efd593c005e3f4573b44524704c0af0a937fe911cca9e94068d0d140d3f",
  "KaTeX_Fraktur-Regular.woff2": "51814d270d06ff0255dba0799994fa4d8c84d11f09951d47595f4abb1f3602dc",
  "KaTeX_Main-Bold.woff2": "0f60d1b897938ec918c8ce073092411baf9438f6739465693ff18b0f9d20b021",
  "KaTeX_Main-BoldItalic.woff2": "99cd42a3c072d918f2f44984a807cf7aa16e13545fd0875fc07c6c65f99e715b",
  "KaTeX_Main-Italic.woff2": "97479ca6cce906abc961ecac96faa5f9ca2e61b8e7670d475826bcdee9a7c267",
  "KaTeX_Main-Regular.woff2": "c2342cd8b869e01752a9321dc17213fc40d4d04c79688c1d43f2cf316abd7866",
  "KaTeX_Math-BoldItalic.woff2": "dc47344dbb6cb5b655c8460d561f4df5f501b90c804ad3c6cec65fe322351ab1",
  "KaTeX_Math-Italic.woff2": "7af58c5ec8f132a2ddde9027c6d7814decce4d3b822a11192a42a20e2e973264",
  "KaTeX_SansSerif-Bold.woff2": "e99ae51144bf1232efcc1bfe5add36262c6866b0faab24fa75740e1b98577a62",
  "KaTeX_SansSerif-Italic.woff2": "00b26ac825e2095056396e0553b8ac26d3f8ad158c3826e28b4c45b385c4714a",
  "KaTeX_SansSerif-Regular.woff2": "68e8c73ef42afd3ccec58bf0fba302cce448938e7fc020a5e31f8a952eee1342",
  "KaTeX_Script-Regular.woff2": "036d4e95149b69ff9bcc0cd55771efeb25ffa3947293e69acd78d5ac328c684b",
  "KaTeX_Size1-Regular.woff2": "6b47c40166b6dbe21a5dfca7718413f2147fd2399be1ba605d8ad39cedf25dfe",
  "KaTeX_Size2-Regular.woff2": "d04c54219f9eaec6d4d4fd42dfb28785975a4794d6b2fc71e566b9cd6db842dd",
  "KaTeX_Size3-Regular.woff2": "73d591271b1604960cb10bb90fee021670af7297017e0e98480b332d11f51995",
  "KaTeX_Size4-Regular.woff2": "a4af7d414440a1c1790825cfb700cf9cf43b0f2c4b04f0ebc523011ad9853ec0",
  "KaTeX_Typewriter-Regular.woff2": "71d517d67827787cfabdf186914cc3358eda539e37931941f2b2fd4a21f68c0b",
});

// 0.18 hashed names the recovered frontend still imports. Bytes come from npm,
// never from src/app.
export const NPM_RUNTIME_ASSET_SOURCES = Object.freeze({
  "pdf-WLgSwHwh.js": "node_modules/pdfjs-dist/build/pdf.min.mjs",
  "pdf.worker.min-qwK7q_zL.mjs": "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
  "katex-DHMw6HUq.js": "node_modules/katex/dist/katex.min.js",
});

/** Renderer-relative path (`assets/foo.js`) of an npm-vendored runtime file. */
export function isNpmVendoredRendererAsset(relativePath, provenance = null) {
  const normalized = String(relativePath ?? "").split(path.sep).join("/").replace(/^dist\/renderer\//, "");
  const file = normalized.startsWith("assets/") ? normalized.slice("assets/".length) : normalized;
  if (Object.hasOwn(NPM_RUNTIME_ASSET_SOURCES, file)) return true;
  if (!Array.isArray(provenance?.assets)) return false;
  return provenance.assets.some((asset) => asset?.source === "npm" && asset.file === file);
}

const SRC_APP_ROOT = "src/app";
const MINIMAL_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const MINIMAL_JPEG = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffdb00430001010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda0008010100003f007f3fffd9",
  "hex",
);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalize(value) {
  return value.split(path.sep).join("/");
}

function foldPosix(value) {
  return normalize(String(value ?? "")).toLowerCase();
}

export function isSrcAppArtifactRoot(artifactRoot) {
  const folded = foldPosix(artifactRoot);
  return folded === SRC_APP_ROOT || folded.startsWith(`${SRC_APP_ROOT}/`) || folded.includes(`/${SRC_APP_ROOT}/`) || folded.endsWith(`/${SRC_APP_ROOT}`);
}

export function isForbiddenRendererGraphInput(input) {
  const folded = foldPosix(input);
  return folded === SRC_APP_ROOT || folded.startsWith(`${SRC_APP_ROOT}/`) || folded.startsWith("recovered/source-capsules/");
}

function isUnderDirectory(parent, child) {
  const relative = normalize(path.relative(parent, child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function isForbiddenRuntimeAssetSource(sourcePath) {
  const srcApp = path.join(repoRoot, SRC_APP_ROOT);
  const resolved = path.resolve(sourcePath);
  let realSource = resolved;
  let realSrcApp = path.resolve(srcApp);
  try { realSource = await realpath(resolved); } catch { /* lexical fallback */ }
  try { realSrcApp = await realpath(srcApp); } catch { /* lexical fallback */ }
  if (isUnderDirectory(realSrcApp, realSource)) return true;
  const fromRepo = normalize(path.relative(repoRoot, realSource));
  if (fromRepo.startsWith("..") || path.isAbsolute(fromRepo)) return true;
  return isSrcAppArtifactRoot(fromRepo);
}

function silentWavBytes() {
  const sampleRate = 8_000;
  const samples = 8;
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

export function generateRendererPlaceholderAsset(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".svg") {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" fill="#111"/></svg>\n`);
  }
  if (ext === ".png") return Buffer.from(MINIMAL_PNG);
  if (ext === ".jpg" || ext === ".jpeg") return Buffer.from(MINIMAL_JPEG);
  if (ext === ".wav") return wavBytesForToneFile(file) ?? silentWavBytes();
  return null;
}

export function planRuntimeAssetCopy(asset, artifactRoot, { forbidden = isSrcAppArtifactRoot(artifactRoot) } = {}) {
  const file = asset?.file;
  if (typeof file !== "string" || file.length === 0) throw new TypeError("Runtime asset copy plan requires asset.file");
  if (!forbidden) return { action: "copy" };
  const npmRelative = NPM_RUNTIME_ASSET_SOURCES[file];
  if (npmRelative != null) return { action: "vendor", npmRelative };
  const bytes = generateRendererPlaceholderAsset(file);
  if (bytes != null) return { action: "generate", bytes };
  return { action: "skip", reason: "src-app-asset" };
}

export function validateRuntimeAssetBytes(asset, bytes) {
  const digest = sha256(bytes);
  if (digest !== asset.sha256) throw new Error(`Renderer runtime asset hash drifted: ${asset.file}`);
  if (asset.bytes != null && bytes.byteLength !== asset.bytes) {
    throw new Error(`Renderer runtime asset size drifted: ${asset.file}`);
  }
  return { ...asset, bytes: bytes.byteLength };
}

export function immutableRendererAssetAllowlist(manifest) {
  if (manifest == null || isSrcAppArtifactRoot(manifest.artifactRoot)) return {};
  const forbidden = new Set(["assets/index-UbX-y3il.js", "assets/mermaid.core-CYC_FcEu.js"]);
  const entries = [];
  for (const asset of manifest.immutableAssets ?? []) {
    const relativePath = `assets/${asset.file}`;
    if (forbidden.has(relativePath) || typeof asset.sha256 !== "string") continue;
    entries.push([relativePath, Object.freeze({
      artifact: `${manifest.artifactRoot}/${asset.file}`,
      manifestFile: asset.file,
      bytes: asset.bytes ?? null,
      sha256: asset.sha256,
    })]);
  }
  return Object.fromEntries(entries);
}

export async function walk(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, target));
    else if (entry.isFile()) files.push(normalize(path.relative(root, target)));
  }
  return files.sort();
}

export async function copyRuntimeAssets(rendererRoot, {
  manifest: manifestOverride = null,
  frontendRoot = path.join(repoRoot, "frontend", "src"),
} = {}) {
  const manifest = manifestOverride ?? JSON.parse(await readFile(path.join(repoRoot, "frontend/manifests/renderer-runtime-assets.json"), "utf8"));
  const usedAssets = new Set();
  for (const relative of await walk(frontendRoot)) {
    if (!/\.[cm]?tsx?$/.test(relative)) continue;
    const source = await readFile(path.join(frontendRoot, relative), "utf8");
    for (const match of source.matchAll(/rendererRuntimeAssetUrl\("([A-Za-z0-9_.-]+)"\)/g)) usedAssets.add(match[1]);
  }
  const declaredAssets = new Set(manifest.assets.map(asset => asset.file));
  const undeclared = [...usedAssets].filter(file => !declaredAssets.has(file));
  const unused = [...declaredAssets].filter(file => !usedAssets.has(file));
  if (undeclared.length > 0 || unused.length > 0) {
    throw new Error(`Renderer runtime asset manifest mismatch; undeclared=${undeclared.join(",") || "none"}, unused=${unused.join(",") || "none"}`);
  }
  const outputAssets = path.join(rendererRoot, "assets");
  await mkdir(outputAssets, { recursive: true });
  const artifactDir = path.join(repoRoot, manifest.artifactRoot);
  const rootForbidden = isSrcAppArtifactRoot(manifest.artifactRoot) || await isForbiddenRuntimeAssetSource(artifactDir);
  const copied = [];
  const skipped = [];
  for (const asset of [...manifest.assets, ...(manifest.immutableAssets ?? [])]) {
    const source = path.join(repoRoot, manifest.artifactRoot, asset.file);
    const forbidden = rootForbidden || await isForbiddenRuntimeAssetSource(source);
    const plan = planRuntimeAssetCopy(asset, manifest.artifactRoot, { forbidden });
    if (plan.action === "skip") {
      skipped.push({ file: asset.file, reason: plan.reason ?? "src-app-asset" });
      continue;
    }
    if (plan.action === "generate") {
      await writeFile(path.join(outputAssets, asset.file), plan.bytes);
      copied.push({
        file: asset.file,
        bytes: plan.bytes.byteLength,
        sha256: sha256(plan.bytes),
        source: "generated",
      });
      continue;
    }
    if (plan.action === "vendor") {
      const npmPath = path.join(repoRoot, plan.npmRelative);
      if (!existsSync(npmPath)) throw new Error(`Vite renderer needs ${plan.npmRelative} to replace src/app asset ${asset.file}`);
      const bytes = await readFile(npmPath);
      await writeFile(path.join(outputAssets, asset.file), bytes);
      copied.push({
        file: asset.file,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        source: "npm",
        npm: plan.npmRelative,
      });
      continue;
    }
    if (await isForbiddenRuntimeAssetSource(source)) {
      throw new Error(`Renderer runtime assets must not be copied from src/app: ${asset.file}`);
    }
    const bytes = await readFile(source);
    const record = validateRuntimeAssetBytes(asset, bytes);
    await cp(source, path.join(outputAssets, asset.file), { preserveTimestamps: true });
    copied.push(record);
  }
  return { copied, skipped };
}

export async function copyKatexRuntimeAssets(rendererRoot) {
  const packageRoot = path.join(repoRoot, "node_modules", "katex");
  const packageManifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (packageManifest.version !== KATEX_VERSION) {
    throw new Error(`KaTeX package drifted: expected ${KATEX_VERSION}, found ${packageManifest.version}`);
  }
  const outputRoot = path.join(rendererRoot, "assets", "katex");
  const outputFonts = path.join(outputRoot, "fonts");
  await mkdir(outputFonts, { recursive: true });
  const copied = [];
  for (const css of KATEX_CSS_FILES) {
    const bytes = await readFile(path.join(packageRoot, "dist", css.file));
    const record = validateRuntimeAssetBytes({ ...css, file: `katex/${css.file}` }, bytes);
    await writeFile(path.join(outputRoot, css.file), bytes);
    copied.push(record);
  }
  for (const [file, expectedHash] of Object.entries(KATEX_FONT_HASHES)) {
    const bytes = await readFile(path.join(packageRoot, "dist", "fonts", file));
    const record = validateRuntimeAssetBytes({ file: `katex/fonts/${file}`, sha256: expectedHash }, bytes);
    await writeFile(path.join(outputFonts, file), bytes);
    copied.push(record);
  }
  const stylesheet = path.join(rendererRoot, "index.html");
  let html = await readFile(stylesheet, "utf8");
  const link = '<link rel="stylesheet" href="./assets/katex/katex.css" />';
  if (!html.includes(link)) {
    if (!html.includes("</head>")) throw new Error("Renderer HTML has no head boundary for KaTeX stylesheet");
    html = html.replace("</head>", `    ${link}\n  </head>`);
    await writeFile(stylesheet, html);
  }
  return { version: KATEX_VERSION, assets: copied, stylesheet: "assets/katex/katex.css" };
}

export async function rewritePdfAssetReferences(rendererRoot) {
  const moduleReference = "/upstream/assets/pdf-WLgSwHwh.js";
  const workerReference = "/upstream/assets/pdf.worker.min-qwK7q_zL.mjs";
  const moduleTarget = "pdf-WLgSwHwh.js";
  const workerTarget = "pdf.worker.min-qwK7q_zL.mjs";
  const counts = { [moduleReference]: 0, [workerReference]: 0 };
  for (const relative of await walk(rendererRoot)) {
    if (!relative.endsWith(".js")) continue;
    const target = path.join(rendererRoot, relative);
    const original = await readFile(target, "utf8");
    let rewritten = original;
    const moduleOccurrences = rewritten.split(moduleReference).length - 1;
    if (moduleOccurrences > 0) {
      counts[moduleReference] += moduleOccurrences;
      rewritten = rewritten.split(moduleReference).join(`./${moduleTarget}`);
    }
    const workerBinding = rewritten.match(/(?:^|[,;])\s*([A-Za-z_$][\w$]*)=["']pdf\.worker\.min-qwK7q_zL\.mjs["']/);
    if (workerBinding != null) {
      const workerVariable = workerBinding[1];
      const workerPattern = new RegExp("`/upstream/assets/\\$\\{" + workerVariable + "\\}`", "g");
      const workerOccurrences = rewritten.match(workerPattern)?.length ?? 0;
      if (workerOccurrences > 0) {
        counts[workerReference] += workerOccurrences;
        rewritten = rewritten.replace(workerPattern, "`./${" + workerVariable + "}`");
      }
    }
    if (counts[workerReference] === 0) {
      if (rewritten.includes("pdf.worker.min-qwK7q_zL.mjs")) counts[workerReference] += 1;
    }
    if (rewritten !== original) await writeFile(target, rewritten);
  }
  if (counts[moduleReference] > 0) {
    const shipped = path.join(rendererRoot, "assets", moduleTarget);
    if (!existsSync(shipped) && !existsSync(path.join(rendererRoot, moduleTarget))) {
      throw new Error(`Rewrote PDF module references but ${moduleTarget} was not emitted`);
    }
  }
  if (counts[workerReference] > 0) {
    const shipped = path.join(rendererRoot, "assets", workerTarget);
    if (!existsSync(shipped) && !existsSync(path.join(rendererRoot, workerTarget))) {
      throw new Error(`Rewrote PDF worker references but ${workerTarget} was not emitted`);
    }
  }
  return {
    replacements: {
      [moduleReference]: { to: `./${moduleTarget}`, count: counts[moduleReference] },
      [workerReference]: { to: `./${workerTarget}`, count: counts[workerReference] },
    },
  };
}
