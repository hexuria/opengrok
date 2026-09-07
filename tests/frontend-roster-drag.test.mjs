import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-roster-drag-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, entry)], outfile, bundle: true, format: "esm", platform: "node" });
  return { loaded: await import(`${pathToFileURL(outfile).href}?${Date.now()}`), cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// A minimal document, enough to prove the card is built and attached. The
// browser rasterises whatever is in the document when setDragImage is called,
// so "attached" is the load-bearing part.
function fakeDocument() {
  const make = (tag) => ({
    tagName: tag.toUpperCase(),
    className: "",
    textContent: "",
    children: [],
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...nodes) { this.children.push(...nodes); },
    remove() { this.removed = true; },
    cloneNode() { return { ...make(this.tagName), className: this.className, cloned: true }; },
    querySelector(selector) { return this.query?.[selector] ?? null; },
  });
  const body = make("body");
  return { body, createElement: make, make };
}

test("the drag card carries the coworker's own mark and name, attached so it can be photographed", async () => {
  const { loaded, cleanup } = await load("frontend/src/recovered/features/conversation/workspace/roster-drag-image.ts");
  try {
    const { createRosterDragImage, releaseRosterDragImage, rosterDragImageHotspot, ROSTER_DRAG_CARD_WIDTH } = loaded;
    const document = fakeDocument();
    const mark = document.make("span");
    mark.className = "sand-agent-item__avatar";
    const row = document.make("button");
    row.query = { ".sand-agent-item__avatar": mark };

    const card = createRosterDragImage({ document, name: "Peek", row });
    assert.equal(card.className, "sand-roster-drag-card");
    assert.equal(document.body.children.includes(card), true, "the card must be in the document to be rasterised");
    assert.equal(card.children[0].cloned, true, "the real mark is cloned, not re-derived");
    assert.equal(card.children[0].className, "sand-roster-drag-card__mark");
    assert.equal(card.children[1].textContent, "Peek");

    releaseRosterDragImage(card);
    releaseRosterDragImage(card);
    releaseRosterDragImage(null);

    // Official re-anchors its overlay so the pointer is at the tile's centre.
    const hotspot = rosterDragImageHotspot();
    assert.equal(hotspot.x, Math.round(ROSTER_DRAG_CARD_WIDTH / 2));
  } finally { await cleanup(); }
});

test("a row with no mark still produces a card rather than throwing", async () => {
  const { loaded, cleanup } = await load("frontend/src/recovered/features/conversation/workspace/roster-drag-image.ts");
  try {
    const document = fakeDocument();
    const row = document.make("button");
    const card = loaded.createRosterDragImage({ document, name: "New chat", row });
    assert.equal(card.children.length, 1, "just the caption");
    assert.equal(loaded.createRosterDragImage({ document: { body: null }, name: "x", row }), null);
  } finally { await cleanup(); }
});

test("the roster wires the card, the pin zone and the end of a drag", async () => {
  const sidebar = await readFile(path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/sidebar.tsx"), "utf8");
  assert.match(sidebar, /event\.dataTransfer\.setDragImage\(card, hotspot\.x, hotspot\.y\)/);
  // Official shows the dashed zone only while a coworker is being dragged, and
  // the tile rail becomes the target once anything is pinned.
  assert.match(sidebar, /aria-label="Pin drop zone"/);
  assert.match(sidebar, /Drag here to pin/);
  assert.match(sidebar, /const showPinTarget = drag != null && !drag\.isPinned/);
  // An aborted drag must clear the highlights; there was no dragend at all.
  assert.match(sidebar, /onDragEnd=\{\(\) => onDragStateChange\?\.\(null\)\}/);

  const renderer = await readFile(path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx"), "utf8");
  // Dragging out of the synthetic "Unassigned" bucket used to be a silent no-op:
  // that bucket has an empty agentIds by design, and the mover required prior
  // membership. Do not put that filter back.
  assert.doesNotMatch(renderer, /knownAgentIds\.has\(agentId\)/);
  assert.match(renderer, /const movedAgentIds = \[\.\.\.new Set\(agentIds\.filter\(\(agentId\) => agentId\.length > 0\)\)\]/);
});
