import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-row-menu-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/production/agent-row-menu-registry.ts")], outfile, bundle: true, format: "esm", platform: "node" });
  return { loaded: await import(`${pathToFileURL(outfile).href}?${Date.now()}`), cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// Two roster menus open at once overlap, and because every floating surface
// shares one z-index the stale one wins the hit-test wherever it covers the new
// one — the rows underneath look dead. Opening one closes the other.
test("claiming the slot closes whoever held it", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { claimRowMenu, releaseRowMenu, isRowMenuOpen } = loaded;
    const closed = [];
    const first = () => closed.push("first");
    const second = () => closed.push("second");

    claimRowMenu(first);
    assert.equal(isRowMenuOpen(), true);
    assert.deepEqual(closed, [], "claiming an empty slot closes nobody");

    claimRowMenu(second);
    assert.deepEqual(closed, ["first"], "the row that had it is closed");
    assert.equal(isRowMenuOpen(), true);

    releaseRowMenu(second);
    assert.equal(isRowMenuOpen(), false);
    assert.deepEqual(closed, ["first"], "releasing does not call the closer");
  } finally { await cleanup(); }
});

test("re-claiming with the same closer does not close it, and a stale release is ignored", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { claimRowMenu, releaseRowMenu, isRowMenuOpen } = loaded;
    const closed = [];
    const only = () => closed.push("only");
    const other = () => closed.push("other");

    claimRowMenu(only);
    claimRowMenu(only);
    assert.deepEqual(closed, [], "right-clicking the same row twice must not close its own menu");

    claimRowMenu(other);
    releaseRowMenu(only);
    assert.equal(isRowMenuOpen(), true, "a row that no longer holds the slot cannot release it");
    releaseRowMenu(other);
    assert.equal(isRowMenuOpen(), false);
  } finally { await cleanup(); }
});

test("the roster row claims and releases the slot", async () => {
  const { cleanup } = await load();
  try {
    const source = await readFile(path.join(repoRoot, "frontend/src/production/AgentRowActions.tsx"), "utf8");
    assert.match(source, /claimRowMenu\(stableDismiss\)/);
    assert.match(source, /useEffect\(\(\) => \(\) => releaseRowMenu\(stableDismiss\), \[stableDismiss\]\)/, "unmounting a row must free the slot");
    // The closer identity has to be stable, or a later row cannot tell whether
    // the slot is still the one it claimed.
    assert.match(source, /const stableDismiss = useCallback\(\(\) => dismissRef\.current\(\), \[\]\)/);
  } finally { await cleanup(); }
});
