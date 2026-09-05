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

/*
 * The server refuses an anonymous request by code instead of answering it as
 * its configured account. The connection, not the call, is what was wrong, so
 * the client rebuilds it once — re-reading who is signed in — and retries. Once.
 */
test("an anonymous-connection refusal rebuilds the connection once and retries the call", async () => {
  const { loaded, cleanup } = await loadClient();
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0, invalidations = 0, resolves = 0;
    const seenHeaders = [];
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      seenHeaders.push(init.headers["x-opengrok-account"] ?? null);
      if (init.headers["x-opengrok-account"] == null) {
        return { ok: false, status: 401, headers: new Headers(), async text() { return JSON.stringify({ error: "say who this is for", code: "account_identity_required" }); }, async json() { return {}; } };
      }
      return { ok: true, status: 200, headers: new Headers(), async json() { return [{ id: "cw_1" }]; }, async text() { return "[]"; } };
    };
    const client = new loaded.CoordinatorGatewayClient({
      // The first resolve is the poisoned connection; the rebuild reads the identity.
      resolveConnection: async () => { resolves += 1; return { baseUrl: "http://server.test:1447", token: "t", ...(resolves > 1 ? { headers: { "x-opengrok-account": "jwt" } } : {}) }; },
      invalidateConnection: () => { invalidations += 1; },
      timing: timing(),
      onEvent() {},
    });
    const result = await client.command("listAgents", {});
    assert.deepEqual(result, [{ id: "cw_1" }]);
    assert.equal(invalidations, 1, "the cached connection was dropped exactly once");
    assert.equal(calls, 2, "one refusal, one retry");
    assert.deepEqual(seenHeaders, [null, "jwt"], "the retry carried the identity the rebuild read");
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test("a refusal that persists surfaces after one rebuild, whichever code it carries", async () => {
  const { loaded, cleanup } = await loadClient();
  const originalFetch = globalThis.fetch;
  try {
    const refuse = (code) => async () => ({ ok: false, status: 401, headers: new Headers(), async text() { return JSON.stringify({ error: "refused", code }); }, async json() { return {}; } });
    const make = (invalidations) => new loaded.CoordinatorGatewayClient({
      resolveConnection: async () => ({ baseUrl: "http://server.test:1447", token: "t" }),
      invalidateConnection: () => { invalidations.count += 1; },
      timing: timing(),
      onEvent() {},
    });

    // Still anonymous after the rebuild: an identity store that cannot produce a
    // name must surface, not spin.
    let calls = 0;
    const stillAnonymous = { count: 0 };
    globalThis.fetch = async (...a) => { calls += 1; return refuse("account_identity_required")(...a); };
    await assert.rejects(make(stillAnonymous).command("listAgents", {}), (error) => error instanceof loaded.SandGatewayIdentityError && error.code === "account_identity_required");
    assert.equal(stillAnonymous.count, 1);
    assert.equal(calls, 2);

    // An identity that does not verify is almost always a token that expired while
    // the connection stayed open. Rebuilding re-reads and renews it, so it gets the
    // same single rebuild; if it STILL does not verify, that surfaces with the code
    // intact so the UI can ask for a sign-in.
    calls = 0;
    const invalid = { count: 0 };
    globalThis.fetch = async (...a) => { calls += 1; return refuse("account_identity_invalid")(...a); };
    await assert.rejects(make(invalid).command("listAgents", {}), (error) => error instanceof loaded.SandGatewayIdentityError && error.code === "account_identity_invalid");
    assert.equal(invalid.count, 1, "one rebuild, which is where renewal happens");
    assert.equal(calls, 2);

    // Any other 401 is still an ordinary command error, unchanged.
    calls = 0;
    const plain = { count: 0 };
    globalThis.fetch = async () => ({ ok: false, status: 401, headers: new Headers(), async text() { return JSON.stringify({ error: "nope" }); }, async json() { return {}; } });
    await assert.rejects(make(plain).command("listAgents", {}), (error) => error instanceof loaded.SandGatewayCommandError && !(error instanceof loaded.SandGatewayIdentityError));
    assert.equal(plain.count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});


/*
 * The stream open is refused with the same codes as /api/*. Left as a generic
 * failure it would retry the same dead token on every backoff tick, forever;
 * dropping the cached connection first means the next attempt re-reads and
 * renews. Pinned as source because the event loop is backoff-driven.
 */
test("an identity refusal on the stream open drops the cached connection before backoff", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(path.join(repoRoot, "source/node-agent-coordinator/gateway/gateway-client.ts"), "utf8");
  const open = source.slice(source.indexOf("private async streamEvents("), source.indexOf("private dispatchEventBlock") > 0 ? source.indexOf("private dispatchEventBlock") : undefined);
  assert.match(open, /response\.status === 401 && this\.options\.invalidateConnection != null/, "the stream open recognises an identity refusal");
  assert.match(open, /extractGatewayErrorCode\(detail\)/, "it reads the same code field as /api/*");
  assert.match(open, /GATEWAY_IDENTITY_REQUIRED_CODE \|\| code === GATEWAY_IDENTITY_INVALID_CODE\) this\.options\.invalidateConnection\(\)/, "and drops the connection so the next attempt renews");
});
