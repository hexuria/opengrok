import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadClient() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-request-id-"));
  const outfile = path.join(temporary, "gateway-client.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/gateway/gateway-client.ts")],
    outfile, bundle: true, format: "esm", platform: "node", target: "node22",
  });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

function passThrough() { return { name: "t", async run(work, signal) { return await work(signal ?? new AbortController().signal); }, schedule() { return { elapsed: Promise.resolve(), dispose() {} }; }, async runWithRetry(work, signal) { return await work(1, signal ?? new AbortController().signal); }, arm() { return { kick() {}, dispose() {} }; } }; }
function timing() {
  const p = passThrough();
  return { clock: { now: () => Date.now(), monotonicNow: () => performance.now(), schedule(ms, cb) { const t = setTimeout(cb, ms); return { dispose() { clearTimeout(t); } }; } }, reconnectBackoff: p, connectDeadline: p, stallWatchdog: p, sendPostDeadline: p, rosterReadDeadline: p, createAgentRetry: p };
}

// A line in the desktop's local telemetry log and a line in the server's request log must be
// able to name the same request. The id travels as X-Request-Id and is kept in our own report.
test("every gateway call carries a fresh X-Request-Id and reports it", async () => {
  const { loaded, cleanup } = await loadClient();
  const originalFetch = globalThis.fetch;
  const seen = [];
  const reports = [];
  const spans = [];
  try {
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), headers: init.headers });
      return { ok: true, status: 200, headers: new Headers(), async json() { return { result: { fine: true } }; }, async text() { return JSON.stringify({ result: { fine: true } }); } };
    };
    const client = new loaded.CoordinatorGatewayClient({
      resolveConnection: async () => ({ baseUrl: "http://server.test:1447", token: "t" }),
      timing: timing(),
      onEvent() {},
      onTransportEvent() {},
      onReachability: (report) => reports.push(report),
      recordGatewayCommandSpan: (report) => spans.push(report),
    });
    const h1 = client.requestHeaders({}, { baseUrl: "http://server.test:1447", token: "t" });
    const h2 = client.requestHeaders({}, { baseUrl: "http://server.test:1447", token: "t" });
    assert.match(h1[loaded.GATEWAY_REQUEST_ID_HEADER], /^[0-9a-f-]{36}$/);
    assert.notEqual(h1[loaded.GATEWAY_REQUEST_ID_HEADER], h2[loaded.GATEWAY_REQUEST_ID_HEADER], "one id per call");
    assert.equal(loaded.GATEWAY_REQUEST_ID_HEADER, "x-request-id", "the name the server accepts and echoes");

    await client.command("getTrays", {});
    assert.equal(seen.length, 1);
    const sent = seen[0].headers[loaded.GATEWAY_REQUEST_ID_HEADER];
    assert.match(sent, /^[0-9a-f-]{36}$/);
    // A successful call with no trace window still produces a report, or the local log would
    // only ever show failures and "the app never asked" would be indistinguishable from "it did".
    assert.equal(spans.length, 1, "one traceless span report for the successful call");
    assert.equal(spans[0].method, "getTrays");
    assert.equal(spans[0].requestId, sent);
    assert.equal(spans[0].isError, false);
    assert.equal(spans[0].rootTraceparent, null);

    // A failed call is the one a person greps for; its reachability report names the same id
    // the wire carried, so the server's line for it can be found.
    globalThis.fetch = async (url, init) => { seen.push({ url: String(url), headers: init.headers }); throw new TypeError("fetch failed"); };
    await assert.rejects(client.command("getTrays", {}));
    const failed = seen[1].headers[loaded.GATEWAY_REQUEST_ID_HEADER];
    assert.notEqual(failed, sent, "a retry or a new call never reuses an id");
    const report = reports.find((r) => r.method === "getTrays");
    assert.ok(report, "the reachability report for the failed call exists");
    assert.equal(report.requestId, failed, "the report names the id that went over the wire");
    client.close();
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});
