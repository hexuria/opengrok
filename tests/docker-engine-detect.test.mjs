import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(sourcePath) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-docker-detect-"));
  const output = path.join(temporary, "module.mjs");
  await build({ entryPoints: [path.join(repoRoot, sourcePath)], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22" });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

// A dead Docker engine used to surface as the raw 500 string, which read as an
// endless "Booting up the computer" spinner. These three cases must be told
// apart so the message is actionable and the engine-down case can self-heal.
test("a failed docker probe is classified into an actionable message", async () => {
  const loaded = await loadModule("source/electron-main/box/docker-cli.ts");
  try {
    const { classifyDockerUnavailable, DOCKER_CLI_NOT_FOUND } = loaded.module;

    // No CLI at all — install Docker.
    assert.equal(classifyDockerUnavailable(DOCKER_CLI_NOT_FOUND, false).kind, "cli-missing");
    assert.equal(classifyDockerUnavailable("Docker is not installed.", true).kind, "cli-missing");

    // The exact failure the user hit: CLI answers, engine returns 500. With
    // Docker Desktop present this is a startable engine, not a missing install.
    const realError = "request returned 500 Internal Server Error for API route and version http://.../v1.55/version, check if the server supports the requested API version";
    const down = classifyDockerUnavailable(realError, true);
    assert.equal(down.kind, "engine-down");
    assert.match(down.message, /Docker Desktop is installed but its engine isn't running/);
    assert.match(down.message, /starting Docker Desktop/i);

    // Same failure, but no Docker Desktop (e.g. colima) — cannot auto-start it.
    const other = classifyDockerUnavailable(realError, false);
    assert.equal(other.kind, "not-installed");
    assert.doesNotMatch(other.message, /Docker Desktop is installed/);
  } finally {
    await loaded.dispose();
  }
});
