import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadRecorder() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-transport-echo-"));
  const outfile = path.join(temporary, "recorder.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/telemetry/transport-stage-recorder.ts")],
    outfile, bundle: true, format: "esm", platform: "node", target: "node22",
  });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

function fakeClock() {
  let ms = 1_000_000;
  return { now: () => ms, monotonicNow: () => ms, advance(by) { ms += by; }, schedule() { return { dispose() {} }; } };
}

// A send whose user-message echo never comes back over the stream is the silent failure this
// whole surface exists for: the POST was accepted, the server ran the turn, the page shows
// nothing, and the person presses Cmd+R. It used to expire quietly inside the recorder.
test("a send whose echo does not arrive within 30s is reported once as missing, and the listener is told", async () => {
  const { loaded, cleanup } = await loadRecorder();
  try {
    const clock = fakeClock();
    const stages = [];
    const missing = [];
    const recorder = loaded.createTransportStageRecorder({
      clock,
      sweepIntervalMs: null,
      onEchoMissing: (key) => missing.push(key),
      egress: {
        reportTransportStage: async (report) => { stages.push(report); },
        reportGatewayCommandSpan: async () => {},
        reportGatewayReachability: async () => {},
        reportGatewayDnsDiagnostic: async () => {},
      },
    });
    // Unsampled send: no traceparent. The liveness check must not depend on trace sampling.
    recorder.beginSend({ accountSlot: "host", clientNonce: "n1", traceparent: null });
    assert.equal(recorder.pendingEchoCount(), 1, "an unsampled send is still armed");
    clock.advance(loaded.SSE_ECHO_MISSING_AFTER_MS - 1);
    recorder.sweepEchoes();
    assert.equal(stages.length, 0, "nothing is reported before the deadline");
    clock.advance(2);
    recorder.sweepEchoes();
    recorder.sweepEchoes();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(stages.length, 1, "reported exactly once, however often the sweep runs");
    assert.equal(stages[0].stage, loaded.SSE_ECHO_MISSING_STAGE);
    assert.equal(stages[0].isError, true);
    assert.equal(stages[0].clientNonce, "n1");
    assert.ok(stages[0].durationMs >= loaded.SSE_ECHO_MISSING_AFTER_MS);
    assert.deepEqual(missing, [{ accountSlot: "host", clientNonce: "n1" }]);

    // A late echo still closes the send, and says it was late.
    recorder.recordSendEcho({ accountSlot: "host", clientNonce: "n1" });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(stages.length, 2);
    assert.equal(stages[1].stage, loaded.SSE_ECHO_STAGE);
    assert.equal(stages[1].attempt, 1, "attempt 1 marks an echo that arrived after it was reported missing");
    assert.equal(recorder.pendingEchoCount(), 0);
    recorder.dispose();
  } finally {
    await cleanup();
  }
});

test("an echo that arrives in time is never reported missing", async () => {
  const { loaded, cleanup } = await loadRecorder();
  try {
    const clock = fakeClock();
    const stages = [];
    let told = 0;
    const recorder = loaded.createTransportStageRecorder({
      clock, sweepIntervalMs: null, onEchoMissing: () => { told += 1; },
      egress: { reportTransportStage: async (r) => { stages.push(r); }, reportGatewayCommandSpan: async () => {}, reportGatewayReachability: async () => {}, reportGatewayDnsDiagnostic: async () => {} },
    });
    recorder.beginSend({ accountSlot: "host", clientNonce: "n2", traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" });
    clock.advance(800);
    recorder.recordSendEcho({ accountSlot: "host", clientNonce: "n2" });
    clock.advance(loaded.SSE_ECHO_MISSING_AFTER_MS * 2);
    recorder.sweepEchoes();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(stages.length, 1);
    assert.equal(stages[0].stage, loaded.SSE_ECHO_STAGE);
    assert.equal(stages[0].attempt, 0);
    assert.equal(stages[0].durationMs, 800, "the echo stage carries how long the round trip took");
    assert.equal(told, 0);
    recorder.dispose();
  } finally {
    await cleanup();
  }
});

// The coordinator wires the listener to the renderer's transport state and a forced reconnect;
// the source is checked because that wiring has no seam of its own to load in isolation.
test("the coordinator turns a missing echo into a transport-down state and a forced reconnect", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(path.join(repoRoot, "source/node-agent-coordinator/main.ts"), "utf8");
  assert.match(source, /onEchoMissing = \(key\) => \{[\s\S]*?COORDINATOR_TRANSPORT_STATE_FAMILY, \{ state: "down" \}[\s\S]*?gatewayClient\.forceReconnect\(\)/);
  assert.match(source, /recorder\.dispose\(\);/, "the sweep timer is stopped when the coordinator settles");
});
