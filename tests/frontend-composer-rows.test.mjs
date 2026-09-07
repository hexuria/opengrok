import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-composer-rows-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/composer-rows.ts")], outfile, bundle: true, format: "esm", platform: "node" });
  return { loaded: await import(`${pathToFileURL(outfile).href}?${Date.now()}`), cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// Our editable is 16px text at line-height 1.4, so one line is 22.4px and the
// empty box floors at its 28px min-height. That floor must not read as a second
// line, or an empty composer would open into the stacked box on mount.
test("an empty composer is one line, a wrapped one is two", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { composerRowCount, isMultilineComposer } = loaded;
    assert.equal(isMultilineComposer(composerRowCount(28, 22.4)), false, "the 28px min-height is still one line");
    assert.equal(isMultilineComposer(composerRowCount(22.4, 22.4)), false);
    assert.equal(isMultilineComposer(composerRowCount(44.8, 22.4)), true, "two lines open the box");
    assert.equal(Math.round(composerRowCount(134.4, 22.4)), 6, "six lines is the cap");
    // Past the cap the box stops growing but scrollHeight keeps counting.
    assert.ok(composerRowCount(246, 22.4) > 6);
  } finally { await cleanup(); }
});

test("an unmeasurable editor counts as a pill rather than a box", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { composerRowCount, isMultilineComposer } = loaded;
    for (const bad of [[0, 22.4], [100, 0], [Number.NaN, 22.4], [100, Number.NaN], [100, -5]]) {
      assert.equal(composerRowCount(bad[0], bad[1]), 1, `${JSON.stringify(bad)} falls back to one line`);
    }
    assert.equal(isMultilineComposer(Number.NaN), false);
  } finally { await cleanup(); }
});

// Official 0.18 caps the editor at six lines and scrolls past it (its bundle
// computes 20 x 6 = 120px into an inline --x-maxHeight). The old rule capped at
// a flat 160px with NO overflow, which is 7.14 lines: six readable lines, a
// sliver of a seventh, and every line after that painted outside the pill.
test("the composer caps at six whole lines and scrolls, and the box shows both mic and send", async () => {
  const { cleanup } = await load();
  try {
    const css = await readFile(path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/view.css"), "utf8");
    assert.match(css, /\.sand-prompt-field \{[^}]*max-height: calc\(6 \* 1\.4em\);/);
    assert.match(css, /\.sand-prompt-field \{[^}]*overflow-y: auto;/);
    assert.doesNotMatch(css, /max-height: 160px/, "the flat 160px cap showed a seventh line nobody could read");
    assert.match(css, /\.sand-prompt-shell\[data-stacked\] \.sand-prompt-ghost-mic-seat \{ width: auto;/);

    const composer = await readFile(path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/composer.tsx"), "utf8");
    assert.match(composer, /data-stacked=\{draft\.attachments\.length > 0 \|\| replyTarget != null \|\| isMultiline \|\| undefined\}/);
    assert.match(composer, /new ResizeObserver\(measure\)/, "the box opens on a WRAPPED line too, not only a typed break");
    assert.match(composer, /editorControls\.current\?\.focus\(\)/);
  } finally { await cleanup(); }
});
