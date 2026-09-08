import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadAccountCall() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opengrok-account-call-"));
  const outfile = path.join(temporary, "opengrok-account-call.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/box/opengrok-account-call.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const secrets = { readSecret: async () => "a-token" };

function stubFetch(status, body, contentType) {
  return async () => new Response(body, { status, headers: contentType ? { "content-type": contentType } : {} });
}

/*
 * The server answers most refusals as JSON `{error}`, but some as bare
 * plain text (400 "a model is required", 401 "sign in first", 429 "wait a
 * moment before testing another route") - and 429 in particular tells a
 * person exactly what to do, which is lost if it is swallowed into a
 * generic "failed (429)." The fallback that recovers it is bounded, so it
 * must not turn an HTML error page or an oversized body into a UI string.
 */
test("callOpenGrokAccountApi: JSON error wins, plain text falls back, HTML and oversized bodies do not", async () => {
  const { loaded, cleanup } = await loadAccountCall();
  const realFetch = globalThis.fetch;
  try {
    const { callOpenGrokAccountApi } = loaded;
    const call = { path: "/models/probe", method: "POST", body: { model: "xai/grok-4.6@sub" } };

    // (a) JSON {error} still wins.
    globalThis.fetch = stubFetch(429, JSON.stringify({ error: "wait a moment before testing another route" }), "application/json");
    await assert.rejects(
      callOpenGrokAccountApi(secrets, "k", "http://server.test:1447", call),
      /^Error: wait a moment before testing another route$/,
    );

    // (b) a plain-text 429 body becomes the thrown message verbatim.
    globalThis.fetch = stubFetch(429, "wait a moment before testing another route", "text/plain");
    await assert.rejects(
      callOpenGrokAccountApi(secrets, "k", "http://server.test:1447", call),
      /^Error: wait a moment before testing another route$/,
    );

    // Plain-text 400 and 401 get the same treatment - every account endpoint, not just probe.
    globalThis.fetch = stubFetch(400, "a model is required", "text/plain");
    await assert.rejects(callOpenGrokAccountApi(secrets, "k", "http://server.test:1447", call), /^Error: a model is required$/);
    globalThis.fetch = stubFetch(401, "sign in first", "text/plain");
    await assert.rejects(callOpenGrokAccountApi(secrets, "k", "http://server.test:1447", call), /^Error: sign in first$/);

    // (c) an HTML body falls back to the generic message - not a page dumped into the UI.
    globalThis.fetch = stubFetch(502, "<html><body>Bad Gateway</body></html>", "text/html");
    await assert.rejects(callOpenGrokAccountApi(secrets, "k", "http://server.test:1447", call), /^Error: \/models\/probe failed \(502\)\.$/);

    // (c) a 2,000-character body also falls back to the generic message.
    globalThis.fetch = stubFetch(500, "x".repeat(2000), "text/plain");
    await assert.rejects(callOpenGrokAccountApi(secrets, "k", "http://server.test:1447", call), /^Error: \/models\/probe failed \(500\)\.$/);

    // A multi-line body is not shown either - only a single-line sentence qualifies.
    globalThis.fetch = stubFetch(500, "line one\nline two", "text/plain");
    await assert.rejects(callOpenGrokAccountApi(secrets, "k", "http://server.test:1447", call), /^Error: \/models\/probe failed \(500\)\.$/);

    // (d) an empty body falls back to the generic message.
    globalThis.fetch = stubFetch(429, "", "text/plain");
    await assert.rejects(callOpenGrokAccountApi(secrets, "k", "http://server.test:1447", call), /^Error: \/models\/probe failed \(429\)\.$/);
  } finally {
    globalThis.fetch = realFetch;
    await cleanup();
  }
});
