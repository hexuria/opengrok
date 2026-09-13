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

test("people @ is off until a TMP plugin/connector is enabled on this chat", () => {
  assert.equal(tmpMode.resolveTmpMode(false), false);
  assert.equal(tmpMode.resolveTmpMode(true), true);
  assert.equal(tmpMode.tmpConnectorActive({ plugins: [] }, []), false);
  assert.equal(tmpMode.tmpConnectorActive({ name: "org-users" }, []), true);
  assert.equal(tmpMode.tmpConnectorActive({}, [{ name: "weather" }]), false);
});

test("composer shows the person's name; the wire form keeps the id", () => {
  assert.equal(tmpMode.displayTmpMention("tmp:user:acct_1", "Uriah Galang"), "Uriah Galang");
  assert.equal(tmpMode.wireTmpMention("tmp:user:acct_1", "Uriah Galang"), "@user:acct_1");
  assert.equal(tmpMode.serializeTmpMentionId("tmp:user:acct_1", "Uriah Galang"), "Uriah Galang");
  const rich = JSON.stringify({
    type: "doc",
    content: [{
      type: "paragraph",
      content: [
        { type: "tmpToken", attrs: { id: "tmp:user:acct_1", label: "Uriah Galang" } },
        { type: "text", text: " say hi" },
      ],
    }],
  });
  assert.equal(tmpMode.wirePromptFromRichText(rich, "fallback"), "@user:acct_1 say hi");
  assert.equal(tmpMode.displayPromptFromRichText(rich, "fallback"), "Uriah Galang say hi");
});

test("token validation comes from the plugin, not hardcoded fields", () => {
  const years = tmpMode.parseTmpCatalog([{ name: "years", ui: "number", required: false, resolver: "value", validate: { min: 1, max: 120 } }])[0];
  assert.equal(tmpMode.validateTokenValue(years, "21"), null);
  assert.match(tmpMode.validateTokenValue(years, "abc"), /number/i);
  assert.match(tmpMode.validateTokenValue(years, "0"), /Minimum/);
  const pin = tmpMode.parseTmpCatalog([{ name: "pin", ui: "text", resolver: "value", validate: { digits: true, minLength: 4, maxLength: 6 } }])[0];
  assert.equal(tmpMode.validateTokenValue(pin, "1234"), null);
  assert.match(tmpMode.validateTokenValue(pin, "12"), /At least/);
});

test("plugin catalog tokens are listed only when a draft @person pill is active", () => {
  const catalog = tmpMode.parseTmpCatalog([
    { name: "user", displayName: "Person", ui: "list", required: true, implicit: true, resolver: "org-accounts", plugin: "org-users", mention: "person" },
    { name: "years", ui: "number", resolver: "value", plugin: "org-users", mention: "person" },
  ]);
  assert.deepEqual(catalog.map((row) => row.name), ["user", "years"]);
  assert.equal(tmpMode.tokensForActivePlugins(catalog, []).length, 0);
  assert.deepEqual(tmpMode.tokensForActivePlugins(catalog, ["person"]).map((row) => row.name), ["user", "years"]);
  assert.deepEqual(tmpMode.tokensForActivePlugins(catalog, ["tmp-plugin:org-users"]).map((row) => row.name), ["user", "years"]);
  assert.equal(tmpMode.draftActivatesTmpPlugin("{}"), false);
  const pillOnly = JSON.stringify({
    type: "doc",
    content: [{
      type: "paragraph",
      content: [{ type: "workflowReference", attrs: { id: "tmp-plugin:org-users", label: "person" } }],
    }],
  });
  assert.equal(tmpMode.draftActivatesTmpPlugin(pillOnly), true);
  assert.equal(tmpMode.displayPromptFromRichText(pillOnly, "fallback").trim(), "");
  assert.equal(tmpMode.wirePromptFromRichText(pillOnly, "fallback").trim(), "");
  assert.equal(tmpMode.tmpSubmitCheck(catalog, pillOnly).ok, false);
  assert.match(tmpMode.tmpSubmitCheck(catalog, pillOnly).error, /required/i);
  const implicit = JSON.stringify({
    type: "doc",
    content: [{
      type: "paragraph",
      content: [
        { type: "tmpPlugin", attrs: { id: "tmp-plugin:org-users", label: "person" } },
        { type: "text", text: " email Uriah the invoice" },
      ],
    }],
  });
  assert.equal(tmpMode.tmpSubmitCheck(catalog, implicit).ok, true);
  assert.equal(tmpMode.canActivateTmpPlugin(catalog, pillOnly), false);
  const mixed = JSON.stringify({
    type: "doc",
    content: [{
      type: "paragraph",
      content: [
        { type: "workflowReference", attrs: { id: "tmp-plugin:org-users", label: "person" } },
        { type: "text", text: " " },
        { type: "tmpToken", attrs: { id: "tmp:user:acct_1", label: "Uriah Galang", token: "user" } },
        { type: "text", text: " say hi" },
      ],
    }],
  });
  assert.equal(tmpMode.wirePromptFromRichText(mixed, "fallback").replace(/^\s+/, ""), "@user:acct_1 say hi");
  assert.equal(tmpMode.displayPromptFromRichText(mixed, "fallback").replace(/^\s+/, ""), "Uriah Galang say hi");
  assert.doesNotMatch(tmpMode.displayPromptFromRichText(mixed, "fallback"), /@person/);
  assert.equal(tmpMode.tmpSubmitCheck(catalog, mixed).ok, true);
  assert.equal(tmpMode.canActivateTmpPlugin(catalog, mixed), true);
});

test("shipped composer keeps @ for bots and puts plugin tokens on #", async () => {
  const composer = await readFile(composerSource, "utf8");
  const renderer = await readFile(rendererSource, "utf8");
  const editor = await readFile(editorSource, "utf8");
  const mode = await readFile(tmpModeSource, "utf8");
  assert.doesNotMatch(composer, /sand-tmp-tag/);
  assert.doesNotMatch(composer, />People</);
  assert.doesNotMatch(mode, /leadingBangEnablesTmp/);
  assert.match(renderer, /parseTmpCatalog/);
  assert.match(renderer, /tmp: \{/);
  assert.match(editor, /hashSuggestion/);
  assert.match(editor, /name: "tmpToken"/);
  assert.match(editor, /name: "tmpPlugin"/);
  assert.match(editor, /type: "tmpToken"/);
  assert.match(editor, /type: "tmpPlugin"/);
  assert.match(editor, /char: "#"/);
  assert.match(editor, /char: "@"/);
  assert.match(editor, /char: "\/"/);
  assert.match(editor, /placeMenuAbove/);
  assert.match(editor, /window\.innerHeight - anchor\.top/);
  assert.doesNotMatch(editor, /tmpMode\?\.\(\) === true/);
  assert.match(renderer, /displayPromptFromRichText/);
  assert.match(renderer, /tmpWire: wirePrompt/);
  assert.match(renderer, /text: displayPrompt/);
  assert.match(renderer, /draftActivatesTmpPlugin/);
  assert.match(renderer, /tokensForActivePlugins/);
  assert.match(renderer, /tmpSubmitCheck/);
  assert.doesNotMatch(renderer, /resolveTmpMode\(tmpPluginOn\)/);
  assert.match(editor, /promptSuggestionVisible/);
  assert.match(editor, /sand-workflow-chip__icon/);
  assert.match(editor, /rows\.length === 0\) return true/);
});
