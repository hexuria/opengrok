import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadProxy() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "box-vnc-proxy-"));
  const outfile = path.join(temporary, "box-vnc-proxy.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/gateway/box-vnc-proxy.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
  });
  return { mod: await import(pathToFileURL(outfile).href), cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const cursorProxy = {
  primaryUrl: "https://proxy.example/vnc.html?network_token=tok",
  forkBaseUrl: "https://fork.example",
  networkToken: "tok",
};

test("blank forever-box vncUrl is not a screen, with or without a Cursor proxy", async () => {
  const { mod, cleanup } = await loadProxy();
  try {
    assert.equal(mod.presentBoxScreenUrl(""), null);
    assert.equal(mod.presentBoxScreenUrl("   "), null);
    assert.equal(mod.presentBoxScreenUrl(null), null);
    assert.equal(mod.presentBoxScreenUrl("not a url"), null);

    const grokBox = "http://192.168.1.10:6080/vnc.html?password=secret8";
    assert.equal(mod.presentBoxScreenUrl(grokBox), grokBox);

    assert.equal(mod.proxifyForeverBoxStatus({ agentId: "a", state: "running", vncUrl: "" }, null).vncUrl, null);
    assert.equal(mod.proxifyForeverBoxStatus({ agentId: "a", state: "running", vncUrl: "" }, cursorProxy).vncUrl, null);
  } finally {
    await cleanup();
  }
});

test("a grok-box noVNC URL is not rewritten through the Cursor pod proxy", async () => {
  const { mod, cleanup } = await loadProxy();
  try {
    const lan = "http://192.168.1.10:6080/vnc.html?password=secret8";
    const loopbackGuest = "http://127.0.0.1:6080/vnc.html?password=secret8";
    const ascii = "https://box-6080.on.ascii.dev/vnc.html?password=lVRE33hB&_token=abc";

    assert.equal(mod.proxifyForeverBoxStatus({ vncUrl: lan }, cursorProxy).vncUrl, lan);
    assert.equal(mod.proxifyForeverBoxStatus({ vncUrl: lan }, null).vncUrl, lan);
    assert.equal(mod.proxifyForeverBoxStatus({ vncUrl: loopbackGuest }, cursorProxy).vncUrl, loopbackGuest,
      "password marks grok-box; do not swap loopback:6080 for the Cursor proxy");
    assert.equal(mod.proxifyForeverBoxStatus({ vncUrl: ascii }, cursorProxy).vncUrl, ascii);

    const localDocker = "http://127.0.0.1:6080/vnc.html";
    assert.equal(mod.proxifyForeverBoxStatus({ vncUrl: localDocker }, cursorProxy).vncUrl, cursorProxy.primaryUrl,
      "Cursor's own loopback viewer still goes through the pod proxy");
  } finally {
    await cleanup();
  }
});
