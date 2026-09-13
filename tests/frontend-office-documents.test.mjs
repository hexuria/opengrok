import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import { buildZip } from "./zip-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-office-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/office-documents.ts")], outfile, bundle: true, format: "esm", platform: "node" });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// The RTF reader is the one that runs without a DOM, so it carries the format
// edge cases: \uN with the ASCII fallback the \ucN count tells us to skip
// (a careless stripper leaves a stray "?"), \'hh code-page escapes, run
// toggles that must close in order, and destination groups that never render.
test("rtf reduces to paragraphs with bold/italic runs and decodes escapes", async () => {
  const { loaded, cleanup } = await load();
  try {
    const source = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Helvetica;}}{\colortbl;\red0\green0\blue0;}{\*\generator Mock 1.0;}
\pard\b Heading\b0\par
Plain, {\b bold} and {\i italic}, caf\u233? and na\'efve.\tab tabbed\par
Second paragraph\line with a line break.\par
}`;
    const rendered = loaded.rtfToHtml(source);
    assert.equal(rendered.html, "<p><strong>Heading</strong></p><p>Plain, <strong>bold</strong> and <em>italic</em>, café and naïve.\ttabbed</p><p>Second paragraph<br>with a line break.</p>");
    assert.equal(rendered.summary, "16 words");
    assert.equal(loaded.rtfToHtml("not rtf at all"), null);
    assert.equal(loaded.rtfToHtml(String.raw`{\rtf1 <script>alert(1)</script>\par}`).html, "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  } finally { await cleanup(); }
});

test("zip package reads stored and deflated members, including the ODF mimetype at offset 38", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "grok-office-zip-"));
  const { loaded, cleanup } = await load();
  try {
    await mkdir(path.join(work, "META-INF"), { recursive: true });
    await writeFile(path.join(work, "mimetype"), "application/vnd.oasis.opendocument.text");
    await writeFile(path.join(work, "content.xml"), `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body><office:text>${"<text:p xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\">hello</text:p>".repeat(40)}</office:text></office:body></office:document-content>`);
    const contentXml = await readFile(path.join(work, "content.xml"));
    await writeFile(path.join(work, "doc.odt"), buildZip([
      { name: "mimetype", data: "application/vnd.oasis.opendocument.text", method: 0 },
      { name: "content.xml", data: contentXml, method: 8 },
      { name: "META-INF/", directory: true },
    ]));
    const bytes = new Uint8Array(await readFile(path.join(work, "doc.odt")));
    assert.equal(new TextDecoder().decode(bytes.subarray(38, 38 + 39)), "application/vnd.oasis.opendocument.text");
    const pkg = new loaded.ZipPackage(bytes);
    assert.ok(pkg.has("mimetype") && pkg.has("content.xml"));
    assert.equal(await pkg.readText("mimetype"), "application/vnd.oasis.opendocument.text");
    const content = await pkg.readText("content.xml");
    assert.ok(content.startsWith("<?xml") && content.split("<text:p").length === 41, "deflated member inflates to the original XML");
    assert.equal(await pkg.read("missing.xml"), null);
  } finally { await cleanup(); await rm(work, { recursive: true, force: true }); }
});

test("officeReaderFor routes readers by extension and leaves legacy formats to Download", async () => {
  const { loaded, cleanup } = await load();
  try {
    assert.deepEqual(["a.docx", "a.dotx", "a.pptx", "a.odt", "a.odp", "a.rtf", "a.doc", "a.ppt", "a.key", "a.pages", "a.numbers"].map((name) => loaded.officeReaderFor(name)), ["docx", "docx", "pptx", "odt", "odp", "rtf", null, null, null, null, null]);
  } finally { await cleanup(); }
});
