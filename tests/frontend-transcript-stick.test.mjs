import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-stick-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/transcript-stick.ts")], outfile, bundle: true, format: "esm", platform: "node" });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// The reported bug: during a live reply the transcript pulled the reader back
// to the bottom every time they scrolled up. Following must survive growing
// content, and must stop the moment the reader scrolls away from the bottom —
// including by dragging the scrollbar, which sends no wheel event.
test("following stops when the reader scrolls up and resumes at the bottom", async () => {
  const { loaded, cleanup } = await load();
  try {
    const viewport = { clientHeight: 600 };
    const atBottom = { ...viewport, scrollTop: 2400, scrollHeight: 3000 };
    assert.equal(loaded.nextStickState(atBottom, { scrollTop: 2400, scrollHeight: 3000 }), true, "resting at the bottom keeps following");

    // Content grew under a reader who stayed put: still at the bottom, still following.
    assert.equal(loaded.nextStickState({ ...viewport, scrollTop: 2800, scrollHeight: 3400 }, { scrollTop: 2400, scrollHeight: 3000 }), true);

    // The reader scrolled up 500px. That hands them control even though the
    // event arrives late, and it must not be undone by the next delta.
    const scrolledUp = { ...viewport, scrollTop: 1900, scrollHeight: 3000 };
    assert.equal(loaded.nextStickState(scrolledUp, { scrollTop: 2400, scrollHeight: 3000 }), false);

    // A scrollbar drag one pixel up is jitter, not intent.
    assert.equal(loaded.nextStickState({ ...viewport, scrollTop: 2399, scrollHeight: 3000 }, { scrollTop: 2400, scrollHeight: 3000 }), true);

    // Content shrank (a row unmounted) so the browser clamped scrollTop. That
    // is not the reader scrolling, and following must survive it.
    assert.equal(loaded.nextStickState({ ...viewport, scrollTop: 1800, scrollHeight: 2400 }, { scrollTop: 2400, scrollHeight: 3000 }), true);

    // Scrolling back down to within the slack resumes following.
    assert.equal(loaded.nextStickState({ ...viewport, scrollTop: 2350, scrollHeight: 3000 }, { scrollTop: 1900, scrollHeight: 3000 }), true);
    assert.equal(loaded.nextStickState({ ...viewport, scrollTop: 2000, scrollHeight: 3000 }, { scrollTop: 1900, scrollHeight: 3000 }), false, "still 400px short of the bottom");
  } finally { await cleanup(); }
});

test("the paging keys and the pinned position", async () => {
  const { loaded, cleanup } = await load();
  try {
    assert.deepEqual(["PageUp", "ArrowUp", "Home"].map(loaded.isScrollUpKey), [true, true, true]);
    assert.deepEqual(["PageDown", "ArrowDown", "End", "a"].map(loaded.isScrollUpKey), [false, false, false, false]);
    assert.equal(loaded.bottomScrollTop({ scrollHeight: 3000, clientHeight: 600 }), 2400);
    assert.equal(loaded.bottomScrollTop({ scrollHeight: 400, clientHeight: 600 }), 0, "a transcript shorter than its viewport pins at the top");
  } finally { await cleanup(); }
});
