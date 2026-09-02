import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// One bundle for both modules, so the store and the brand share module state as they do in the app.
async function loadBundle(dir) {
  const entry = path.join(dir, "entry.ts");
  await writeFile(entry, [
    `export * as productName from ${JSON.stringify(path.join(repoRoot, "source/shared/product-name.ts"))};`,
    `export { SandSettingsStore } from ${JSON.stringify(path.join(repoRoot, "source/shared/node/settings/sand-settings-store.ts"))};`,
  ].join("\n"));
  const outfile = path.join(dir, "bundle.mjs");
  await build({ entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "silent" });
  return import(`${pathToFileURL(outfile).href}?${Date.now()}`);
}

// The main process, coordinator and daemon each talk to the person in dialogs and errors; on an
// OpenGrok server they say "Open Grok", on Cursor the official "Grok Bot". The settings store is
// the one place every process reads the box runtime, so it sets the brand as a side effect.
test("the settings store's box runtime decides the product name for user-facing copy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "product-name-"));
  try {
    const { productName, SandSettingsStore } = await loadBundle(dir);
    productName.resetProductBrandForTests();
    assert.equal(productName.productDisplayName(), "Grok Bot");
    assert.equal(productName.brandText("Move Grok Bot to Applications"), "Move Grok Bot to Applications");

    const settingsPath = path.join(dir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ version: 1, boxRuntime: "opengrok" }));
    const store = new SandSettingsStore(settingsPath);
    assert.equal(store.getBoxRuntime(), "opengrok");
    assert.equal(productName.productDisplayName(), "Open Grok");
    assert.equal(productName.brandText("Grok Bot couldn't move to Applications"), "Open Grok couldn't move to Applications");

    store.setBoxRuntime("remote");
    assert.equal(productName.productDisplayName(), "Grok Bot");
    assert.equal(productName.SAND_PRODUCT_DISPLAY_NAME, "Grok Bot", "the update feed / HTTP token name never changes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
