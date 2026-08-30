import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(sourcePath) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-bundle-names-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, sourcePath)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["electron"],
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

// The user-data directory is chosen from the bundle name in the executable
// path. Dropping a name this app has shipped under would send that install to
// a fresh profile, which reads to the person using it as though every chat and
// setting had been deleted.
test("every bundle name the app has shipped under still resolves to its profile", async () => {
  const loaded = await loadModule("source/electron-main/startup/desktop-user-data-bootstrap.ts");
  try {
    const { isReconstructedDesktopApp, RECONSTRUCTED_APP_BUNDLE_NAMES } = loaded.module;

    for (const shipped of ["Grok-0.27.app", "OpenGrok.app", "Open Grok.app"]) {
      assert.ok(RECONSTRUCTED_APP_BUNDLE_NAMES.includes(shipped), `${shipped} must stay recognised`);
      assert.equal(
        isReconstructedDesktopApp(`/Applications/${shipped}/Contents/MacOS/Grok Bot`, {}),
        true,
        `${shipped} must resolve to the reconstructed profile`,
      );
    }

    // The official app must never be mistaken for ours, or it would be pointed
    // at our data directory.
    assert.equal(isReconstructedDesktopApp("/Applications/Grok Bot.app/Contents/MacOS/Grok Bot", {}), false);
    assert.equal(isReconstructedDesktopApp("/Applications/Something Else.app/Contents/MacOS/x", {}), false);

    // The escape hatch for running an unpackaged build against the profile.
    assert.equal(isReconstructedDesktopApp("/tmp/whatever", { SAND_RECONSTRUCTED_PROFILE: "1" }), true);

    // The profile has been renamed twice. Startup adopts the first legacy name
    // that exists, so an install that skipped a version still finds its chats;
    // dropping a name from this chain would strand a real profile on disk.
    const { RECONSTRUCTED_USER_DATA_DIRNAME, LEGACY_RECONSTRUCTED_USER_DATA_DIRNAMES } = loaded.module;
    assert.equal(RECONSTRUCTED_USER_DATA_DIRNAME, "OpenGrok");
    assert.deepEqual([...LEGACY_RECONSTRUCTED_USER_DATA_DIRNAMES], ["OpenGrok-0.27", "Grok-0.27"]);
    assert.ok(
      !LEGACY_RECONSTRUCTED_USER_DATA_DIRNAMES.includes(RECONSTRUCTED_USER_DATA_DIRNAME),
      "the current name must not also be listed as legacy, or startup would rename onto itself",
    );
  } finally {
    await loaded.dispose();
  }
});
