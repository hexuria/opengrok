import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadRuntime() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-coordinator-runtime-"));
  const outfile = path.join(temporary, "coordinator-runtime.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/coordinator/coordinator-runtime.ts")],
    outfile, bundle: true, format: "esm", platform: "node", target: "node22",
  });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

function fakeLaunches() {
  const handles = [];
  return {
    handles,
    launch() {
      const n = handles.length + 1;
      let exit;
      const handle = {
        n,
        rendererDataPort: { port: `renderer-${n}` },
        mainDataPort: { port: `main-${n}` },
        processExited: new Promise((r) => { exit = r; }),
        exit: (code) => exit({ code }),
        disposed: false,
        dispose() { this.disposed = true; exit({ code: 0 }); },
      };
      handles.push(handle);
      return handle;
    },
  };
}

function deps(launches) {
  return {
    fork() { throw new Error("unused"); },
    createChannel() { throw new Error("unused"); },
    executors: {},
    onEvent: {},
    onProblem() {},
    processConfig: {},
    artifactPath: "x",
    monotonicNow: () => 100_000,
    onMainDataPort() {},
    onLifecycle() {},
    relaunchBackoff: { schedule() { return { elapsed: Promise.resolve(), dispose() {} }; } },
    launch: () => launches.launch(),
  };
}

async function settle() { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); }

// A renderer reload closes the coordinator's renderer port; the coordinator settles and exits;
// the runtime relaunches it. Before this fix the relaunched child's port was handed to the sink
// recorded for the page that had just gone away, so when the new page asked for a port the
// runtime launched a THIRD child and handed over a second port. The page then held two ports,
// requests went on one and events arrived on the other, and every reply was dead until Cmd+R.
test("a reload produces one relaunched coordinator and one port for the new page", async () => {
  const { loaded, cleanup } = await loadRuntime();
  try {
    const launches = fakeLaunches();
    const runtime = loaded.createCoordinatorRuntime(deps(launches));
    assert.equal(launches.handles.length, 1, "one child at start");

    const firstPage = [];
    runtime.requestRendererPort((port) => firstPage.push(port));
    assert.deepEqual(firstPage, [{ port: "renderer-1" }]);

    // The page reloads: its port closes, the child settles and exits cleanly.
    launches.handles[0].exit(0);
    await settle();
    assert.equal(launches.handles.length, 2, "the runtime relaunched once");
    assert.equal(firstPage.length, 1, "the gone page is not handed the relaunched child's port");

    // The new page asks for its port: it gets the relaunched child's, and nothing else launches.
    const secondPage = [];
    runtime.requestRendererPort((port) => secondPage.push(port));
    await settle();
    assert.equal(launches.handles.length, 2, "no third coordinator");
    assert.deepEqual(secondPage, [{ port: "renderer-2" }]);
    assert.equal(launches.handles[1].disposed, false, "the child serving the new page is alive");
    await runtime.dispose();
  } finally {
    await cleanup();
  }
});

// Two requests from one live page (no exit in between) still behave as before: the second
// request relaunches, disposes the previous child, and serves the fresh port.
test("a second port request from a live page still replaces the coordinator", async () => {
  const { loaded, cleanup } = await loadRuntime();
  try {
    const launches = fakeLaunches();
    const runtime = loaded.createCoordinatorRuntime(deps(launches));
    const ports = [];
    runtime.requestRendererPort((port) => ports.push(port));
    runtime.requestRendererPort((port) => ports.push(port));
    await settle();
    assert.deepEqual(ports, [{ port: "renderer-1" }, { port: "renderer-2" }]);
    assert.equal(launches.handles[0].disposed, true);
    assert.equal(launches.handles.length, 2);
    await runtime.dispose();
  } finally {
    await cleanup();
  }
});
