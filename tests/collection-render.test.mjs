import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(dir) {
  const outfile = path.join(dir, "collection-render.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/shared/collections/collection-render.ts")],
    outfile, bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "silent",
  });
  return import(`${pathToFileURL(outfile).href}?${Date.now()}`);
}

let mod;
let dir;
test.before(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "collection-render-")); mod = await loadModule(dir); });
test.after(async () => { await rm(dir, { recursive: true, force: true }); });

// The archive used to print its source while the chat set the same text. These are the
// constructs the chat renders, so the archive renders them too.
test("a saved message reads like it did in the chat", () => {
  const html = (text) => mod.renderCollectionText(text);
  assert.match(html("**bold** and *italic*"), /<strong>bold<\/strong> and <em>italic<\/em>/);
  assert.match(html("1. one\n2. two"), /<ol>[\s\S]*<li>one<\/li>[\s\S]*<li>two<\/li>[\s\S]*<\/ol>/);
  assert.match(html("- a\n- b"), /<ul>[\s\S]*<li>a<\/li>/);
  assert.match(html("## A heading"), /<h2>A heading<\/h2>/);
  assert.match(html("| a | b |\n|---|---|\n| 1 | 2 |"), /<table>[\s\S]*<th>a<\/th>[\s\S]*<td>2<\/td>/);
  assert.match(html("`inline`"), /<code>inline<\/code>/);
  assert.match(html("```js\nconst x = 1 < 2;\n```"), /<pre class="sand-col-code"><code>const x = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html("> quoted"), /<blockquote>/);
});

test("math renders as MathML, by the chat's rules", () => {
  const display = mod.renderCollectionText("$$\\frac{1}{2}$$");
  assert.match(display, /class="sand-col-math"/);
  assert.match(display, /<math[^>]*display="block"/, "a block of its own is display math");
  assert.match(display, /<mfrac>/);
  const inline = mod.renderCollectionText("Inline \\(x^2\\) here");
  assert.match(inline, /<p>Inline <span class="katex"><math/, "the LLM's \\(…\\) form is math, inline");
  assert.doesNotMatch(inline, /display="block"/);
  assert.equal(mod.renderCollectionText("it costs $5 and $6 total"), "<p>it costs $5 and $6 total</p>", "a single dollar is money, never math");
  assert.match(mod.renderCollectionText("`$$\\frac12$$`"), /<code>\$\$/, "math inside code stays code");
  assert.match(mod.renderCollectionText("$$\\notacommand{}$$"), /sand-col-math/, "unrenderable math still lands as something");
});

test("nothing a message says can become markup", () => {
  const html = mod.renderCollectionText("<script>alert('x')</script>\n\n[x](javascript:alert(1))\n\n<img src=x onerror=y>");
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /&lt;script&gt;/, "it is shown, as text");
});

test("a link opens with no referrer and no opener", () => {
  assert.match(mod.renderCollectionText("see https://example.com/x"), /<a href="https:\/\/example\.com\/x" rel="noreferrer noopener">/);
});

test("the LLM's bracket forms are rewritten outside code only", () => {
  assert.equal(mod.normalizeCollectionMath("\\[a\\] and \\(b\\)"), "$$a$$ and $$b$$");
  assert.equal(mod.normalizeCollectionMath("`\\(b\\)`"), "`\\(b\\)`", "inline code is left alone");
  assert.equal(mod.normalizeCollectionMath("```\n\\[a\\]\n```"), "```\n\\[a\\]\n```", "a fence is left alone");
});

// A file should look like the window it was saved from, on any machine — the reader's own
// preference is not a vote, and a PDF has no reader to ask.
test("an export carries one theme: the one it was exported from", () => {
  const of = (theme) => mod.buildCollectionExportHtml({
    name: "Yas sir", messages: [], exportedAt: "Sep 2, 2026", permalink: "opengrok://app/v1/collection?id=c1",
    mediaSrc: () => null, formatTimestamp: () => "", ...(theme == null ? {} : { theme }),
  });
  const dark = of("dark");
  assert.match(dark, /color-scheme:dark/);
  assert.match(dark, /background:#070707/);
  assert.doesNotMatch(dark, /prefers-color-scheme/, "the reader's machine does not get a vote");
  assert.doesNotMatch(dark, /#ededed/, "and the other palette is not in the file at all");
  const light = of("light");
  assert.match(light, /color-scheme:light/);
  assert.match(light, /background:#fff/);
  assert.doesNotMatch(light, /#070707/);
  assert.match(of(undefined), /color-scheme:light/, "no theme given means light");
  assert.match(dark, /break-inside:avoid/, "and a printed page does not split a bubble");
});
