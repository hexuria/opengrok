import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  copyKatexRuntimeAssets,
  copyRuntimeAssets,
  generateRendererPlaceholderAsset,
  isForbiddenRuntimeAssetSource,
  isSrcAppArtifactRoot,
  planRuntimeAssetCopy,
  validateCleanGraph,
  validateRuntimeAssetBytes,
} from "../scripts/renderer-production-build.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendEntrypoint = path.join(repoRoot, "frontend/src/main.tsx");
const hasFrontend = existsSync(frontendEntrypoint);
const hasKatex = existsSync(path.join(repoRoot, "node_modules/katex/package.json"));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("KaTeX is vendored from npm, not the 0.18 renderer tree", async () => {
  const source = await readFile(path.join(repoRoot, "scripts/renderer-production-build.mjs"), "utf8");
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.dependencies.katex, "0.16.45");
  assert.match(source, /const KATEX_VERSION = "0\.16\.45"/);
  assert.match(source, /path\.join\(repoRoot, "node_modules", "katex"\)/);
  assert.doesNotMatch(source, /src\/app\/dist\/renderer\/assets\/katex/);
  const copyKatex = source.slice(source.indexOf("export async function copyKatexRuntimeAssets"));
  assert.match(copyKatex, /node_modules", "katex"/);
  assert.doesNotMatch(copyKatex.slice(0, copyKatex.indexOf("export async function rewritePdfAssetReferences")), /src\/app/);
});

test("the clean renderer graph still forbids src/app inputs", async () => {
  const source = await readFile(path.join(repoRoot, "scripts/renderer-production-build.mjs"), "utf8");
  assert.match(
    source,
    /forbiddenInputs = inputs\.filter\(input => input === "src\/app" \|\| input\.startsWith\("src\/app\/"\) \|\| input\.startsWith\("recovered\/source-capsules\/"\)\)/,
  );
});

test("src/app runtime assets are generated or skipped, never hashed as 0.18", () => {
  assert.equal(isSrcAppArtifactRoot("src/app/dist/renderer/assets"), true);
  assert.equal(isSrcAppArtifactRoot("frontend/src/recovered/assets"), false);
  assert.equal(isForbiddenRuntimeAssetSource(path.join(repoRoot, "src/app/dist/renderer/assets/app-icon-C7NKj2u7.png")), true);
  assert.equal(isForbiddenRuntimeAssetSource(path.join(repoRoot, "frontend/src/recovered/assets/app-icon.png")), false);

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
  assert.equal(katexPlan.action, "skip");
  assert.equal(generateRendererPlaceholderAsset("katex-DHMw6HUq.js"), null);

  const wavPlan = planRuntimeAssetCopy({ file: "ping-1-open-blip.wav" }, "src/app/dist/renderer/assets");
  assert.equal(wavPlan.action, "generate");
  assert.equal(wavPlan.bytes.toString("ascii", 0, 4), "RIFF");

  const jpgPlan = planRuntimeAssetCopy(
    { file: "demo-computer-wallpaper-BO7Ye4dV.jpg", sha256: "90e253579c5e6ff18cb03059bbe380d64263222be48360802cda58e3d8392216" },
    "src/app/dist/renderer/assets",
  );
  assert.equal(jpgPlan.action, "skip");

  const allowed = planRuntimeAssetCopy({ file: "app-icon.png", sha256: "abc" }, "frontend/src/recovered/assets");
  assert.equal(allowed.action, "copy");
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
      `export const icon = rendererRuntimeAssetUrl("app-icon-C7NKj2u7.png");\nexport const logo = rendererRuntimeAssetUrl("calendly-DYRMkyLM.svg");\n`,
    );
    const manifest = {
      schemaVersion: 1,
      artifactRoot: "src/app/dist/renderer/assets",
      assets: [
        { file: "app-icon-C7NKj2u7.png", sha256: "79e6a73e634ce7ad8d1982739e9064bcc9c9ec5106bdd7281d7514ee68169ad2" },
        { file: "calendly-DYRMkyLM.svg", sha256: "0ea3b3784f04256aa1dbe27c1e7b8a01a83c29be470f3326e0fd18003cd353f0" },
      ],
      immutableAssets: [
        { file: "katex-DHMw6HUq.js", bytes: 259053, sha256: "8c143536a1933d1f96d975b0e7dcbd6057bb0885fea799852896530b3234d08a" },
      ],
    };
    const copied = await copyRuntimeAssets(rendererRoot, { manifest, frontendRoot });
    assert.deepEqual(copied.map((asset) => asset.file).sort(), ["app-icon-C7NKj2u7.png", "calendly-DYRMkyLM.svg"]);
    for (const asset of copied) {
      assert.equal(asset.source, "generated");
      assert.notEqual(asset.sha256, manifest.assets.find((row) => row.file === asset.file)?.sha256);
      const bytes = await readFile(path.join(rendererRoot, "assets", asset.file));
      assert.equal(sha256(bytes), asset.sha256);
    }
    assert.equal(existsSync(path.join(rendererRoot, "assets", "katex-DHMw6HUq.js")), false);
    if (existsSync(srcAppAsset)) {
      const upstream = sha256(await readFile(srcAppAsset));
      assert.notEqual(copied.find((asset) => asset.file === "app-icon-C7NKj2u7.png").sha256, upstream);
    }
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
  const graph = await validateCleanGraph();
  assert.deepEqual(graph.forbiddenInputs, []);
  assert.equal(graph.inputs.some((input) => input === "src/app" || input.startsWith("src/app/")), false);
});
