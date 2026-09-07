import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-responsive-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/sidebar-responsive.ts")], outfile, bundle: true, format: "esm", platform: "node" });
  return { loaded: await import(`${pathToFileURL(outfile).href}?${Date.now()}`), cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

async function loadLayoutStore() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-layout-store-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/sidebar-layout-state.ts")], outfile, bundle: true, format: "esm", platform: "node" });
  return { loaded: await import(`${pathToFileURL(outfile).href}?${Date.now()}`), cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// The rail the app picks for a narrow window is not a choice, so it must not be
// written down. It used to be: the next launch read it back as the person's
// preference, and widening the window then left them on the rail forever.
test("an automatic collapse changes the layout without storing it", async () => {
  const { loaded, cleanup } = await loadLayoutStore();
  try {
    const written = [];
    const store = loaded.createUiLayoutStateStore({
      read: async () => null,
      write: async (key, value) => { written.push({ key, value }); },
      clear: async () => {}
    });
    const base = store.sidebarLayout.get();

    store.setSidebarLayout({ ...base, isCollapsed: true }, { persist: false });
    assert.equal(store.sidebarLayout.get().isCollapsed, true, "the sidebar still collapses");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(written, [], "and nothing was written");

    store.setSidebarLayout({ ...base, isCollapsed: false });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(written.length, 1, "a deliberate toggle is still stored");
    store.dispose();
  } finally { await cleanup(); }
});

test("a narrow window collapses the sidebar, and widening restores what the person had", async () => {
  const { loaded, cleanup } = await load();
  try {
    let s = loaded.EMPTY_RESPONSIVE_COLLAPSE;
    let r = loaded.collapseForWidth(s, 1400, false);
    assert.equal(r.apply, null, "staying wide changes nothing");
    s = r.next;
    r = loaded.collapseForWidth(s, 720, false);
    assert.equal(r.apply, true, "a tablet width collapses it");
    s = r.next;
    r = loaded.collapseForWidth(s, 640, true);
    assert.equal(r.apply, null, "still narrow: leave it alone");
    s = r.next;
    r = loaded.collapseForWidth(s, 1400, true);
    assert.equal(r.apply, false, "back on a wide screen it reopens, because that is what they had");
  } finally { await cleanup(); }
});

// Collapsing because the window is small must never be mistaken for a choice.
test("a rail the person chose on a wide screen survives a trip through narrow", async () => {
  const { loaded, cleanup } = await load();
  try {
    let s = loaded.EMPTY_RESPONSIVE_COLLAPSE;
    s = loaded.collapseForWidth(s, 1400, false).next;
    s = loaded.rememberChoice(s, true);
    let r = loaded.collapseForWidth(s, 700, true);
    assert.equal(r.apply, true);
    s = r.next;
    s = loaded.rememberChoice(s, false);
    r = loaded.collapseForWidth(s, 1400, true);
    assert.equal(r.apply, true, "expanding while narrow is not a preference; their rail comes back");
  } finally { await cleanup(); }
});

test("the threshold and a nonsense width", async () => {
  const { loaded, cleanup } = await load();
  try {
    assert.equal(loaded.isNarrowViewport(loaded.AUTO_COLLAPSE_WIDTH - 1), true);
    assert.equal(loaded.isNarrowViewport(loaded.AUTO_COLLAPSE_WIDTH), false);
    assert.equal(loaded.isNarrowViewport(0), false, "a zero measurement is not a narrow window");
    assert.equal(loaded.isNarrowViewport(Number.NaN), false);
  } finally { await cleanup(); }
});

// The stored layout is read asynchronously. Measuring before it lands made the
// app open wide on a narrow window: the first measurement chose the rail and the
// restore overwrote it — and afterwards a stored rail and our own auto-collapse
// were indistinguishable, so widening the window could not tell what to restore.
// The renderer now waits for the read (isLayoutRestored) and measures once, which
// is the case this pins: a FIRST measurement carrying the stored value.
test("the first measurement after a restore both collapses and remembers what was stored", async () => {
  const { loaded, cleanup } = await load();
  try {
    // Stored "expanded", booted narrow: rail now, their sidebar back when it widens.
    let r = loaded.collapseForWidth(loaded.EMPTY_RESPONSIVE_COLLAPSE, 700, false);
    assert.equal(r.apply, true, "narrow: the rail wins on boot");
    assert.equal(r.next.preferred, false, "what was stored is what they get back");
    assert.equal(loaded.collapseForWidth(r.next, 1400, true).apply, false, "widening restores the stored sidebar");

    // Stored "collapsed", booted narrow: still the rail, and it stays a rail when widened.
    r = loaded.collapseForWidth(loaded.EMPTY_RESPONSIVE_COLLAPSE, 700, true);
    assert.equal(r.apply, true);
    assert.equal(r.next.preferred, true, "a stored rail survives the narrow boot");
    assert.equal(loaded.collapseForWidth(r.next, 1400, true).apply, true, "widening leaves their rail alone");

    // Booted wide: nothing is applied and the stored value becomes the preference.
    const wide = loaded.collapseForWidth(loaded.EMPTY_RESPONSIVE_COLLAPSE, 1400, true);
    assert.equal(wide.apply, null, "wide: the restored choice stands");
    assert.equal(wide.next.preferred, true);
  } finally { await cleanup(); }
});
