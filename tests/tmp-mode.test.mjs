import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpModeSource = path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/tmp-mode.ts");
const composerSource = path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/composer.tsx");
const rendererSource = path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx");
const editorSource = path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx");

async function loadTmpMode() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tmp-mode-"));
  const outfile = path.join(dir, "tmp-mode.mjs");
  await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: [tmpModeSource],
    format: "esm",
    outfile,
    platform: "neutral",
    logLevel: "silent",
  });
  const mod = await import(pathToFileURL(outfile).href);
  await rm(dir, { recursive: true, force: true });
  return mod;
}

const tmpMode = await loadTmpMode();

test("leading bang turns TMP on and is stripped before send", () => {
  assert.equal(tmpMode.leadingBangEnablesTmp("!@user"), true);
  assert.equal(tmpMode.stripLeadingBang("! @user"), "@user");
  assert.equal(tmpMode.stripLeadingBang("hello"), "hello");
});

test("without a TMP plugin bang and sticky do nothing", () => {
  assert.equal(tmpMode.resolveTmpMode("!@user", false), false);
  assert.equal(tmpMode.resolveTmpMode("hello", false, true), false);
});

test("sticky false keeps skills on @ until bang", () => {
  assert.equal(tmpMode.resolveTmpMode("hello", true, false), false);
  assert.equal(tmpMode.resolveTmpMode("!hello", true, false), true);
});

test("plugin tokens on means TMP is on until turned off", () => {
  assert.equal(tmpMode.resolveTmpMode("hello", true), true);
});

test("tmp mention serializes as @token:id not a skill name", () => {
  assert.equal(tmpMode.serializeTmpMentionId("tmp:user:acct_1", "Uriah"), "@user:acct_1");
  assert.equal(tmpMode.serializeTmpMentionId("agent-9", "Quill"), "@Quill");
});

test("shipped composer paints the TMP chip only with pluginTokensOn and renderer asks tmpComplete", async () => {
  const composer = await readFile(composerSource, "utf8");
  const renderer = await readFile(rendererSource, "utf8");
  const editor = await readFile(editorSource, "utf8");
  assert.match(composer, /data-tmp-mode="on"/);
  assert.match(composer, /pluginTokensOn/);
  assert.match(renderer, /client\.call\("tmpComplete"/);
  assert.match(renderer, /pluginTokensOn=\{tmpPluginOn\}/);
  assert.match(renderer, /body\.catalog/);
  assert.match(editor, /tmp-token/);
  assert.match(editor, /char: "@"/);
  assert.match(editor, /char: "\/"/);
  assert.match(editor, /providers\?\.tmpMode\?\.\(\) === true/);
});
