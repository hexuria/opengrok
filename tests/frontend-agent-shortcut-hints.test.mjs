import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-shortcut-hints-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/agent-shortcut-hints.ts")], outfile, bundle: true, format: "esm", platform: "node" });
  return { loaded: await import(`${pathToFileURL(outfile).href}?${Date.now()}`), cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const down = (key, extra = {}) => ({ type: "keydown", key, metaKey: false, ctrlKey: false, ...extra });
const up = (key) => ({ type: "keyup", key, metaKey: false, ctrlKey: false });

test("the badges show while the modifier is held alone", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { nextModifierHeld } = loaded;
    assert.equal(nextModifierHeld(false, down("Meta")), true);
    assert.equal(nextModifierHeld(true, down("Meta")), true, "key repeat keeps them up");
    assert.equal(nextModifierHeld(true, up("Meta")), false);
    assert.equal(nextModifierHeld(false, down("Control")), true, "Control is the same key on the other platform");
    assert.equal(nextModifierHeld(true, up("Control")), false);
    // Taking the shortcut is the end of the hint's job.
    assert.equal(nextModifierHeld(true, down("1", { metaKey: true })), false);
    assert.equal(nextModifierHeld(true, up("1")), true, "releasing the number alone is not releasing the modifier");
    // A plain keystroke with no modifier down changes nothing.
    assert.equal(nextModifierHeld(false, down("a")), false);
  } finally { await cleanup(); }
});

// Holding the key and switching apps used to be the way to strand them: the app
// never sees the keyup, so the badges stayed on screen with nothing holding them.
test("losing the window clears the badges", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { nextModifierHeld } = loaded;
    assert.equal(nextModifierHeld(true, { type: "blur", key: "", metaKey: false, ctrlKey: false }), false);
    assert.equal(nextModifierHeld(true, { type: "visibilitychange", key: "", metaKey: false, ctrlKey: false }), false);
  } finally { await cleanup(); }
});

test("nine coworkers get a badge and the tenth gets nothing", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { agentShortcutHints, AGENT_SHORTCUT_LIMIT } = loaded;
    const ids = Array.from({ length: 12 }, (unused, index) => `agent-${index}`);
    const hints = agentShortcutHints(ids);
    assert.equal(hints.size, AGENT_SHORTCUT_LIMIT);
    assert.equal(hints.get("agent-0"), "⌘1");
    assert.equal(hints.get("agent-8"), "⌘9");
    assert.equal(hints.get("agent-9"), undefined, "the tenth row has no shortcut, so no badge");

    // A duplicate id must not consume a number, or every badge after it would
    // name a shortcut that opens somebody else.
    const deduped = agentShortcutHints(["a", "a", "b"]);
    assert.equal(deduped.get("a"), "⌘1");
    assert.equal(deduped.get("b"), "⌘2");
    assert.equal(agentShortcutHints([]).size, 0);
  } finally { await cleanup(); }
});

test("the roster draws the badge, and yields the numbers to the palette", async () => {
  const { cleanup } = await load();
  try {
    const sidebar = await readFile(path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/sidebar.tsx"), "utf8");
    // The badge order must match what focusAgent resolves against: pinned, then the rest.
    assert.match(sidebar, /agentShortcutHints\(\[\.\.\.orderedPinned, \.\.\.unpinned\]\.map\(\(agent\) => agent\.id\)\)/);
    assert.match(sidebar, /className="sand-agent-item__shortcut"/);
    const renderer = await readFile(path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx"), "utf8");
    assert.match(renderer, /shortcutHintsEnabled=\{!commandPaletteOpen\}/, "⌘1 belongs to the palette's list while it is open");
    const css = await readFile(path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/view.css"), "utf8");
    assert.match(css, /\.sand-agent-item__shortcut \{[^}]*pointer-events: none;/);
  } finally { await cleanup(); }
});
