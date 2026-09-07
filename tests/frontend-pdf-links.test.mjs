import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-pdf-links-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/pdf-links.ts")], outfile, bundle: true, format: "esm", platform: "node" });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const pageRef = { num: 7, gen: 0 };
function fakeDocument(overrides = {}) {
  return {
    numPages: 10,
    getDestination: async (name) => (name === "glossary" ? [pageRef, { name: "XYZ" }, 0, 500, null] : null),
    getPageIndex: async (ref) => (ref === pageRef ? 3 : Promise.reject(new Error("unknown ref"))),
    ...overrides,
  };
}

// The shipped pdf.js link element hands the service either the named
// destination string from the PDF or an explicit array; both must land on a
// 1-based page number, and every malformed shape must come back null rather
// than throw into the annotation layer's render promise.
test("resolveDestination maps named and explicit destinations to page numbers", async () => {
  const { loaded, cleanup } = await load();
  try {
    const doc = fakeDocument();
    assert.deepEqual(await loaded.resolveDestination(doc, "glossary"), { pageNumber: 4, explicit: [pageRef, { name: "XYZ" }, 0, 500, null] });
    assert.equal((await loaded.resolveDestination(doc, [2, { name: "Fit" }])).pageNumber, 3);
    assert.equal(await loaded.resolveDestination(doc, "missing"), null);
    assert.equal(await loaded.resolveDestination(doc, ""), null);
    assert.equal(await loaded.resolveDestination(doc, [{ num: 99, gen: 0 }, { name: "Fit" }]), null);
    assert.equal(await loaded.resolveDestination(doc, [10, { name: "Fit" }]), null, "zero-based index 10 is past a 10 page document");
    assert.equal(await loaded.resolveDestination(doc, [-1, { name: "Fit" }]), null);
    assert.equal(await loaded.resolveDestination(doc, 42), null);
    assert.equal(await loaded.resolveDestination(doc, null), null);
    assert.equal(await loaded.resolveDestination(doc, []), null);
    assert.equal(await loaded.resolveDestination(fakeDocument({ getDestination: async () => { throw new Error("boom"); } }), "glossary"), null);
  } finally { await cleanup(); }
});

test("destinationTopOffset converts PDF user-space y into a scaled top offset", async () => {
  const { loaded, cleanup } = await load();
  try {
    assert.equal(loaded.destinationTopOffset([pageRef, { name: "XYZ" }, 72, 500, null], 792, 1.5), (792 - 500) * 1.5);
    assert.equal(loaded.destinationTopOffset([pageRef, { name: "FitH" }, 792], 792, 1), 0);
    assert.equal(loaded.destinationTopOffset([pageRef, { name: "FitBH" }, 700], 792, 2), 184);
    assert.equal(loaded.destinationTopOffset([pageRef, { name: "FitR" }, 0, 0, 100, 600], 792, 1), 192);
    assert.equal(loaded.destinationTopOffset([pageRef, "XYZ", 0, 500, null], 792, 1), 292, "a bare string kind is accepted too");
    assert.equal(loaded.destinationTopOffset([pageRef, { name: "Fit" }], 792, 1), 0);
    assert.equal(loaded.destinationTopOffset([pageRef, { name: "XYZ" }, 0, null, null], 792, 1), 0);
    assert.equal(loaded.destinationTopOffset([pageRef, { name: "XYZ" }, 0, 900, null], 792, 1), 0, "above the page clamps to the top");
    assert.equal(loaded.destinationTopOffset([pageRef, { name: "XYZ" }, 0, -50, null], 792, 1), 792, "below the page clamps to the bottom");
    assert.equal(loaded.destinationTopOffset(null, 792, 1), 0);
    assert.equal(loaded.destinationTopOffset([pageRef, { name: "XYZ" }, 0, 500, null], 0, 1), 0);
  } finally { await cleanup(); }
});

test("flattenOutline walks the bookmark tree depth-first with depths, keys and a cap", async () => {
  const { loaded, cleanup } = await load();
  try {
    const entries = loaded.flattenOutline([
      { title: "Intro", dest: "intro", items: [
        { title: "  ", dest: "blank" },
        { title: "Scope", dest: [0, { name: "Fit" }], items: [{ title: "Detail", dest: "detail" }] },
      ] },
      { title: "Docs", url: "https://example.com/docs", dest: null },
    ]);
    assert.deepEqual(entries.map((entry) => [entry.title, entry.depth]), [["Intro", 0], ["Scope", 1], ["Detail", 2], ["Docs", 0]]);
    assert.equal(entries[3].url, "https://example.com/docs");
    assert.equal(entries[0].url, null);
    assert.deepEqual(entries[1].dest, [0, { name: "Fit" }]);
    assert.equal(new Set(entries.map((entry) => entry.key)).size, entries.length, "keys are unique");
    assert.deepEqual(loaded.flattenOutline(null), []);
    assert.deepEqual(loaded.flattenOutline([{ title: "Deep", items: [{ title: "Deeper" }] }], 0).map((entry) => entry.title), ["Deep"]);
    const huge = Array.from({ length: loaded.PDF_OUTLINE_ENTRY_CAP + 50 }, (_, index) => ({ title: `Item ${index}` }));
    assert.equal(loaded.flattenOutline(huge).length, loaded.PDF_OUTLINE_ENTRY_CAP);
  } finally { await cleanup(); }
});

test("link service: external links become _blank anchors, unsafe schemes are disabled", async () => {
  const { loaded, cleanup } = await load();
  try {
    const service = loaded.createPdfLinkService(fakeDocument(), () => {}, { currentPage: () => 1, pageCount: () => 10, goToPage: () => {} });
    const anchor = () => ({ href: "", title: "", target: "", rel: "", onclick: null });
    const https = anchor();
    service.addLinkAttributes(https, "https://user:secret@example.com/a", true);
    assert.equal(https.href, "https://user:secret@example.com/a");
    assert.equal(https.title, "https://example.com/a", "credentials never show in the tooltip");
    assert.equal(https.target, "_blank");
    assert.equal(https.rel, "noopener noreferrer");
    assert.equal(https.onclick, null);
    const mail = anchor();
    service.addLinkAttributes(mail, "mailto:hi@example.com");
    assert.equal(mail.target, "_blank");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", ""]) {
      const element = anchor();
      service.addLinkAttributes(element, bad);
      assert.equal(element.href, "", bad);
      assert.equal(element.target, "");
      assert.equal(element.onclick(), false, `${bad} click is swallowed`);
      assert.match(element.title, /^Disabled/);
    }
    assert.equal(service.getAnchorUrl("#x"), "#x");
    assert.equal(service.getDestinationHash("glossary"), "#nameddest=glossary");
    assert.equal(service.getDestinationHash([2, { name: "Fit" }]), `#dest=${encodeURIComponent(JSON.stringify([2, { name: "Fit" }]))}`);
    assert.equal(service.getDestinationHash(""), "");
    assert.equal(service.getDestinationHash(undefined), "");
    assert.equal(service.eventBus, undefined);
    assert.equal(service.externalLinkEnabled, true);
    service.executeSetOCGState({});
  } finally { await cleanup(); }
});

test("link service: goToDestination resolves then navigates; named actions page within bounds", async () => {
  const { loaded, cleanup } = await load();
  try {
    const targets = [];
    const pages = [];
    let current = 1;
    const service = loaded.createPdfLinkService(fakeDocument(), (target) => targets.push(target), { currentPage: () => current, pageCount: () => 10, goToPage: (page) => pages.push(page) });
    service.goToDestination("glossary");
    service.goToDestination("missing");
    service.goToDestination([1, { name: "Fit" }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(targets.map((target) => target.pageNumber).sort(), [2, 4], "the unresolvable one is dropped; arrival order follows promise depth");
    service.executeNamedAction("NextPage");
    current = 10;
    service.executeNamedAction("NextPage");
    service.executeNamedAction("PrevPage");
    current = 1;
    service.executeNamedAction("PrevPage");
    service.executeNamedAction("FirstPage");
    service.executeNamedAction("LastPage");
    service.executeNamedAction("Print");
    assert.deepEqual(pages, [2, 10, 9, 1, 1, 10]);
    const empty = loaded.createPdfLinkService(fakeDocument({ numPages: 0 }), () => {}, { currentPage: () => 1, pageCount: () => 0, goToPage: () => { throw new Error("must not page an empty document"); } });
    empty.executeNamedAction("NextPage");
  } finally { await cleanup(); }
});

test("mostVisiblePage picks the page showing the most of itself, so a clamped jump reports the destination", async () => {
  const { loaded, cleanup } = await load();
  try {
    // Two 696px pages at 72 and 788 in a 957px viewport whose scroll clamps at 547:
    // the top-edge probe said page 1; page 2 is the one mostly on screen.
    const bands = [{ top: 72, height: 696 }, { top: 788, height: 696 }];
    assert.equal(loaded.mostVisiblePage(bands, 547, 957), 2);
    assert.equal(loaded.mostVisiblePage(bands, 0, 957), 1);
    assert.equal(loaded.mostVisiblePage(bands, 400, 957), 2, "page 1 shows 72+696-400=368px, page 2 shows 400+957-788=569px");
    assert.equal(loaded.mostVisiblePage(bands, 100, 500), 1, "page 1 shows 500px, page 2 none");
    assert.equal(loaded.mostVisiblePage([{ top: 0, height: 100 }, { top: 120, height: 100 }], 5000, 500), 2, "nothing overlaps: last page whose top is above the fold");
    assert.equal(loaded.mostVisiblePage([], 0, 500), 1);
  } finally { await cleanup(); }
});
