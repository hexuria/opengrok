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
  /*
   * The drag-started signal MUST stay deferred. Rendering the pin target changes
   * the DOM, and a DOM change inside the dragstart handler makes Chromium
   * abandon the drag it was about to start — dragstart and dragend both fired in
   * the same tick and no drag ever happened, so neither the card nor the zone
   * was ever seen. Synthetic DragEvents hide this completely: they fire the
   * handlers whether or not a real drag would survive (operator's report,
   * 2026-09-08).
   */
  assert.match(sidebar, /setTimeout\(\(\) => onDragStateChange\?\.\(started\), 0\)/);
  // Official shows the dashed zone only while a coworker is being dragged, and
  // the tile rail becomes the target once anything is pinned.
  assert.match(sidebar, /aria-label="Pin drop zone"/);
  assert.match(sidebar, /Drag here to pin/);
  assert.match(sidebar, /const showPinTarget = drag != null && !drag\.isPinned/);
  // The rail gets the zone too, as a 54px cell with the glyph and no words.
  assert.doesNotMatch(sidebar, /showPinTarget = drag != null && !drag\.isPinned && !isCollapsed/);
  const view = await readFile(path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/view.css"), "utf8");
  assert.match(view, /\.sand-agents-pin-zone \{[^}]*height: 104px;/s, "official's 104px box");
  assert.match(view, /\.sand-workspace-rail\[data-sidebar-collapsed\] \.sand-agents-pin-zone__label \{ display: none; \}/);
  /*
   * A section keeps its SPACE in the rail even though its name cannot be shown.
   * Without the stand-in the header's 30px vanished and every coworker below it
   * sat at a different height than in the open sidebar — the column jumped on
   * collapse (operator's report, 2026-09-08).
   */
  assert.match(sidebar, /className="sand-agents-section__rail-rule"/);
  assert.match(view, /\.sand-agents-section__rail-rule \{[^}]*height: 30px;/s);
  assert.match(view, /\.sand-agents-section__header \{[^}]*height: 30px;/s, "the two heights must stay equal");
  // An aborted drag must clear the highlights; there was no dragend at all.
  assert.match(sidebar, /onDragEnd=\{\(\) => onDragStateChange\?\.\(null\)\}/);

  /*
   * The rail and the open sidebar must share ONE section drop surface. They
   * were two branches of the same ternary and only the open one carried the
   * handlers, so in the mini sidebar the pin zone was the only thing that
   * accepted a drop — dragging into another section was impossible
   * (operator's report, 2026-09-08).
   */
  assert.match(sidebar, /const sectionDropProps = \(sectionId: string\) => \(\{/);
  assert.equal(sidebar.match(/\{\.\.\.sectionDropProps\(section\.id\)\}/g)?.length, 2, "both branches take a drop");
  assert.equal(sidebar.match(/className=\{sectionClassName\(section\.id\)\}/g)?.length, 2, "and both highlight while hovered");
  // A pinned coworker is draggable into a section without being unpinned first.
  assert.match(sidebar, /const canMoveToSection = onMoveAgentToSection != null;/);
  assert.doesNotMatch(sidebar, /const canMoveToSection = !agent\.isPinned/);
  const rowActions = await readFile(path.join(repoRoot, "frontend/src/production/AgentRowActions.tsx"), "utf8");
  assert.doesNotMatch(rowActions, /const canMoveToSection = !isPinned/, "the menu offers the move while pinned too");

  const renderer = await readFile(path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx"), "utf8");
  /*
   * Landing in a section unpins. projectSidebarSections filters every pinned id
   * out of every section, so writing membership for a pinned coworker was a
   * silent no-op and the drag looked broken.
   */
  assert.match(renderer, /const stillPinned = pinnedAgentIdsRef\.current\.filter\(\(agentId\) => !moved\.has\(agentId\)\)/);
  assert.match(renderer, /if \(stillPinned\.length !== pinnedAgentIdsRef\.current\.length\) persistPinnedAgentIds\(stillPinned\)/);
  // Dragging out of the synthetic "Unassigned" bucket used to be a silent no-op:
  // that bucket has an empty agentIds by design, and the mover required prior
  // membership. Do not put that filter back.
  assert.doesNotMatch(renderer, /knownAgentIds\.has\(agentId\)/);
  assert.match(renderer, /const movedAgentIds = \[\.\.\.new Set\(agentIds\.filter\(\(agentId\) => agentId\.length > 0\)\)\]/);
});
