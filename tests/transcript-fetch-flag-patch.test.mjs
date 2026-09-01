import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { patchOriginalTranscriptFetchFlag } from "../scripts/lib/router-renderer-patch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A stand-in for the renderer's transcript store fetch driver, carrying the exact anchor text
// the patch keys on and enough of the surrounding closure to run. `F` is the tail fetch, `X`
// is the attempt counter captured at dispatch, and `fetchAttempt` is what a new resync bumps.
const FIXTURE = `
(function make(env){
  const d=false, F=env.F, N=env.N||(()=>{}), I=(j,f)=>f(), D=(j)=>{j.replica.status="synced"}, O=()=>{}, E=env.E||(()=>{}), W=()=>{}, H=()=>{};
  class wn extends Error { constructor(f){ super(f.code); this.failure=f; } }
  const z=j=>{if(d||j.isFetchInFlight)return;j.isFetchInFlight=!0,j.isActivityRefreshQueued=!1;const Z=j.replica.view();Z.status==="resyncing"&&N(j);const X=j.fetchAttempt,se={anchor:j.observedAnchor,attemptId:Z.currentResyncAttemptId,windowAtDispatch:Z.value};F(j).then(le=>{if(X!==j.fetchAttempt)return;j.isFetchInFlight=!1,j.lastFailure=null;const Q=j.replica.view().value;if(I(j,()=>D(j,le,se)),j.replica.view().status==="resyncing"){O(j),z(j);return}E(j,"covered"),W(j),H(),O(j),j.isActivityRefreshQueued&&z(j)},le=>{if(X!==j.fetchAttempt)return;j.isFetchInFlight=!1;const Q=j.isActivityRefreshQueued;if(j.isActivityRefreshQueued=!1,!(le instanceof wn))throw le;j.lastFailure=le.failure,O(j),Q&&z(j)})};
  return { z, wn };
})
`;

function store(status) {
  // The real replica flips to "synced" once a fetched tail installs a baseline (D above).
  const replica = { status, view() { return { status: this.status, currentResyncAttemptId: 1, value: {} }; } };
  return { isFetchInFlight: false, isActivityRefreshQueued: false, fetchAttempt: 0, observedAnchor: null, lastFailure: null, replica };
}

async function tick() { await new Promise((r) => setTimeout(r, 0)); }

// Reproduced 2 Sep 2026: a resync attempt that starts while a tail fetch is in flight bumps
// fetchAttempt, the fetch's reply is discarded with isFetchInFlight still true, and every later
// resync returns early on that flag. The reply to a sent message is published and received by
// the coordinator, and the page shows "…" until Cmd+R rebuilds it from the tail.
test("the unpatched driver leaves the fetch flag stuck after a superseded reply", async () => {
  const { z } = eval(FIXTURE)({ F: () => Promise.resolve({ entries: [] }) });
  const j = store("resyncing");
  z(j);
  j.fetchAttempt += 1; // a new resync attempt started while the fetch was in flight
  await tick(); await tick();
  assert.equal(j.isFetchInFlight, true, "this is the defect: the flag is never released");
});

test("the patched driver releases a superseded fetch and re-fetches while the replica is resyncing", async () => {
  const calls = [];
  const patched = patchOriginalTranscriptFetchFlag(FIXTURE);
  assert.match(patched, /__sandFetchSeq/);
  const { z } = eval(patched)({ F: (j) => { calls.push(j.fetchAttempt); return Promise.resolve({ entries: [] }); } });
  const j = store("resyncing");
  z(j);
  assert.equal(calls.length, 1);
  j.fetchAttempt += 1;
  await tick(); await tick();
  // The superseded reply released the flag it owned and, since the replica still needs a
  // baseline, fetched again under the new attempt.
  assert.equal(calls.length, 2, "re-fetched for the new attempt");
  assert.equal(calls[1], 1);
  await tick(); await tick();
  assert.equal(j.isFetchInFlight, false);
});

test("a superseded reply never releases a newer fetch's flag, and a settled fetch behaves as before", async () => {
  let resolveFirst;
  const first = new Promise((r) => { resolveFirst = r; });
  let n = 0;
  const patched = patchOriginalTranscriptFetchFlag(FIXTURE);
  const covered = [];
  const { z } = eval(patched)({ F: () => (n++ === 0 ? first : new Promise(() => {})), E: (_j, o) => covered.push(o) });
  const j = store("synced");
  z(j);                       // fetch #1 in flight
  j.fetchAttempt += 1;        // superseded by an external reset that also cleared the flag …
  j.isFetchInFlight = false;
  z(j);                       // … and started fetch #2, which stays pending
  assert.equal(j.isFetchInFlight, true);
  resolveFirst({ entries: [] });
  await tick(); await tick();
  assert.equal(j.isFetchInFlight, true, "fetch #2 still owns the flag; the stale reply must not clear it");
  assert.deepEqual(covered, []);
  // A fetch that is not superseded settles exactly as the original did.
  const { z: z2 } = eval(patched)({ F: () => Promise.resolve({ entries: [] }), E: (_j, o) => covered.push(o) });
  const k = store("synced");
  z2(k);
  await tick(); await tick();
  assert.equal(k.isFetchInFlight, false);
  assert.deepEqual(covered, ["covered"]);
});

test("the patch is registered on the renderer chunk pipeline", async () => {
  const src = await readFile(path.join(repoRoot, "scripts", "lib", "router-renderer-patch.mjs"), "utf8");
  assert.match(src, /patchOriginalTranscriptFetchFlag\(patchOriginalMediaMeta\(/);
  assert.match(src, /"transcript-fetch-flag-release"/);
});
