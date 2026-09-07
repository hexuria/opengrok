import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadMock() {
  const outdir = path.join(repoRoot, ".build");
  await mkdir(outdir, { recursive: true });
  const outfile = path.join(outdir, "mock-opengrok-account-test.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/mock/index.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
  });
  return import(`${pathToFileURL(outfile).href}?${Date.now()}`);
}

/*
 * The desktop reaches these paths through callOpenGrokAccountApi: a bearer, JSON
 * in and out, and a non-2xx read for `error`. Drive them the same way here — the
 * point of this mock is that the real client can talk to it, so a test that
 * called the class directly would prove nothing about the wire.
 */
async function withServer(run) {
  const mock = await loadMock();
  const server = await mock.listenMockServer({ host: "127.0.0.1", port: 0 });
  try {
    await run(mock, mock.mockServerUrl(server));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const authed = (url, path, init = {}) => fetch(new URL(path, url), {
  ...init,
  headers: { authorization: "Bearer mock-account-token", ...(init.headers ?? {}) },
});

test("the catalogue drives every branch the picker has", async () => {
  await withServer(async (mock, url) => {
    const response = await authed(url, "/models");
    assert.equal(response.status, 200);
    const body = await response.json();
    const ids = body.models.map((entry) => entry.id);

    // More than nine, so the list scrolls rather than fitting in one screen.
    assert.ok(ids.length > 9, `expected a catalogue worth scrolling, got ${ids.length}`);
    // The ladder group is decided purely on the oag/ prefix.
    assert.ok(ids.some((id) => id.startsWith("oag/")), "no ladder entry");
    assert.ok(ids.some((id) => !id.startsWith("oag/")), "no pinnable entry");
    // Both suffixes, or labelOf's subscription/API branches go uncovered.
    assert.ok(ids.some((id) => id.endsWith("@sub")), "no subscription entry");
    assert.ok(ids.some((id) => id.endsWith("@api")), "no API entry");
    // A gateway with no reference price is a real answer and the picker must
    // render it with no ×N rather than "×undefined".
    assert.ok(body.models.some((entry) => entry.points === null), "no unpriced entry");

    const priced = body.models.find((entry) => entry.points != null);
    // Multipliers are STRINGS on the wire. Numbers here would let a client bug
    // that only works on numbers pass against the mock and fail against a gateway.
    for (const key of ["shownX", "inputX", "outputX", "cacheReadX", "cacheWriteX"]) {
      assert.equal(typeof priced.points[key], "string", `${key} must be a string`);
    }
    // The real server sends a note only when it has nothing to list. Ours lists.
    assert.equal(body.note, undefined);
  });
});

test("coworkers carry a pin, and a pin survives being changed", async () => {
  await withServer(async (mock, url) => {
    const before = await (await authed(url, "/coworkers")).json();
    // A bare array: an empty roster must not become an object.
    assert.ok(Array.isArray(before), "the roster is an array");
    assert.ok(before.length > 0, "the mock store seeds agents");
    const target = before[0];
    assert.equal(target.model, mock.MOCK_DEFAULT_MODEL);

    const patched = await authed(url, `/coworkers/${encodeURIComponent(target.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.5" }),
    });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).model, "openai/gpt-5.5");

    // The picker saves and then reloads, so the round trip has to be real.
    const after = await (await authed(url, "/coworkers")).json();
    assert.equal(after.find((row) => row.id === target.id).model, "openai/gpt-5.5");
    // Only the one that was repinned moved.
    assert.equal(after.filter((row) => row.model === mock.MOCK_DEFAULT_MODEL).length, before.length - 1);
  });
});

test("a pin the catalogue does not list is still accepted", async () => {
  await withServer(async (mock, url) => {
    const id = (await (await authed(url, "/coworkers")).json())[0].id;
    // Nothing checks a pin against the catalogue, here or on the real server:
    // typing an id the gateway has not advertised is a legitimate thing to do,
    // and refusing it here would hide that the real server allows it.
    const response = await authed(url, `/coworkers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "someone/unlisted-model@api" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).model, "someone/unlisted-model@api");
  });
});

test("the refusals the client actually reads", async () => {
  await withServer(async (mock, url) => {
    // Signed out. The client turns a non-2xx `error` into the message it shows,
    // so the shape matters as much as the status.
    const anonymous = await fetch(new URL("/models", url));
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error, "sign in first");

    const id = (await (await authed(url, "/coworkers")).json())[0].id;
    const empty = await authed(url, `/coworkers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    assert.equal(typeof (await empty.json()).error, "string");

    const missing = await authed(url, "/coworkers/agent-that-never-existed", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "oag/auto" }),
    });
    assert.equal(missing.status, 404);

    const wrongMethod = await authed(url, "/models", { method: "POST" });
    assert.equal(wrongMethod.status, 405);
  });
});

test("account paths do not swallow the Connect surface", async () => {
  await withServer(async (mock, url) => {
    // The handler is tried BEFORE the Connect adapter, so a path it claims by
    // accident would take an RPC offline. /healthz still belongs to the others.
    assert.equal((await fetch(new URL("/healthz", url))).ok, true);
    const rpc = await fetch(new URL("/aiserver.v1.GrokBotService/ListGrokBotAgents", url), { method: "POST" });
    assert.notEqual(rpc.status, 401, "an RPC must not be answered by the account handler");
  });
});
