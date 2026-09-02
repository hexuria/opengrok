import assert from "node:assert/strict";
import test from "node:test";
import * as acorn from "acorn";
import { BRAND_HELPER_NAME, patchOriginalBrandText } from "../scripts/lib/brand-text-patch.mjs";

const parses = (source) => acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });

// Signed in to an OpenGrok server the product is "Open Grok"; the 0.30 renderer hardcodes
// "Grok Bot" in ~100 strings. The build routes each through a runtime helper keyed on the
// page's OpenGrok-mode flag, so the same bundle reads right for both backends.
test("string literals and template text that name the brand go through the runtime helper", () => {
  const source = 'const a="Grok Bot can run commands on your computer.";'
    + "const b=`Restart to finish installing Grok Bot ${n}. Grok Bot will reopen.`;"
    + 'const c=\'They paste this into Grok Bot via "Cmd-K"\';'
    + 'const d="unrelated";';
  const result = patchOriginalBrandText(source);
  parses(result.source);
  assert.equal(result.wrapped, 2);
  assert.equal(result.templates, 2, "two text segments around ${n}");
  assert.ok(result.source.includes(`${BRAND_HELPER_NAME}("Grok Bot can run commands on your computer.")`));
  assert.ok(result.source.includes("`Restart to finish installing ${" + BRAND_HELPER_NAME + '("Grok Bot")} ${n}. ${' + BRAND_HELPER_NAME + '("Grok Bot")} will reopen.`'));
  assert.ok(result.source.includes('"unrelated"'), "other strings untouched");
  assert.ok(result.source.startsWith(`var ${BRAND_HELPER_NAME}=`), "helper injected first");
});

test("a quote inside a template or regex never fools the pass, and keys, tags and the official name are left alone", () => {
  const source = 'const r=/"Grok Bot"/;'
    + "const t=`say \"hi\" ${x} Grok Bot`;"
    + 'const k={"Grok Bot":1};'
    + "const g=tag`Grok Bot ${y}`;"
    + 'const o="like official Grok Bot 0.29";'
    + 'const lab="Grok Bot Lab is a one-off test build";'
    + 'const P=[{id:"cursor",label:"Cursor",title:"Grok Bot",lede:"x"}];';
  const result = patchOriginalBrandText(source);
  parses(result.source);
  assert.equal(result.templates, 1, "the untagged template is branded");
  assert.equal(result.wrapped, 0);
  assert.equal(result.skippedKeys, 1);
  assert.equal(result.skippedTagged, 1);
  assert.equal(result.kept, 3, "official name, Lab build, and the Cursor first-run card");
  assert.ok(result.source.includes('/"Grok Bot"/'), "regex untouched");
  assert.ok(result.source.includes('{"Grok Bot":1}'), "object key untouched");
  assert.ok(result.source.includes('"like official Grok Bot 0.29"'));
  assert.ok(result.source.includes('label:"Cursor",title:"Grok Bot",lede'), "the Cursor card keeps the official name");
});

test("the pass is idempotent and a no-op on sources without the brand", () => {
  const once = patchOriginalBrandText('const a="Grok Bot";');
  const twice = patchOriginalBrandText(once.source);
  assert.equal(twice.source, once.source);
  assert.equal(twice.already, true);
  assert.equal(patchOriginalBrandText('const a="Open Grok";').source, 'const a="Open Grok";');
});

test("the runtime helper swaps the name only when the page is in OpenGrok mode", () => {
  const result = patchOriginalBrandText('export const text = "Grok Bot can run commands on your computer.";');
  const store = new Map();
  const localStorage = { getItem: (key) => store.get(key) ?? null };
  const fn = new Function("localStorage", `${result.source.replace("export const text", "const text")}; return text;`);
  assert.equal(fn(localStorage), "Grok Bot can run commands on your computer.");
  store.set("sand-opengrok-mode", "1");
  assert.equal(fn(localStorage), "Open Grok can run commands on your computer.");
  const throwing = { getItem: () => { throw new Error("blocked"); } };
  assert.equal(fn(throwing), "Grok Bot can run commands on your computer.", "a blocked storage means the official name");
});
