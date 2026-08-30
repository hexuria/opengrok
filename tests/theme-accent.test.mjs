import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "theme-accent-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

/*
 * The 0.18 theme pins were exported but never asserted anywhere, so nothing
 * would have caught a drifted palette. The accent layer is only safe because
 * it leaves them alone, so assert them here first.
 */
test("the pinned 0.18 palette still hashes to its recorded snapshot", async () => {
  const { loaded, cleanup } = await load("frontend/src/recovered/features/runtime-theme-token-installer.ts");
  try {
    const { buildRuntimeThemeCss, IMMUTABLE_THEME_SNAPSHOT_HASHES, IMMUTABLE_THEME_PALETTE_COUNT } = loaded;
    for (const mode of ["light", "dark"]) {
      const digest = createHash("sha256").update(buildRuntimeThemeCss(mode)).digest("hex");
      assert.equal(digest, IMMUTABLE_THEME_SNAPSHOT_HASHES[mode], `${mode} palette drifted from its pinned snapshot`);
    }
    // RUNTIME_PALETTE is module-private, so count its entries in the source.
    const source = await readFile(path.join(repoRoot, "frontend/src/recovered/features/runtime-theme-token-installer.ts"), "utf8");
    assert.equal(source.match(/"cssVar":"--sand-/g)?.length, IMMUTABLE_THEME_PALETTE_COUNT);
  } finally {
    await cleanup();
  }
});

test("every accent role the port overrides exists exactly once in the 0.18 palette", async () => {
  const accent = await load("frontend/src/accent/accent-catalog.ts");
  try {
    const source = await readFile(path.join(repoRoot, "frontend/src/recovered/features/runtime-theme-token-installer.ts"), "utf8");
    for (const role of accent.loaded.ACCENT_TOKEN_ROLES) {
      const occurrences = source.split(`"cssVar":"${role}"`).length - 1;
      assert.equal(occurrences, 1, `${role} is not a single 0.18 palette role`);
    }
  } finally {
    await accent.cleanup();
  }
});

test("the accent sheet only ever shadows, and the default accent emits nothing", async () => {
  const { loaded, cleanup } = await load("frontend/src/accent/accent-css.ts");
  try {
    const css = loaded.buildAccentThemeCss();

    // Selecting "default" must leave the page byte-identical to 0.18, so the
    // sheet must not contain a rule for it at all.
    assert.ok(!css.includes('data-sand-accent="default"'), "default must not emit an override");

    for (const accent of ["blue", "red", "orange", "yellow", "green", "cyan", "purple", "magenta", "brown"]) {
      for (const mode of ["cursor-light", "cursor-dark"]) {
        assert.ok(
          css.includes(`:root[data-theme="${mode}"][data-sand-accent="${accent}"]`),
          `missing ${accent}/${mode} block`,
        );
      }
    }

    // A bare :root rule would outrank nothing but could still bleed into the
    // default accent; every rule must be gated on both attributes.
    for (const rule of css.split("}")) {
      const selector = rule.split("{")[0].trim();
      if (selector.length === 0) continue;
      assert.match(selector, /^:root\[data-theme="cursor-(light|dark)"\]\[data-sand-accent="[a-z]+"\]$/);
    }

    // Spot-check literals against the 0.27 bundle / in-repo SAND_DATA ramps.
    assert.match(css, /--sand-fill-accent: #00c972;/);
    assert.match(css, /--sand-text-accent: #a97efe;/);
    assert.match(css, /--sand-fill-bubble-user: #522100;/);
    assert.match(css, /--sand-fill-accent: #1084fe;/);
    assert.match(css, /--sand-fill-accent: #ff263c;/);
    assert.match(css, /--sand-fill-accent: #ff9800;/);
    assert.match(css, /--sand-fill-accent: #ff309b;/);
    // The two cursor-layer literals 0.18 hard-codes must move with the accent.
    assert.match(css, /--cursor-accent: #00bca6;/);
    assert.match(css, /--cursor-focus: #008f7e;/);

    assert.equal(css, loaded.buildAccentThemeCss(), "the sheet must be deterministic");
  } finally {
    await cleanup();
  }
});

test("a malformed saved accent falls back to the default", async () => {
  const { loaded, cleanup } = await load("frontend/src/accent/accent-store.ts");
  try {
    const { parseAccent, serializeAccent, DEFAULT_ACCENT = "default" } = loaded;
    assert.equal(parseAccent(null), "default");
    assert.equal(parseAccent(""), "default");
    assert.equal(parseAccent("{"), "default");
    assert.equal(parseAccent('{"schemaVersion":1}'), "default");
    assert.equal(parseAccent('{"schemaVersion":1,"accent":"chartreuse"}'), "default");
    assert.equal(parseAccent(serializeAccent("purple")), "purple");
    void DEFAULT_ACCENT;
  } finally {
    await cleanup();
  }
});

test("installing the accent theme appends one sheet and restores the choice", async () => {
  const { loaded, cleanup } = await load("frontend/src/accent/accent-store.ts");
  try {
    const { installAccentTheme, getAccent, setAccent, resetAccentForTesting, ACCENT_PERSISTENCE_KEY } = loaded;
    resetAccentForTesting();

    const appended = [];
    const byId = new Map();
    const root = { dataset: {} };
    const doc = {
      documentElement: root,
      getElementById: (id) => byId.get(id) ?? null,
      createElement: () => ({ id: "", textContent: null }),
      head: {
        appendChild: (node) => {
          appended.push(node);
          byId.set(node.id, node);
        },
      },
    };

    const writes = [];
    const store = {
      read: async () => JSON.stringify({ schemaVersion: 1, accent: "cyan" }),
      write: async (key, value) => void writes.push([key, value]),
    };

    installAccentTheme(store, doc);
    installAccentTheme(store, doc);
    assert.equal(appended.length, 1, "the sheet must be appended once, not per call");
    assert.ok(appended[0].textContent.includes('data-sand-accent="cyan"'));

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getAccent(), "cyan");
    assert.equal(root.dataset.sandAccent, "cyan");

    setAccent("brown");
    assert.equal(root.dataset.sandAccent, "brown");
    assert.deepEqual(writes.at(-1), [ACCENT_PERSISTENCE_KEY, JSON.stringify({ schemaVersion: 1, accent: "brown" })]);

    // Returning to default removes the attribute rather than setting it, so no
    // accent rule can match and 0.18's palette stands alone.
    setAccent("default");
    assert.equal(root.dataset.sandAccent, undefined);

    resetAccentForTesting();
  } finally {
    await cleanup();
  }
});
