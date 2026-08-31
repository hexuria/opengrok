import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadProvider() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "local-exec-sse-dial-"));
  const outfile = path.join(temporary, "provider.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/local-exec/local-exec-provider.ts")],
    outfile, bundle: true, format: "esm", platform: "node", external: ["electron"],
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

test("a dial the server never answers is abandoned, not awaited forever", async () => {
  const { loaded, cleanup } = await loadProvider();
  try {
    // A server coming back up can accept the connection and never answer.
    // Before the dial deadline this parked the reconnect loop for good while
    // response POSTs kept succeeding - a daemon that looks healthy and can
    // never receive a request again.
    const hangingFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const provider = new loaded.SandLocalExecProvider({
      executor: { decodeServerMessage: () => { throw new Error("unused"); }, throwControl: () => ({}), execute: async function* () {}, cancel: () => {} },
      resolveConnection: async () => ({ baseUrl: "http://server.test:1447", token: "t" }),
      fetch: hangingFetch,
      dialTimeoutMs: 60,
    });
    const outcome = await Promise.race([
      provider.streamRequests().then(() => "resolved", () => "rejected"),
      new Promise((resolve) => setTimeout(() => resolve("still hanging"), 1_500)),
    ]);
    assert.equal(outcome, "rejected", "the hung dial must throw into the retry loop");
  } finally {
    await cleanup();
  }
});

test("the deadline covers only the dial - an answered stream is not cut off by it", async () => {
  const { loaded, cleanup } = await loadProvider();
  try {
    let streamAborted = false;
    const answeredFetch = async (_url, init) => {
      init.signal.addEventListener("abort", () => { streamAborted = true; }, { once: true });
      // A response whose body stays open, silent, past the dial deadline.
      const body = new ReadableStream({ start() { /* never closes, never pushes */ } });
      return { ok: true, status: 200, body };
    };
    const posts = [];
    const provider = new loaded.SandLocalExecProvider({
      executor: { decodeServerMessage: () => { throw new Error("unused"); }, throwControl: () => ({}), execute: async function* () {}, cancel: () => {} },
      resolveConnection: async () => ({ baseUrl: "http://server.test:1447", token: "t" }),
      fetch: (url, init) => {
        if (String(url).includes("/local-exec/requests")) return answeredFetch(url, init);
        posts.push(String(url));
        return Promise.resolve({ ok: true, status: 204, text: async () => "" });
      },
      dialTimeoutMs: 60,
    });
    const settled = Promise.race([
      provider.streamRequests().then(() => "ended", () => "rejected"),
      new Promise((resolve) => setTimeout(() => resolve("open"), 400)),
    ]);
    const outcome = await settled;
    const abortedBeforeClose = streamAborted;
    provider.close();
    assert.equal(outcome, "open", "a slow, silent stream outlives the dial deadline");
    assert.equal(abortedBeforeClose, false, "the dial timer must not fire once the response arrived");
  } finally {
    await cleanup();
  }
});
