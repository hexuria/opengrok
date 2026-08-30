import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(sourcePath) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-routed-messages-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, sourcePath)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function harness(create, overrides = {}) {
  const calls = { emitted: [], ran: [], permissionSet: [] };
  let permission = overrides.permission ?? "ask";
  let counter = 0;
  const tools = create({
    emitTranscript: (agentId, type, entry) => { calls.emitted.push({ agentId, type, entry }); },
    getPermission: () => permission,
    setPermission: (next) => { permission = next; calls.permissionSet.push(next); },
    runMessagesOp: async (op) => {
      calls.ran.push(op);
      return overrides.result ?? { ok: true, kind: "read", transcript: "[t] Ada — you: hi", count: 1 };
    },
    now: () => 1_800_000_000_000,
    randomId: () => `req-${++counter}`,
    askTimeoutMs: overrides.askTimeoutMs ?? 50,
  });
  return { calls, tools, permission: () => permission };
}

const READ_ARGS = { contact: "Ada", limit: 5 };

test("nothing is read until the user answers the card", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/routed-messages-tools.ts");
  try {
    const { createRoutedMessagesTools } = loaded.module;
    const h = harness(createRoutedMessagesTools);
    const [read] = h.tools.tools("agent-1");

    const inFlight = read.execute(READ_ARGS);
    await new Promise((resolve) => setImmediate(resolve));

    // The card must be on screen, and the database untouched, before the answer.
    assert.equal(h.calls.ran.length, 0, "must not read before approval");
    assert.equal(h.calls.emitted.length, 1);
    const ask = h.calls.emitted[0].entry.message.ask;
    assert.equal(h.calls.emitted[0].type, "appended");
    assert.equal(h.calls.emitted[0].entry.message.type, "local-tool-permission");
    assert.equal(ask.status, "pending");
    assert.equal(ask.action, "read-messages");
    assert.equal(ask.target, "Ada", "the prompt names whose conversation it is");

    assert.equal(h.tools.resolveAsk({ agentId: "agent-1", requestId: ask.requestId, resolution: "allow-once" }), true);
    assert.match(await inFlight, /1 message/);
    assert.deepEqual(h.calls.ran, [{ op: "read", contact: "Ada", limit: 5 }]);
    // The card is settled so it stops looking like it still wants an answer.
    assert.equal(h.calls.emitted.at(-1).type, "updated");
    assert.equal(h.calls.emitted.at(-1).entry.message.ask.status, "allow-once");
  } finally {
    await loaded.dispose();
  }
});

test("a read with no contact says so, rather than looking narrow", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/routed-messages-tools.ts");
  try {
    const h = harness(loaded.module.createRoutedMessagesTools);
    const [read] = h.tools.tools("agent-1");
    const inFlight = read.execute({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.emitted[0].entry.message.ask.target, "all recent conversations");
    h.tools.resolveAsk({ requestId: h.calls.emitted[0].entry.message.ask.requestId, resolution: "deny" });
    await inFlight;
  } finally {
    await loaded.dispose();
  }
});

test("the standing setting is honoured in both directions", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/routed-messages-tools.ts");
  try {
    const { createRoutedMessagesTools } = loaded.module;

    // "never" refuses without even raising a card.
    const never = harness(createRoutedMessagesTools, { permission: "never" });
    const refused = await never.tools.tools("a")[0].execute(READ_ARGS);
    assert.match(refused, /not allowed reading Messages/);
    assert.equal(never.calls.emitted.length, 0);
    assert.equal(never.calls.ran.length, 0);

    // "always" runs with no card, because the user already said so.
    const always = harness(createRoutedMessagesTools, { permission: "always" });
    assert.match(await always.tools.tools("a")[0].execute(READ_ARGS), /1 message/);
    assert.equal(always.calls.emitted.length, 0);
    assert.equal(always.calls.ran.length, 1);

    // Answering "always" persists, so the next call stops asking.
    const persist = harness(createRoutedMessagesTools);
    const first = persist.tools.tools("a")[0].execute(READ_ARGS);
    await new Promise((resolve) => setImmediate(resolve));
    persist.tools.resolveAsk({ requestId: persist.calls.emitted[0].entry.message.ask.requestId, resolution: "always" });
    await first;
    assert.deepEqual(persist.calls.permissionSet, ["always"]);
    assert.equal(persist.permission(), "always");
  } finally {
    await loaded.dispose();
  }
});

test("reading and sending are separate approvals", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/routed-messages-tools.ts");
  try {
    const h = harness(loaded.module.createRoutedMessagesTools);
    const [read, send] = h.tools.tools("agent-1");
    assert.equal(read.name, "ReadMessages");
    assert.equal(send.name, "SendIMessage");

    const sending = send.execute({ to: "+15551234567", body: "on my way" });
    await new Promise((resolve) => setImmediate(resolve));
    const ask = h.calls.emitted[0].entry.message.ask;
    assert.equal(ask.action, "send-imessage", "sending must never be asked for as a read");
    assert.equal(ask.target, "+15551234567");

    // Approving the send must not leave a standing read approval behind.
    h.tools.resolveAsk({ requestId: ask.requestId, resolution: "allow-once" });
    await sending;
    assert.equal(h.calls.permissionSet.length, 0);

    const reading = read.execute(READ_ARGS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.emitted.filter((e) => e.type === "appended").length, 2, "the read must ask again");
    h.tools.resolveAsk({ requestId: h.calls.emitted.at(-1).entry.message.ask.requestId, resolution: "deny" });
    await reading;
  } finally {
    await loaded.dispose();
  }
});

test("only our own cards are answered, and an ignored one never hangs the turn", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/routed-messages-tools.ts");
  try {
    const h = harness(loaded.module.createRoutedMessagesTools, { askTimeoutMs: 30 });
    const [read] = h.tools.tools("agent-1");

    // A host-owned ask must fall through to the gateway untouched.
    assert.equal(h.tools.resolveAsk({ requestId: "someone-elses", resolution: "allow-once" }), false);
    assert.equal(h.tools.resolveAsk({ resolution: "allow-once" }), false);

    const inFlight = read.execute(READ_ARGS);
    await new Promise((resolve) => setImmediate(resolve));
    const { requestId } = h.calls.emitted[0].entry.message.ask;

    // Wrong agent, and an unknown resolution, are both refused.
    assert.equal(h.tools.resolveAsk({ agentId: "other-agent", requestId, resolution: "allow-once" }), false);
    assert.equal(h.tools.resolveAsk({ requestId, resolution: "maybe" }), false);

    // Left unanswered, it times out as a denial rather than hanging forever.
    assert.match(await inFlight, /not allowed reading Messages/);
    assert.equal(h.calls.ran.length, 0);
    assert.equal(h.tools.resolveAsk({ requestId, resolution: "allow-once" }), false, "a settled card is no longer answerable");
  } finally {
    await loaded.dispose();
  }
});

test("a failed read reports why instead of pretending there were no messages", async () => {
  const loaded = await loadModule("source/node-agent-coordinator/routed-messages-tools.ts");
  try {
    const h = harness(loaded.module.createRoutedMessagesTools, {
      permission: "always",
      result: { ok: false, error: "OpenGrok does not have Full Disk Access…" },
    });
    assert.match(await h.tools.tools("a")[0].execute(READ_ARGS), /Full Disk Access/);
  } finally {
    await loaded.dispose();
  }
});

test("tool arguments map onto the Messages request", async () => {
  const loaded = await loadModule("source/shared/messages-request.ts");
  try {
    const { messagesOpFromToolArgs } = loaded.module;
    const now = 1_800_000_000_000;
    assert.deepEqual(messagesOpFromToolArgs("ReadMessages", { contact: "Ada", limit: 5 }, now), { op: "read", contact: "Ada", limit: 5 });
    assert.deepEqual(messagesOpFromToolArgs("ReadMessages", {}, now), { op: "read" });
    assert.deepEqual(messagesOpFromToolArgs("ReadMessages", { since_hours: 2 }, now), { op: "read", sinceMs: now - 7_200_000 });
    assert.deepEqual(messagesOpFromToolArgs("SendIMessage", { to: " +1 ", body: " hi " }, now), { op: "send", to: "+1", body: "hi" });
    // A send missing either half must not be turned into a partial send.
    assert.equal(messagesOpFromToolArgs("SendIMessage", { to: "+1" }, now), undefined);
    assert.equal(messagesOpFromToolArgs("SendIMessage", { body: "hi" }, now), undefined);
    assert.equal(messagesOpFromToolArgs("SomethingElse", {}, now), undefined);
  } finally {
    await loaded.dispose();
  }
});
