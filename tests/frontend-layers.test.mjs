import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = path.join(repoRoot, "frontend/src");
const LAYERS = path.join(FRONTEND, "recovered/ui/layers.css");
const present = existsSync(FRONTEND);

/** Below this a z-index orders siblings inside one component; at or above it, it claims a place in the app's stack. */
const APP_LAYER_FLOOR = 100;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * The stacking order lives in one file. Before it, forty stylesheets carried
 * values from 1 to 2147483646 and the title bar (5000) sat over the file
 * viewer (4000), so its Close button could not be clicked. Any surface that
 * claims a place in the app's stack has to name a layer, not a number.
 */
test("every app-level z-index in frontend/src is a layer token", { skip: !present }, () => {
  const offenders = [];
  for (const file of walk(FRONTEND)) {
    const relative = path.relative(repoRoot, file);
    if (file === LAYERS || file.endsWith("recovered-atoms.css")) continue;
    const text = readFileSync(file, "utf8");
    if (file.endsWith(".css")) {
      for (const match of text.matchAll(/z-index\s*:\s*(-?\d+)\s*[;}]/g)) {
        if (Math.abs(Number(match[1])) >= APP_LAYER_FLOOR) offenders.push(`${relative}: z-index: ${match[1]}`);
      }
    } else if (/\.(tsx?|mjs|jsx?)$/.test(file)) {
      for (const match of text.matchAll(/zIndex\s*:\s*"?(-?\d+)"?\s*[,}\n]/g)) {
        if (Math.abs(Number(match[1])) >= APP_LAYER_FLOOR) offenders.push(`${relative}: zIndex: ${match[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "use a --sand-layer-* token from frontend/src/recovered/ui/layers.css");
});

test("the layer tokens are declared once and ascend in the order the comments promise", { skip: !present }, () => {
  const text = readFileSync(LAYERS, "utf8");
  const tokens = [...text.matchAll(/--sand-layer-([a-z-]+)\s*:\s*(\d+)/g)].map((match) => [match[1], Number(match[2])]);
  assert.deepEqual(tokens.map(([name]) => name), [
    "shell", "shell-float", "stage", "panel", "chrome", "overlay", "overlay-raised", "viewer", "popover", "scrim", "wall", "devtools",
  ]);
  for (let index = 1; index < tokens.length; index += 1) {
    assert.ok(tokens[index][1] > tokens[index - 1][1], `${tokens[index][0]} must sit above ${tokens[index - 1][0]}`);
  }
  const renderer = readFileSync(path.join(FRONTEND, "production/ProductionRenderer.tsx"), "utf8");
  assert.match(renderer, /import "\.\.\/recovered\/ui\/layers\.css";/);
});
