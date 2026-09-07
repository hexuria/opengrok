import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-roster-order-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, "frontend/src/production/roster-order.ts")], outfile, bundle: true, format: "esm", platform: "node" });
  return { loaded: await import(`${pathToFileURL(outfile).href}?${Date.now()}`), cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const row = (id, updatedAt, extra = {}) => ({ id, updatedAt, ...extra });

// Two writers feed the roster and they disagree during a turn: the
// `agent-upserted` push carries a fresh updatedAt every time anything changes,
// the `listAgents` refresh carries the stored one. The coworker you had just
// written to climbed to the top and dropped back to third three or four times
// inside one answer. Only an interaction may reorder the roster.
test("a refresh cannot move a row, in either direction", async () => {
  const { loaded, cleanup } = await load();
  try {
    const before = [row("c", 300), row("b", 200), row("a", 100)];
    const after = loaded.mergeRosterOrder(before, [row("a", 100), row("b", 200), row("c", 50)]);
    assert.deepEqual(after.map((agent) => agent.id), ["c", "b", "a"], "c stays at the top");
    assert.equal(after[0].updatedAt, 300, "and keeps the position it earned");

    // The push that merely says "this run has ended" carries a fresh timestamp.
    // It said nothing and it did not start working, so it does not overtake c.
    const settled = loaded.mergeRosterOrder(after, [row("a", 999, { isRunning: false }), row("b", 200), row("c", 300)]);
    assert.deepEqual(settled.map((agent) => agent.id), ["c", "b", "a"], "a stays where it was");
  } finally { await cleanup(); }
});

test("saying something new, or starting to work, moves a row to the top", async () => {
  const { loaded, cleanup } = await load();
  try {
    const before = [row("c", 300), row("b", 200), row("a", 100)];
    const spoke = loaded.mergeRosterOrder(before, [row("a", 900, { lastMessagePreview: "on it" }), row("b", 200), row("c", 300)]);
    assert.deepEqual(spoke.map((agent) => agent.id), ["a", "c", "b"], "a answered, so a is first");

    const started = loaded.mergeRosterOrder(before, [row("b", 950, { isRunning: true }), row("a", 100), row("c", 300)]);
    assert.deepEqual(started.map((agent) => agent.id), ["b", "c", "a"], "b started working");

    // A null from the roster refresh is an absence, not a change.
    const refreshed = loaded.mergeRosterOrder(spoke, [row("a", 10, { lastMessagePreview: null }), row("b", 200), row("c", 300)]);
    assert.deepEqual(refreshed.map((agent) => agent.id), ["a", "c", "b"], "the refresh knows no preview and moves nobody");
  } finally { await cleanup(); }
});

test("membership follows the new list", async () => {
  const { loaded, cleanup } = await load();
  try {
    const before = [row("c", 300), row("b", 200), row("a", 100)];
    const after = loaded.mergeRosterOrder(before, [row("a", 100), row("b", 200)]);
    assert.deepEqual(after.map((agent) => agent.id), ["b", "a"], "c was deleted");
  } finally { await cleanup(); }
});

test("equal timestamps keep a stable order, and unseen rows pass through untouched", async () => {
  const { loaded, cleanup } = await load();
  try {
    const { mergeRosterOrder } = loaded;
    const tied = mergeRosterOrder([], [row("b", 5), row("a", 5), row("c", 5)]);
    assert.deepEqual(tied.map((agent) => agent.id), ["a", "b", "c"], "the id breaks the tie both times");
    assert.deepEqual(mergeRosterOrder(tied, [row("b", 5), row("a", 5), row("c", 5)]).map((agent) => agent.id), ["a", "b", "c"]);

    const fresh = mergeRosterOrder([], [row("solo", 7, { name: "Solo" })]);
    assert.equal(fresh[0].name, "Solo", "every other field survives the merge");
    assert.equal(fresh[0].updatedAt, 7);
  } finally { await cleanup(); }
});

test("a duplicate id in one payload is taken once", async () => {
  const { loaded, cleanup } = await load();
  try {
    const merged = loaded.mergeRosterOrder([], [row("a", 10, { name: "first" }), row("a", 20, { name: "second" })]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].name, "first", "the leading copy is the one the push prepended");
  } finally { await cleanup(); }
});
