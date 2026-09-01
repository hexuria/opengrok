import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadClient() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "gateway-sse-stall-"));
  const outfile = path.join(temporary, "gateway-client.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/gateway/gateway-client.ts")],
    outfile, bundle: true, format: "esm", platform: "node", target: "node22",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

function passThroughDeadline() {
  return {
    name: "test-deadline",
    async run(work, signal) { return await work(signal ?? new AbortController().signal); }
  };
}

function instantRetry() {
  return {
    name: "test-retry",
    schedule() { return { elapsed: Promise.resolve(), dispose() {} }; },
    async runWithRetry(work, signal) { return await work(1, signal ?? new AbortController().signal); }
  };
}

function stallWatchdog(idleMs) {
  return {
    name: "test-stall",
    arm(onIdle) {
      let active = true;
      let timer;
      const rearm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { if (active) onIdle(); }, idleMs);
      };
      rearm();
      return {
        kick() { if (active) rearm(); },
        dispose() { active = false; clearTimeout(timer); }
      };
    }
  };
}

function testTiming(idleMs) {
  return {
    clock: {
      now: () => Date.now(),
      monotonicNow: () => performance.now(),
      schedule(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return { dispose() { clearTimeout(timer); } };
      }
    },
    reconnectBackoff: instantRetry(),
    connectDeadline: passThroughDeadline(),
    stallWatchdog: stallWatchdog(idleMs),
    sendPostDeadline: passThroughDeadline(),
    rosterReadDeadline: passThroughDeadline(),
    createAgentRetry: instantRetry()
  };
}

// A body whose pending read() never settles — not on fetch abort, not on
// cancel(). That is the undici half-open after a server PID change: the
// stall watchdog used to abort fetch and then wait forever on reader.read().
function hangingEventsBody() {
  return {
    getReader() {
      return {
        read() { return new Promise(() => {}); },
        cancel() { return Promise.resolve(); }
      };
    }
  };
}

test("a silent /events body whose read ignores abort still reconnects after stall", async () => {
  const { loaded, cleanup } = await loadClient();
  const originalFetch = globalThis.fetch;
  const downs = [];
  let eventsFetches = 0;
  try {
    globalThis.fetch = async (url) => {
      if (!String(url).includes("/events")) throw new Error(`unexpected fetch ${url}`);
      eventsFetches += 1;
      return { ok: true, status: 200, body: hangingEventsBody() };
    };
    const client = new loaded.CoordinatorGatewayClient({
      resolveConnection: async () => ({ baseUrl: "http://server.test:1447", token: "t" }),
      timing: testTiming(60),
      onEvent() {},
      onTransportEvent(event) {
        if (event?.family === "transport-down") downs.push(event.payload);
      }
    });
    client.start();
    const outcome = await Promise.race([
      (async () => {
        const started = Date.now();
        while (Date.now() - started < 1_500) {
          if (downs.some((down) => down.reason === "stall-timeout") && eventsFetches >= 2) return "reconnected";
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        return "still hanging";
      })(),
      new Promise((resolve) => setTimeout(() => resolve("still hanging"), 1_500))
    ]);
    client.close();
    assert.equal(outcome, "reconnected", "stall must cancel the hung reader so runEventLoop can redial /events");
    assert.equal(downs[0]?.reason, "stall-timeout");
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test("a healthy /events stream that keeps pushing is not cut by the stall timer", async () => {
  const { loaded, cleanup } = await loadClient();
  const originalFetch = globalThis.fetch;
  const downs = [];
  let eventsFetches = 0;
  let stopPings = () => {};
  try {
    const encoder = new TextEncoder();
    globalThis.fetch = async (url) => {
      if (!String(url).includes("/events")) throw new Error(`unexpected fetch ${url}`);
      eventsFetches += 1;
      const body = new ReadableStream({
        start(controller) {
          const ping = () => {
            try { controller.enqueue(encoder.encode(":ping\n\n")); } catch {}
          };
          ping();
          const timer = setInterval(ping, 20);
          stopPings = () => { clearInterval(timer); try { controller.close(); } catch {} };
        }
      });
      return { ok: true, status: 200, body };
    };
    const client = new loaded.CoordinatorGatewayClient({
      resolveConnection: async () => ({ baseUrl: "http://server.test:1447", token: "t" }),
      timing: testTiming(80),
      onEvent() {},
      onTransportEvent(event) {
        if (event?.family === "transport-down") downs.push(event.payload);
      }
    });
    client.start();
    const outcome = await Promise.race([
      new Promise((resolve) => setTimeout(() => resolve("open"), 400)),
      (async () => {
        const started = Date.now();
        while (Date.now() - started < 400) {
          if (downs.length > 0) return "dropped";
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        return "open";
      })()
    ]);
    client.close();
    assert.equal(outcome, "open", "chunks must keep the stall watchdog fed");
    assert.equal(eventsFetches, 1, "a live stream must not reconnect");
    assert.equal(downs.length, 0, "a live stream must not be marked down");
  } finally {
    stopPings();
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});
