import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadPendingAsks() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "local-tool-pending-asks-"));
  const outfile = path.join(temporary, "asks.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/local-exec/local-tool-pending-asks.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["electron"],
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, dir: temporary, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const ASK = { id: "req-1", action: "run-command", target: "uname", askedAtMs: 1_000, origin: "http://server.test:1447" };

test("an answered allow only counts once it has become a real approval", async () => {
  const { loaded, cleanup } = await loadPendingAsks();
  try {
    const { pendingAskOutcome: outcome } = loaded;
    // The approvals file is what the gate consults, so a decision that never
    // became an approval must not be mistaken for one.
    assert.equal(outcome({ ask: { ...ASK, decision: "allow" }, isApproved: false, nowMs: 1_100 }), "waiting");
    assert.equal(outcome({ ask: { ...ASK, decision: "allow" }, isApproved: true, nowMs: 1_100 }), "approved");
    assert.equal(outcome({ ask: ASK, isApproved: true, nowMs: 1_100 }), "approved", "an approval settles it either way");
  } finally {
    await cleanup();
  }
});

test("a refusal, a withdrawal and an unanswered question all end the wait", async () => {
  const { loaded, cleanup } = await loadPendingAsks();
  try {
    const { pendingAskOutcome: outcome, LOCAL_TOOL_ASK_TIMEOUT_MS: ttl } = loaded;
    assert.equal(outcome({ ask: { ...ASK, decision: "deny" }, isApproved: false, nowMs: 1_100 }), "denied");
    assert.equal(outcome({ ask: undefined, isApproved: false, nowMs: 1_100 }), "denied", "the question was taken away");
    assert.equal(outcome({ ask: ASK, isApproved: false, nowMs: 1_000 + ttl }), "expired");
    assert.equal(outcome({ ask: ASK, isApproved: false, nowMs: 1_000 + ttl - 1 }), "waiting");
  } finally {
    await cleanup();
  }
});

test("questions round trip through the file, and answering keeps the record readable", async () => {
  const { loaded, dir, cleanup } = await loadPendingAsks();
  try {
    const file = path.join(dir, "asks.json");
    await loaded.recordLocalToolPendingAsk(ASK, file);
    await loaded.recordLocalToolPendingAsk({ ...ASK, id: "req-2", target: "whoami" }, file);
    assert.deepEqual((await loaded.readLocalToolPendingAsks(file)).map((a) => a.id), ["req-1", "req-2"]);

    assert.equal(await loaded.answerLocalToolPendingAsk("req-1", "allow", file), true);
    assert.equal(await loaded.answerLocalToolPendingAsk("never-asked", "allow", file), false, "an unknown id is not answerable");
    const answered = (await loaded.readLocalToolPendingAsks(file)).find((a) => a.id === "req-1");
    assert.equal(answered.decision, "allow");
    assert.equal(answered.target, "uname", "answering does not lose what was asked");

    await loaded.withdrawLocalToolPendingAsk("req-1", file);
    assert.deepEqual((await loaded.readLocalToolPendingAsks(file)).map((a) => a.id), ["req-2"]);

    // The last question out leaves no file behind rather than an empty one.
    await loaded.withdrawLocalToolPendingAsk("req-2", file);
    await assert.rejects(readFile(file, "utf8"));
  } finally {
    await cleanup();
  }
});

test("a question nobody answered is pruned rather than surfacing late", async () => {
  const { loaded, dir, cleanup } = await loadPendingAsks();
  try {
    const file = path.join(dir, "asks.json");
    await loaded.recordLocalToolPendingAsk(ASK, file);
    await loaded.recordLocalToolPendingAsk({ ...ASK, id: "fresh", askedAtMs: 500_000 }, file);
    await loaded.pruneLocalToolPendingAsks(500_100, loaded.LOCAL_TOOL_ASK_TIMEOUT_MS, file);
    assert.deepEqual((await loaded.readLocalToolPendingAsks(file)).map((a) => a.id), ["fresh"]);
  } finally {
    await cleanup();
  }
});

test("a malformed record is dropped instead of taken as a question", async () => {
  const { loaded, cleanup } = await loadPendingAsks();
  try {
    for (const bad of [
      { action: "run-command", target: "x", askedAtMs: 1 },
      { id: "a", action: "not-an-action", target: "x", askedAtMs: 1 },
      { id: "a", action: "run-command", target: "x" },
      { id: "", action: "run-command", target: "x", askedAtMs: 1 },
      null,
    ]) {
      assert.equal(loaded.parsePendingAsk(bad), undefined, JSON.stringify(bad));
    }
    assert.equal(loaded.parsePendingAsk({ ...ASK, decision: "maybe" }).decision, undefined, "an answer we do not know is no answer");
  } finally {
    await cleanup();
  }
});
