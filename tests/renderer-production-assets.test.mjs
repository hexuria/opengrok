import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  copyKatexRuntimeAssets,
  copyRuntimeAssets,
  generateRendererPlaceholderAsset,
  immutableRendererAssetAllowlist,
  isForbiddenRendererGraphInput,
  isNpmVendoredRendererAsset,
  isForbiddenRuntimeAssetSource,
  isSrcAppArtifactRoot,
  planRuntimeAssetCopy,
  rewritePdfAssetReferences,
  validateRuntimeAssetBytes,
} from "../scripts/lib/renderer-runtime-assets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendEntrypoint = path.join(repoRoot, "frontend/src/main.tsx");
const hasFrontend = existsSync(frontendEntrypoint);
const hasKatex = existsSync(path.join(repoRoot, "node_modules/katex/package.json"));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("KaTeX is vendored from npm, not the 0.18 renderer tree", async () => {
  const source = await readFile(path.join(repoRoot, "scripts/lib/renderer-runtime-assets.mjs"), "utf8");
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.dependencies.katex, "0.16.45");
  assert.match(source, /export const KATEX_VERSION = "0\.16\.45"/);
  assert.match(source, /node_modules", "katex"/);
  assert.doesNotMatch(source, /src\/app\/dist\/renderer\/assets\/katex/);
});

test("the clean renderer graph helper forbids src/app inputs", () => {
  assert.equal(isForbiddenRendererGraphInput("src/app"), true);
  assert.equal(isForbiddenRendererGraphInput("src/app/dist/renderer/assets/index.js"), true);
  assert.equal(isForbiddenRendererGraphInput("Src/App/dist/renderer/foo.js"), true);
  assert.equal(isForbiddenRendererGraphInput("recovered/source-capsules/foo.js"), true);
  assert.equal(isForbiddenRendererGraphInput("frontend/src/main.tsx"), false);
});

test("src/app runtime assets are generated, vendored, or skipped — never hashed as 0.18", async () => {
  assert.equal(isSrcAppArtifactRoot("src/app/dist/renderer/assets"), true);
  assert.equal(isSrcAppArtifactRoot("Src/App/dist/renderer/assets"), true);
  assert.equal(isSrcAppArtifactRoot("frontend/src/recovered/assets"), false);
  assert.equal(await isForbiddenRuntimeAssetSource(path.join(repoRoot, "src/app/dist/renderer/assets/app-icon-C7NKj2u7.png")), true);
  assert.equal(await isForbiddenRuntimeAssetSource(path.join(repoRoot, "frontend/src/recovered/assets/app-icon.png")), false);

  const iconHash = "79e6a73e634ce7ad8d1982739e9064bcc9c9ec5106bdd7281d7514ee68169ad2";
  const iconPlan = planRuntimeAssetCopy(
    { file: "app-icon-C7NKj2u7.png", sha256: iconHash },
    "src/app/dist/renderer/assets",
  );
  assert.equal(iconPlan.action, "generate");
  assert.notEqual(sha256(iconPlan.bytes), iconHash);
  assert.deepEqual(iconPlan.bytes, generateRendererPlaceholderAsset("app-icon-C7NKj2u7.png"));

  const katexPlan = planRuntimeAssetCopy(
    { file: "katex-DHMw6HUq.js", sha256: "8c143536a1933d1f96d975b0e7dcbd6057bb0885fea799852896530b3234d08a" },
    "src/app/dist/renderer/assets",
  );
  assert.equal(katexPlan.action, "vendor");
  assert.equal(katexPlan.npmRelative, "node_modules/katex/dist/katex.min.js");

  const pdfPlan = planRuntimeAssetCopy({ file: "pdf-WLgSwHwh.js" }, "src/app/dist/renderer/assets");
  assert.equal(pdfPlan.action, "vendor");

  const wavPlan = planRuntimeAssetCopy({ file: "ping-1-open-blip.wav" }, "src/app/dist/renderer/assets");
  assert.equal(wavPlan.action, "generate");
  assert.equal(wavPlan.bytes.toString("ascii", 0, 4), "RIFF");
  assert.ok(wavPlan.bytes.byteLength > 4096);

  const jpgHash = "90e253579c5e6ff18cb03059bbe380d64263222be48360802cda58e3d8392216";
  const jpgPlan = planRuntimeAssetCopy(
    { file: "demo-computer-wallpaper-BO7Ye4dV.jpg", sha256: jpgHash },
    "src/app/dist/renderer/assets",
  );
  assert.equal(jpgPlan.action, "generate");
  assert.notEqual(sha256(jpgPlan.bytes), jpgHash);
  assert.equal(jpgPlan.bytes[0], 0xff);
  assert.equal(jpgPlan.bytes[1], 0xd8);

  const xlsxPlan = planRuntimeAssetCopy({ file: "xlsx-CNerDvZX.js" }, "src/app/dist/renderer/assets");
  assert.equal(xlsxPlan.action, "skip");

  const allowed = planRuntimeAssetCopy({ file: "app-icon.png", sha256: "abc" }, "frontend/src/recovered/assets");
  assert.equal(allowed.action, "copy");
});

test("realpath under src/app is forbidden even when the lexical root is not", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-src-app-link-"));
  try {
    const link = path.join(temporary, "not-src-app");
    await symlink(path.join(repoRoot, "src/app"), link);
    assert.equal(await isForbiddenRuntimeAssetSource(path.join(link, "package.json")), true);
    assert.equal(isSrcAppArtifactRoot("frontend/src/recovered/assets"), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a src/app immutable allowlist is empty so skipped 0.18 JS cannot block composition", () => {
  const allowlist = immutableRendererAssetAllowlist({
    artifactRoot: "src/app/dist/renderer/assets",
    immutableAssets: [
      { file: "katex-DHMw6HUq.js", bytes: 259053, sha256: "8c143536a1933d1f96d975b0e7dcbd6057bb0885fea799852896530b3234d08a" },
    ],
  });
  assert.deepEqual(allowlist, {});
  const recovered = immutableRendererAssetAllowlist({
    artifactRoot: "frontend/src/recovered/assets",
    immutableAssets: [
      { file: "own.js", bytes: 4, sha256: "aaaa" },
    ],
  });
  assert.equal(recovered["assets/own.js"].sha256, "aaaa");
});

test("npm-vendored renderer JS is exempt from the clean-source banner without 0.18 hashes", () => {
  assert.equal(isNpmVendoredRendererAsset("assets/katex-DHMw6HUq.js"), true);
  assert.equal(isNpmVendoredRendererAsset("assets/pdf-WLgSwHwh.js"), true);
  assert.equal(isNpmVendoredRendererAsset("dist/renderer/assets/katex-DHMw6HUq.js"), true);
  const provenance = {
    assets: [{ file: "extra-vendor.js", source: "npm", sha256: "not-the-018-hash" }],
  };
  assert.equal(isNpmVendoredRendererAsset("assets/extra-vendor.js", provenance), true);
  assert.equal(isNpmVendoredRendererAsset("assets/index.js", provenance), false);
  assert.equal(isNpmVendoredRendererAsset("assets/xlsx-CNerDvZX.js", provenance), false);
});

test("copyRuntimeAssets does not read src/app even when the manifest points there", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-renderer-assets-"));
  try {
    const frontendRoot = path.join(temporary, "frontend-src");
    const rendererRoot = path.join(temporary, "renderer");
    const srcAppAsset = path.join(repoRoot, "src/app/dist/renderer/assets/app-icon-C7NKj2u7.png");
    await mkdir(frontendRoot, { recursive: true });
    await writeFile(
      path.join(frontendRoot, "icon.ts"),
      `export const icon = rendererRuntimeAssetUrl("app-icon-C7NKj2u7.png");\nexport const logo = rendererRuntimeAssetUrl("calendly-DYRMkyLM.svg");\nexport const wallpaper = rendererRuntimeAssetUrl("demo-computer-wallpaper-BO7Ye4dV.jpg");\n`,
    );
    const manifest = {
      schemaVersion: 1,
      artifactRoot: "src/app/dist/renderer/assets",
      assets: [
        { file: "app-icon-C7NKj2u7.png", sha256: "79e6a73e634ce7ad8d1982739e9064bcc9c9ec5106bdd7281d7514ee68169ad2" },
        { file: "calendly-DYRMkyLM.svg", sha256: "0ea3b3784f04256aa1dbe27c1e7b8a01a83c29be470f3326e0fd18003cd353f0" },
        { file: "demo-computer-wallpaper-BO7Ye4dV.jpg", sha256: "90e253579c5e6ff18cb03059bbe380d64263222be48360802cda58e3d8392216" },
      ],
      immutableAssets: [
        { file: "xlsx-CNerDvZX.js", sha256: "88bd58aabec374fbb50e18e1f271a15d6fca247297e8af73db4c368ae0408a9c" },
        ...(hasKatex ? [{ file: "katex-DHMw6HUq.js", bytes: 259053, sha256: "8c143536a1933d1f96d975b0e7dcbd6057bb0885fea799852896530b3234d08a" }] : []),
      ],
    };
    const { copied, skipped } = await copyRuntimeAssets(rendererRoot, { manifest, frontendRoot });
    const generated = copied.filter((asset) => asset.source === "generated").map((asset) => asset.file).sort();
    assert.deepEqual(generated, ["app-icon-C7NKj2u7.png", "calendly-DYRMkyLM.svg", "demo-computer-wallpaper-BO7Ye4dV.jpg"]);
    assert.deepEqual(skipped.map((asset) => asset.file), ["xlsx-CNerDvZX.js"]);
    for (const asset of copied.filter((row) => row.source === "generated")) {
      assert.notEqual(asset.sha256, manifest.assets.find((row) => row.file === asset.file)?.sha256);
      const bytes = await readFile(path.join(rendererRoot, "assets", asset.file));
      assert.equal(sha256(bytes), asset.sha256);
    }
    if (hasKatex) {
      const katex = copied.find((asset) => asset.file === "katex-DHMw6HUq.js");
      assert.equal(katex.source, "npm");
      assert.notEqual(katex.sha256, "8c143536a1933d1f96d975b0e7dcbd6057bb0885fea799852896530b3234d08a");
    }
    assert.equal(existsSync(path.join(rendererRoot, "assets", "xlsx-CNerDvZX.js")), false);
    if (existsSync(srcAppAsset)) {
      const upstream = sha256(await readFile(srcAppAsset));
      assert.notEqual(copied.find((asset) => asset.file === "app-icon-C7NKj2u7.png").sha256, upstream);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rewritePdfAssetReferences is a no-op when the Vite graph has no 0.18 PDF strings", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-pdf-rewrite-"));
  try {
    await writeFile(path.join(temporary, "chunk.js"), "export const x = 1;\n");
    const result = await rewritePdfAssetReferences(temporary);
    assert.equal(result.replacements["/upstream/assets/pdf-WLgSwHwh.js"].count, 0);
    assert.equal(result.replacements["/upstream/assets/pdf.worker.min-qwK7q_zL.mjs"].count, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("copyKatexRuntimeAssets copies npm KaTeX css and fonts", { skip: !hasKatex }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-katex-assets-"));
  try {
    await writeFile(path.join(temporary, "index.html"), "<html><head></head><body></body></html>\n");
    const result = await copyKatexRuntimeAssets(temporary);
    assert.equal(result.version, "0.16.45");
    assert.equal(result.stylesheet, "assets/katex/katex.css");
    const css = await readFile(path.join(temporary, "assets/katex/katex.css"));
    validateRuntimeAssetBytes(
      { file: "katex/katex.css", sha256: "be62cce2bb080b2af5d86b115cc4fda61ead12d782e580046bcfe5598534820b" },
      css,
    );
    const font = await readFile(path.join(temporary, "assets/katex/fonts/KaTeX_Main-Regular.woff2"));
    assert.equal(font.byteLength > 0, true);
    const html = await readFile(path.join(temporary, "index.html"), "utf8");
    assert.match(html, /assets\/katex\/katex\.css/);
    assert.equal(existsSync(path.join(temporary, "assets/katex-DHMw6HUq.js")), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("live clean renderer graph has no src/app inputs", { skip: !hasFrontend }, async () => {
  const { validateCleanGraph } = await import("../scripts/renderer-production-build.mjs");
  const graph = await validateCleanGraph();
  assert.deepEqual(graph.forbiddenInputs, []);
  assert.equal(graph.inputs.some((input) => isForbiddenRendererGraphInput(input)), false);
});
