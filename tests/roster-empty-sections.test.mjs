import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectionPath = path.join(
  repoRoot,
  "frontend/src/recovered/features/conversation/workspace/sidebar-section-projection.ts",
);
const modelPath = path.join(repoRoot, "frontend/src/production/sidebar-model.ts");
const present = existsSync(projectionPath) && existsSync(modelPath);

test("roster empty-sections skip contract: import shipped list path when frontend/ is present", () => {
  if (!present) {
    assert.equal(existsSync(path.join(repoRoot, "frontend/src")), false, "a tree without frontend/src skips the roster list path");
    return;
  }
  assert.ok(existsSync(projectionPath));
  assert.ok(existsSync(modelPath));
});

async function loadShippedRosterPath() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "roster-empty-sections-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [projectionPath],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    absWorkingDir: repoRoot,
  });
  const modelOut = path.join(temporary, "model.mjs");
  await build({
    entryPoints: [modelPath],
    outfile: modelOut,
    bundle: true,
    format: "esm",
    platform: "neutral",
  });
  const projection = await import(pathToFileURL(outfile).href + "?" + Date.now());
  const model = await import(pathToFileURL(modelOut).href + "?" + Date.now());
  return {
    projection,
    model,
    cleanup: () => rm(temporary, { recursive: true, force: true }),
  };
}

function whenFrontend(name, fn) {
  test(name, { skip: present ? false : "frontend/ is restored from stow; skip when absent" }, fn);
}

whenFrontend("empty section records still list unpinned agents via the shipped nav path", async () => {
  const { projection, model, cleanup } = await loadShippedRosterPath();
  try {
    const agents = [{ id: "cw_new", name: "New Bot", isPinned: false }];
    const projectedEmpty = projection.projectSidebarSections({
      agents,
      pinnedIds: [],
      sections: [],
    });
    assert.deepEqual(projectedEmpty, [], "empty section records still project to []");
    const { unpinned } = model.partitionSidebarAgents(agents, []);
    const listedFromEmpty = projection.rosterNavAgentsFromUnpinned(unpinned, projectedEmpty);
    assert.equal(listedFromEmpty.length, 1);
    assert.equal(listedFromEmpty[0].id, "cw_new");

    const listedFromMissing = projection.rosterNavAgentsFromUnpinned(unpinned, undefined);
    assert.equal(listedFromMissing[0].id, "cw_new");
    const listedFromNull = projection.rosterNavAgentsFromUnpinned(unpinned, null);
    assert.equal(listedFromNull[0].id, "cw_new");
  } finally {
    await cleanup();
  }
});
