import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildAsar } from "../scripts/lib/build-asar.mjs";
import { cachedRuntimeApp, sourceAppDir } from "../scripts/lib/config.mjs";
import { resolveRuntimeApp } from "../scripts/lib/runtime.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test("buildAsar stages without a 0.18 Grok Bot.app", async t => {
  if (!(await pathExists(path.join(sourceAppDir, "package.json")))) {
    t.skip("src/app is missing; stow restore is required to pack");
    return;
  }

  const previousApp = process.env.GROK_BOT_018_APP;
  delete process.env.GROK_BOT_018_APP;
  let parkedRuntime = null;
  const root = await mkdtemp(path.join(os.tmpdir(), "opengrok-pack-without-runtime-"));
  try {
    // resolveRuntimeApp also reads .cache/runtime; unsetting the env is not enough.
    if (await pathExists(cachedRuntimeApp)) {
      parkedRuntime = `${cachedRuntimeApp}.pack-without-runtime-${process.pid}`;
      await rename(cachedRuntimeApp, parkedRuntime);
    }

    await assert.rejects(resolveRuntimeApp(), /Missing 0\.18\.0 runtime/);

    const buildRoot = path.join(root, "build");
    const stageRoot = path.join(buildRoot, "app");
    const result = await buildAsar({
      pack: false,
      buildRoot,
      stageRoot,
      archivePath: path.join(root, "app.asar"),
      unpackedRoot: path.join(root, "app.asar.unpacked"),
    });

    assert.equal(result.stagedAppDir, stageRoot);
    assert.equal(result.runtimeApp, undefined);
    assert.ok((await stat(stageRoot)).isDirectory());
    assert.ok((await readdir(stageRoot)).length > 0);
    assert.ok((await stat(path.join(stageRoot, "package.json"))).isFile());
    assert.ok((await stat(path.join(stageRoot, "dist"))).isDirectory());
    assert.equal(path.resolve(sourceAppDir), path.join(repoRoot, "src", "app"));
  } finally {
    if (previousApp === undefined) delete process.env.GROK_BOT_018_APP;
    else process.env.GROK_BOT_018_APP = previousApp;
    if (parkedRuntime) await rename(parkedRuntime, cachedRuntimeApp);
    await rm(root, { recursive: true, force: true });
  }
});
