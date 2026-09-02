import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(dir) {
  const outfile = path.join(dir, "read-cache.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/gateway/read-cache.ts")],
    outfile, bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "silent",
  });
  return import(`${pathToFileURL(outfile).href}?${Date.now()}`);
}

const unreachable = { status: "failed", failure: { code: "gateway-unreachable", message: "roster unavailable" } };
const roster = [{ id: "cw_1", name: "Ada" }, { id: "cw_2", name: "Bob" }];
const tail = { entries: [{ id: "e1", kind: "message" }] };

function harness(mod, dir, answers, clock = { t: 1_000 }, extra = {}) {
  const posted = [];
  const transport = [];
  const calls = [];
  const dispatch = mod.createCachedReadDispatch({
    postTransportState: (state) => transport.push(state),
    dispatch: async (method, args) => { calls.push(method); const next = answers.shift(); return typeof next === "function" ? next(method, args) : next; },
    cacheFile: path.join(dir, "read-cache.json"),
    postEvent: (family, payload) => posted.push([family, payload]),
    now: () => clock.t,
    saveImmediately: true,
    serveCachedAfterMs: 15,
    serveCachedWhenHealthyMs: 15,
    ...extra,
  });
  return { dispatch, posted, calls, transport };
}

// On the OpenGrok route the page keeps nothing, so a dead server used to paint a blank roster
// that read as "my bots were deleted". The last good answers are kept and served, and the page
// is told, on its own family, that they are old.
test("a failed roster read serves the last good roster and says the reads are stale", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    const clock = { t: 1_000 };
    const h = harness(mod, dir, [{ status: "ok", value: roster }, unreachable, unreachable, unreachable], clock);
    assert.deepEqual(await h.dispatch("listAgents", undefined), { status: "ok", value: roster });
    assert.equal(h.posted.length, 0, "a live read announces nothing");

    clock.t = 5_000;
    const served = await h.dispatch("listAgents", undefined);
    assert.deepEqual(served, { status: "ok", value: roster }, "the page gets the roster it had, at once");
    assert.equal(h.posted.length, 0, "one failure is not yet an outage: the page is not told");

    // A failure past the grace is: the page hears stale, with when the roster was last live.
    clock.t = 5_000 + mod.STALE_GRACE_MS;
    await h.dispatch("listAgents", undefined);
    assert.deepEqual(h.posted, [[mod.SERVER_READS_FAMILY, { state: "stale", since: 5_000, cached: true, cachedAt: 1_000, message: "roster unavailable" }]]);

    await h.dispatch("listAgents", undefined);
    assert.equal(h.posted.length, 1, "a further failure does not repeat the announcement");
    assert.equal(h.dispatch.current().since, 5_000, "since is when it first failed");
    assert.deepEqual(h.transport, ["down"], "the page is put into its offline mode, where it shows its saved roster and parks sends");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("with nothing cached the failure passes through, and the page is told nothing has loaded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    const h = harness(mod, dir, [unreachable]);
    assert.deepEqual(await h.dispatch("listAgents", undefined), unreachable);
    h.dispatch.graceElapsed();
    assert.deepEqual(h.posted[0][1], { state: "stale", since: 1_000, cached: false, cachedAt: null, message: "roster unavailable" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the first live read after an outage announces live again, once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    const h = harness(mod, dir, [{ status: "ok", value: roster }, unreachable, { status: "ok", value: roster }, { status: "ok", value: roster }]);
    await h.dispatch("listAgents", undefined);
    await h.dispatch("listAgents", undefined);
    h.dispatch.graceElapsed();
    await h.dispatch("listAgents", undefined);
    await h.dispatch("listAgents", undefined);
    assert.deepEqual(h.posted.map(([, p]) => p.state), ["stale", "live"]);
    assert.deepEqual(h.transport, ["down", "connected"], "and taken out of it by the first live read");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transcript tails are cached per coworker and survive a restart on disk", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    const first = harness(mod, dir, [{ status: "ok", value: roster }, { status: "ok", value: tail }]);
    await first.dispatch("listAgents", undefined);
    await first.dispatch("getAgentTranscriptTail", { id: "cw_1" });
    const onDisk = JSON.parse(await readFile(path.join(dir, "read-cache.json"), "utf8"));
    assert.equal(onDisk.schemaVersion, 1);
    assert.deepEqual(onDisk.roster.value, roster);
    assert.deepEqual(onDisk.tails["tail:cw_1"].value, tail);

    // A fresh process, server dead from the start: the page still gets both.
    const second = harness(mod, dir, [unreachable, unreachable, unreachable]);
    assert.deepEqual(await second.dispatch("listAgents", undefined), { status: "ok", value: roster });
    assert.deepEqual(await second.dispatch("getAgentTranscriptTail", { id: "cw_1" }), { status: "ok", value: tail });
    assert.deepEqual(await second.dispatch("getAgentTranscriptTail", { id: "cw_9" }), unreachable, "a coworker never fetched has nothing to serve");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only reads that decide the picture are cached; everything else passes straight through", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    const h = harness(mod, dir, [unreachable, { status: "failed", failure: { code: "unknown-method", message: "no" } }]);
    assert.deepEqual(await h.dispatch("sendPrompt", { text: "hi" }), unreachable, "a send is never served from cache");
    assert.equal(h.posted.length, 0, "and does not touch the reads state");
    assert.equal((await h.dispatch("listAgents", undefined)).status, "failed");
    assert.equal(h.posted.length, 0, "a wrong request is not a dead server");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the tail cache is bounded and drops the oldest fetched", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    const clock = { t: 0 };
    const answers = Array.from({ length: mod.MAX_CACHED_TAILS + 1 }, () => ({ status: "ok", value: tail }));
    const h = harness(mod, dir, answers, clock);
    for (let index = 0; index <= mod.MAX_CACHED_TAILS; index += 1) {
      clock.t = index;
      await h.dispatch("getAgentTranscriptTail", { id: `cw_${index}` });
    }
    const onDisk = JSON.parse(await readFile(path.join(dir, "read-cache.json"), "utf8"));
    assert.equal(Object.keys(onDisk.tails).length, mod.MAX_CACHED_TAILS);
    assert.equal(onDisk.tails["tail:cw_0"], undefined, "the oldest went first");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Reads race the transport at boot and a server restart drops one; neither is an outage. The
// page is told only when failures persist past the grace, so the banner does not flash at
// every launch — which it did on the first build of this, for seventeen seconds.
test("one failed read followed by a success never reaches the page", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    const h = harness(mod, dir, [{ status: "ok", value: roster }, unreachable, { status: "ok", value: roster }]);
    await h.dispatch("listAgents", undefined);
    await h.dispatch("listAgents", undefined);
    await h.dispatch("listAgents", undefined);
    h.dispatch.graceElapsed();
    assert.equal(h.posted.length, 0);
    assert.equal(h.dispatch.current().state, "live");
    assert.deepEqual(h.transport, [], "and the transport is never touched by a transient");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The page gives up on a read long before the gateway's own timeout, so a cached answer that
// arrives only after the live read has timed out arrives after the page stopped listening — the
// blank roster with a correct banner above it, captured 2 Sep 2026. The cache answers fast.
test("a live read that is slow is answered from the cache within the wait, and the live answer still refreshes the cache", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    let releaseLive = null;
    const slow = () => new Promise((resolve) => { releaseLive = resolve; });
    const fresher = [{ id: "cw_1", name: "Ada" }, { id: "cw_2", name: "Bob" }, { id: "cw_3", name: "Cy" }];
    const h = harness(mod, dir, [{ status: "ok", value: roster }, slow]);
    await h.dispatch("listAgents", undefined);
    const started = Date.now();
    const served = await h.dispatch("listAgents", undefined);
    assert.ok(Date.now() - started < 1_000, "answered from the cache, not after a timeout");
    assert.deepEqual(served, { status: "ok", value: roster });
    assert.equal(h.posted.length, 0, "a slow read is not yet a dead server");
    releaseLive({ status: "ok", value: fresher });
    await new Promise((r) => setTimeout(r, 5));
    const onDisk = JSON.parse(await readFile(path.join(dir, "read-cache.json"), "utf8"));
    assert.deepEqual(onDisk.roster.value, fresher, "the live answer refreshed the cache for the next read");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("once reads are known to be failing, the cache answers at once and the live read revalidates behind it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    const h = harness(mod, dir, [{ status: "ok", value: roster }, unreachable, unreachable, { status: "ok", value: roster }]);
    await h.dispatch("listAgents", undefined);
    await h.dispatch("listAgents", undefined);
    h.dispatch.graceElapsed();
    assert.equal(h.dispatch.current().state, "stale");
    const started = Date.now();
    assert.deepEqual(await h.dispatch("listAgents", undefined), { status: "ok", value: roster });
    assert.ok(Date.now() - started < 10, "no wait at all while stale");
    await new Promise((r) => setTimeout(r, 5));
    await h.dispatch("listAgents", undefined);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(h.dispatch.current().state, "live", "the revalidating read that succeeded flipped the state back");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// With nothing on screen asking for anything, no read would run again and the page would sit on
// the banner after the server came back. While stale, the roster is re-read on its own.
test("while stale the roster is re-read on its own until the server answers, and the page hears live", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    const clock = { t: 1_000 };
    const h = harness(mod, dir, [{ status: "ok", value: roster }, unreachable, unreachable, { status: "ok", value: roster }], clock, { revalidateEveryMs: 10 });
    await h.dispatch("listAgents", undefined);
    clock.t = 5_000;
    await h.dispatch("listAgents", undefined);
    h.dispatch.graceElapsed();
    assert.equal(h.dispatch.current().state, "stale");
    const before = h.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(h.calls.length - before, 2, "one read failed and was re-armed, the next succeeded, then it stopped");
    assert.equal(h.dispatch.current().state, "live", "nobody asked, and the page still heard live");
    assert.deepEqual(h.transport, ["down", "connected"]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(h.calls.length - before, 2, "live reads are not polled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The stream opens with a complete roster the server does not check; with its database down
// that is an empty one. Recognise exactly that shape.
test("an empty complete-roster frame is recognised; a partial or filled one is not", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    assert.equal(mod.rosterFrameClaimsEmpty({ agents: [], coverage: { kind: "complete-roster" }, ordered: { epoch: "e", sequence: 9 } }), true);
    assert.equal(mod.rosterFrameClaimsEmpty({ agents: [] }), true, "no coverage means complete, as the page reads it");
    assert.equal(mod.rosterFrameClaimsEmpty({ agents: roster, coverage: { kind: "complete-roster" } }), false);
    assert.equal(mod.rosterFrameClaimsEmpty({ agents: [], coverage: { kind: "partial" } }), false, "a partial frame erases nothing");
    assert.equal(mod.rosterFrameClaimsEmpty(null), false);
    assert.equal(mod.rosterFrameClaimsEmpty({ agents: "none" }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live roster check returns the rows, or null when the server could not answer, and moves the reads state like any read", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    const clock = { t: 1_000 };
    const h = harness(mod, dir, [{ status: "ok", value: roster }, unreachable, () => { throw new Error("socket hang up"); }, { status: "ok", value: [] }], clock);
    assert.equal(h.dispatch.cachedRosterCount(), 0, "nothing cached yet");
    assert.deepEqual(await h.dispatch.revalidateRoster(), roster);
    assert.equal(h.dispatch.cachedRosterCount(), 2);
    clock.t = 5_000;
    assert.equal(await h.dispatch.revalidateRoster(), null, "a refusal is null, not the cache");
    clock.t = 5_000 + mod.STALE_GRACE_MS;
    assert.equal(await h.dispatch.revalidateRoster(), null, "a thrown transport error is a failure too");
    assert.equal(h.dispatch.current().state, "stale");
    assert.deepEqual(await h.dispatch.revalidateRoster(), [], "an empty live roster is the truth: returned, and the reads are live");
    assert.equal(h.dispatch.current().state, "live");
    assert.equal(h.dispatch.cachedRosterCount(), 0, "and the cache now holds the empty roster");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A 4xx for one coworker, or a malformed reply, is that request's own problem: it goes back
// as the failure it is, counts for nothing, and never puts the page into its offline mode.
test("a request's own failure is passed through and does not count as an outage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    const clock = { t: 1_000 };
    const gone = { status: "failed", failure: { code: "gateway-command-failed", message: "no such coworker" } };
    const h = harness(mod, dir, [{ status: "ok", value: tail }, gone, gone], clock);
    await h.dispatch("getAgentTranscriptTail", { id: "cw_1" });
    clock.t = 5_000 + mod.STALE_GRACE_MS;
    assert.deepEqual(await h.dispatch("getAgentTranscriptTail", { id: "cw_1" }), gone, "not the cache: the page hears the real error");
    h.dispatch.graceElapsed();
    assert.equal(h.dispatch.current().state, "live");
    assert.deepEqual(h.transport, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Two reads of the same key in flight, the older one answering last, must not leave the older
// answer in the cache.
test("an older read that answers last does not overwrite a newer answer", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    let releaseOld;
    const old = new Promise((resolve) => { releaseOld = resolve; });
    const h = harness(mod, dir, [() => old, { status: "ok", value: [{ id: "cw_9", name: "New" }] }], { t: 1_000 }, { serveCachedWhenHealthyMs: 10_000 });
    const first = h.dispatch("listAgents", undefined);
    await h.dispatch("listAgents", undefined);
    assert.equal(h.dispatch.cachedRosterCount(), 1);
    releaseOld({ status: "ok", value: roster });
    assert.deepEqual(await first, { status: "ok", value: roster }, "the caller of the older read still gets its answer");
    const file = JSON.parse(await readFile(path.join(dir, "read-cache.json"), "utf8"));
    assert.deepEqual(file.roster.value, [{ id: "cw_9", name: "New" }], "but the cache keeps the newer one");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// While the server looks healthy a slow read is waited for, so a slow-but-working server is not
// shown one read behind; once a failure has been seen the cache answers quickly.
test("the cache answers quickly only once a failure has been seen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    const slow = (value, ms) => () => new Promise((resolve) => setTimeout(() => resolve(value), ms));
    const h = harness(mod, dir, [{ status: "ok", value: roster }, slow({ status: "ok", value: [] }, 40), unreachable, slow({ status: "ok", value: [] }, 200)], { t: 1_000 }, { serveCachedAfterMs: 15, serveCachedWhenHealthyMs: 100 });
    await h.dispatch("listAgents", undefined);
    assert.deepEqual(await h.dispatch("listAgents", undefined), { status: "ok", value: [] }, "healthy: the slow live answer is waited for");
    await h.dispatch("listAgents", undefined);
    const started = Date.now();
    assert.deepEqual(await h.dispatch("listAgents", undefined), { status: "ok", value: [] }, "failing: the cache (now the empty roster) answers");
    assert.ok(Date.now() - started < 150, "well before the live read would have");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a damaged cache entry on disk is ignored, and the file is owner-only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "read-cache-"));
  try {
    const mod = await loadModule(dir);
    const { writeFile, stat } = await import("node:fs/promises");
    await writeFile(path.join(dir, "read-cache.json"), JSON.stringify({ schemaVersion: 1, roster: { value: roster, at: 5 }, tails: { "tail:x": 5, "tail:y": { value: tail, at: 6 }, "tail:z": { at: 7 } } }));
    const loaded = mod.loadCacheFile(path.join(dir, "read-cache.json"));
    assert.deepEqual(Object.keys(loaded.tails), ["tail:y"]);
    assert.equal(loaded.roster.at, 5);
    const h = harness(mod, dir, [unreachable, { status: "ok", value: tail }], { t: 1_000 });
    assert.deepEqual(await h.dispatch("getAgentTranscriptTail", { id: "x" }), unreachable, "nothing usable cached for x: the failure itself");
    await h.dispatch("getAgentTranscriptTail", { id: "x" });
    if (process.platform !== "win32") assert.equal((await stat(path.join(dir, "read-cache.json"))).mode & 0o777, 0o600, "rewritten owner-only");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
