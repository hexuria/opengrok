import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-telemetry-log-"));
  const outfile = path.join(temporary, "local-telemetry-log.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/telemetry/local-telemetry-log.ts")],
    outfile, bundle: true, format: "esm", platform: "node", target: "node22",
  });
  const loaded = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return { loaded, dir: temporary, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

// The coordinator already reports every transport event; against an OpenGrok server the
// uploader they flow into answers empty, so "was the stream up when the user sent hello"
// had to be reconstructed from process start times. This file is the durable copy.
test("every appended event lands as one timestamped, redacted JSON line", async () => {
  const { loaded, dir, cleanup } = await loadModule();
  try {
    const log = loaded.createLocalTelemetryLog({ dir: path.join(dir, "data"), now: () => Date.UTC(2026, 8, 2, 3, 16, 14) });
    log.append("info", "sand.box_reachability", { outcome: "ok", method: "events", request_id: "req-1", latency_ms: "12" });
    log.append("warn", "sand.box_status", {
      state: "running",
      vncUrl: "https://box-6080.on.ascii.dev/vnc.html?password=lVRE33hB&_token=0e202f85",
      preview: "https://box-3000.on.ascii.dev/?_token=abc&x=1",
      authorization: "Bearer opengrok-lan-verify",
      skipped: undefined,
    });
    await log.settle();
    const lines = (await readFile(log.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].at, "2026-09-02T03:16:14.000Z");
    assert.equal(lines[0].event, "sand.box_reachability");
    assert.equal(lines[0].request_id, "req-1", "the request id is what joins this line to the server's log");
    // A screen URL carries a password and a token; neither may reach the disk, ever.
    assert.equal(lines[1].vncUrl, "<redacted>");
    assert.equal(lines[1].authorization, "<redacted>");
    assert.equal(lines[1].preview, "https://box-3000.on.ascii.dev/?_token=<redacted>&x=1", "a token in a query string is blanked, the URL shape kept");
    assert.equal("skipped" in lines[1], false, "undefined values are dropped, not written as null");
    assert.equal(lines[1].state, "running");
  } finally {
    await cleanup();
  }
});

test("the log rolls over at its size cap instead of growing forever", async () => {
  const { loaded, dir, cleanup } = await loadModule();
  try {
    const log = loaded.createLocalTelemetryLog({ dir, maxBytes: 400 });
    for (let i = 0; i < 12; i += 1) log.append("info", "sand.send_stage", { stage: "post", attempt: i, padding: "x".repeat(40) });
    await log.settle();
    const rolled = await stat(`${log.path}.1`).then(() => true, () => false);
    assert.equal(rolled, true, "the previous file is kept as .1");
    const size = (await stat(log.path)).size;
    assert.ok(size <= 400 + 200, `the live file stays near the cap, got ${size}`);
  } finally {
    await cleanup();
  }
});

test("a broken append never throws into the caller and the log can be switched off", async () => {
  const { loaded, cleanup } = await loadModule();
  try {
    const log = loaded.createLocalTelemetryLog({ dir: "/dev/null/not-a-dir" });
    log.append("info", "sand.anything", { ok: true });
    await log.settle();
    const cyclic = {}; cyclic.self = cyclic;
    log.append("info", "sand.unserialisable", { cyclic });
    await log.settle();
    assert.equal(loaded.localTelemetryLogEnabled({ SAND_LOCAL_TELEMETRY_LOG: "0" }), false);
    assert.equal(loaded.localTelemetryLogEnabled({}), true);
  } finally {
    await cleanup();
  }
});
