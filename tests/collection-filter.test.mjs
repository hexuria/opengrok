import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let mod;
let dir;
test.before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "collection-filter-"));
  const outfile = path.join(dir, "filter.mjs");
  await build({ entryPoints: [path.join(repoRoot, "source/shared/collections/collection-filter.ts")], outfile, bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "silent" });
  mod = await import(pathToFileURL(outfile).href);
});
test.after(async () => { await rm(dir, { recursive: true, force: true }); });

const shelf = [
  { id: "a", name: "Mom jokes", group: "Fun", tags: ["math", "keep"] },
  { id: "b", name: "Release notes", group: "Work", tags: ["keep"] },
  { id: "c", name: "Scratch" },
  { id: "d", name: "Dad jokes", group: "Fun", tags: ["MATH"] },
];

test("a sigil decides what a word means", () => {
  assert.deepEqual(mod.parseCollectionFilterToken("#math"), { kind: "tag", value: "math" });
  assert.deepEqual(mod.parseCollectionFilterToken("@research"), { kind: "group", value: "research" });
  assert.deepEqual(mod.parseCollectionFilterToken("jokes"), { kind: "text", value: "jokes" });
  assert.equal(mod.parseCollectionFilterToken("#"), null, "a bare sigil is not a chip");
  assert.equal(mod.parseCollectionFilterToken("   "), null);
  assert.deepEqual(mod.parseCollectionFilter("@Fun #math jokes").map((t) => t.kind), ["group", "tag", "text"], "a pasted line becomes chips");
});

test("same kind widens, different kinds narrow", () => {
  const ids = (line) => mod.filterCollections(shelf, mod.parseCollectionFilter(line)).map((c) => c.id);
  assert.deepEqual(ids(""), ["a", "b", "c", "d"], "no chips, no filtering");
  assert.deepEqual(ids("@Fun"), ["a", "d"]);
  assert.deepEqual(ids("#keep"), ["a", "b"]);
  assert.deepEqual(ids("#keep #math"), ["a", "b", "d"], "either tag");
  assert.deepEqual(ids("@Fun #keep"), ["a"], "this group and that tag");
  assert.deepEqual(ids("@Fun jokes"), ["a", "d"]);
  assert.deepEqual(ids("@Fun #keep notes"), [], "all three must land");
});

test("matching ignores case, and text matches every word in the name", () => {
  const ids = (line) => mod.filterCollections(shelf, mod.parseCollectionFilter(line)).map((c) => c.id);
  assert.deepEqual(ids("#MATH"), ["a", "d"], "a tag typed either way finds both spellings");
  assert.deepEqual(ids("@fun"), ["a", "d"]);
  assert.deepEqual(ids("mom jokes"), ["a"], "two words narrow, the way search does");
  assert.deepEqual(ids("jokes mom"), ["a"], "word order does not matter");
  assert.deepEqual(ids("jokes"), ["a", "d"], "one word still finds both");
  assert.deepEqual(ids("@Fun @Work"), ["a", "b", "d"], "either group");
});

test("the sidebar's sections are named groups first, then the ungrouped", () => {
  const sections = mod.groupCollections(shelf);
  assert.deepEqual(sections.map((s) => s.heading), ["Fun", "Work", "Collections"]);
  assert.deepEqual(sections[0].collections.map((c) => c.id), ["a", "d"]);
  assert.deepEqual(sections.at(-1).collections.map((c) => c.id), ["c"]);
  assert.deepEqual(mod.groupCollections([{ name: "only" }]).map((s) => s.heading), ["Collections"]);
  assert.deepEqual(mod.groupCollections([]), [], "an empty shelf has no headings");
});

test("the vocabulary is what is actually in use", () => {
  assert.deepEqual(mod.collectionFilterVocabulary(shelf), { groups: ["Fun", "Work"], tags: ["keep", "math"] }, "one label per name, as first written");
});
