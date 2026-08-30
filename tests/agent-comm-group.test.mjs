import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-comm-"));
  const outfile = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { loaded, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

const MODULE = "frontend/src/recovered/features/conversation/system-event/agent-comm-group.ts";

const peer = (id, name) => ({ id, name });
const message = (id, extra = {}) => ({
  kind: "message",
  id,
  role: extra.role ?? "user",
  author: extra.author ?? "You",
  text: extra.text ?? "hi",
  timestampMs: extra.timestampMs ?? 1,
  ...extra,
});

/*
 * Every string and grouping rule was read off the 0.27 renderer bundle
 * (`dd` / `pYt` / `W7e` / `MYt` / `sJt` / `gYt`). If a label or collapse
 * decision drifts, the port stopped matching the app it came from.
 */

test("dd: a message is agent-comm when fromAgent or toAgent is present", async () => {
  const { loaded, cleanup } = await load(MODULE);
  try {
    assert.equal(loaded.isAgentCommMessage(message("a", { fromAgent: peer("puck", "Puck") })), true);
    assert.equal(loaded.isAgentCommMessage(message("b", { toAgent: peer("hex", "Hex") })), true);
    assert.equal(loaded.isAgentCommMessage(message("c")), false);
    assert.equal(loaded.isAgentCommMessage({ kind: "notice", id: "n", text: "hi" }), false);
    assert.equal(loaded.isAgentCommMessage(null), false);
    assert.equal(loaded.isAgentCommMessage({ kind: "message" }), false);
  } finally {
    await cleanup();
  }
});

test("pYt: fromAgent is inbound, toAgent is outbound, else null", async () => {
  const { loaded, cleanup } = await load(MODULE);
  try {
    assert.deepEqual(
      loaded.projectAgentCommHop(message("in", { fromAgent: peer("puck", "Puck") })),
      { direction: "inbound", peer: peer("puck", "Puck") },
    );
    assert.deepEqual(
      loaded.projectAgentCommHop(message("out", { toAgent: { id: "hex", name: "Hex", kind: "agent" } })),
      { direction: "outbound", peer: peer("hex", "Hex") },
    );
    assert.deepEqual(
      loaded.projectAgentCommHop(message("both", {
        fromAgent: peer("puck", "Puck"),
        toAgent: peer("hex", "Hex"),
      })),
      { direction: "inbound", peer: peer("puck", "Puck") },
    );
    assert.equal(loaded.projectAgentCommHop(message("plain")), null);
    assert.equal(loaded.projectAgentCommHop(message("bad", { fromAgent: { name: "No id" } })), null);
    assert.equal(loaded.projectAgentCommHop(null), null);
  } finally {
    await cleanup();
  }
});

test("W7e: single inbound, single outbound, fanout, thread", async () => {
  const { loaded, cleanup } = await load(MODULE);
  try {
    const inbound = message("i", { fromAgent: peer("puck", "Puck") });
    const outboundHex = message("o1", { toAgent: peer("hex", "Hex") });
    const outboundBarok = message("o2", { toAgent: peer("barok", "Barok") });
    const inboundHex = message("i2", { fromAgent: peer("hex", "Hex") });

    assert.deepEqual(loaded.summarizeAgentComm([inbound]), {
      kind: "single",
      direction: "inbound",
      peer: peer("puck", "Puck"),
    });
    assert.deepEqual(loaded.summarizeAgentComm([outboundHex]), {
      kind: "single",
      direction: "outbound",
      peer: peer("hex", "Hex"),
    });
    assert.deepEqual(loaded.summarizeAgentComm([outboundHex, outboundBarok]), {
      kind: "fanout",
      peers: [peer("hex", "Hex"), peer("barok", "Barok")],
    });
    // Mixed directions → thread, peers deduped by id.
    assert.deepEqual(loaded.summarizeAgentComm([inbound, outboundHex, inboundHex, inbound]), {
      kind: "thread",
      messageCount: 4,
      peers: [peer("puck", "Puck"), peer("hex", "Hex")],
    });
    // Inbound multi is thread even when every hop shares one peer.
    assert.deepEqual(loaded.summarizeAgentComm([inbound, message("i3", { fromAgent: peer("puck", "Puck") })]), {
      kind: "thread",
      messageCount: 2,
      peers: [peer("puck", "Puck")],
    });
    // Two outbound hops to the same peer are not fanout (need ≥2 distinct peers).
    assert.deepEqual(loaded.summarizeAgentComm([outboundHex, message("o3", { toAgent: peer("hex", "Hex") })]), {
      kind: "thread",
      messageCount: 2,
      peers: [peer("hex", "Hex")],
    });
    assert.equal(loaded.summarizeAgentComm([]), null);
    assert.equal(loaded.summarizeAgentComm([message("plain")]), null);
  } finally {
    await cleanup();
  }
});

test("MYt: consecutive comm messages collapse; a non-comm entry breaks the group", async () => {
  const { loaded, cleanup } = await load(MODULE);
  try {
    const first = message("m1", { fromAgent: peer("puck", "Puck") });
    const second = message("m2", { toAgent: peer("hex", "Hex") });
    const ordinary = message("m3", { text: "hello" });
    const third = message("m4", { fromAgent: peer("barok", "Barok") });
    const notice = { kind: "notice", id: "n1", text: "break", timestampMs: 1 };

    const rows = loaded.groupAgentCommRows([first, second, ordinary, third]);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].kind, "agent-comm-group");
    assert.equal(rows[0].id, "m1:agent-comm");
    assert.equal(rows[0].entries.length, 2);
    assert.equal(rows[0].summary.kind, "thread");
    assert.equal(rows[1], ordinary);
    assert.equal(rows[2].kind, "agent-comm-group");
    assert.equal(rows[2].id, "m4:agent-comm");
    assert.deepEqual(rows[2].summary, {
      kind: "single",
      direction: "inbound",
      peer: peer("barok", "Barok"),
    });

    const broken = loaded.groupAgentCommRows([first, notice, second]);
    assert.equal(broken.length, 3);
    assert.equal(broken[0].id, "m1:agent-comm");
    assert.equal(broken[1], notice);
    assert.equal(broken[2].id, "m2:agent-comm");

    const fallthrough = loaded.groupAgentCommRows([message("plain"), ordinary]);
    assert.deepEqual(fallthrough, [message("plain"), ordinary]);
  } finally {
    await cleanup();
  }
});

test("sJt / gYt English strings including Bot/Bots and message/messages", async () => {
  const { loaded, cleanup } = await load(MODULE);
  try {
    const inbound = { kind: "single", direction: "inbound", peer: peer("puck", "Puck") };
    const outbound = { kind: "single", direction: "outbound", peer: peer("hex", "Hex") };
    const fanoutOne = { kind: "fanout", peers: [peer("hex", "Hex")] };
    const fanoutMany = { kind: "fanout", peers: [peer("hex", "Hex"), peer("barok", "Barok"), peer("puck", "Puck")] };
    const threadOne = { kind: "thread", messageCount: 1, peers: [peer("puck", "Puck")] };
    const threadMany = { kind: "thread", messageCount: 4, peers: [peer("puck", "Puck"), peer("hex", "Hex")] };

    assert.equal(loaded.agentCommVisibleLabel(inbound), "Message from");
    assert.equal(loaded.agentCommVisibleLabel(outbound), "Messaged");
    assert.equal(loaded.agentCommVisibleLabel(fanoutMany), "Messaged");
    assert.equal(loaded.agentCommVisibleLabel(threadMany), "4 messages with");
    assert.equal(loaded.agentCommVisibleLabel(threadOne), "1 messages with");

    assert.equal(loaded.agentCommAriaAuthor(inbound), "Message from Puck");
    assert.equal(loaded.agentCommAriaAuthor(outbound), "Messaged Hex");
    assert.equal(loaded.agentCommAriaAuthor(fanoutOne), "Messaged 1 Bot");
    assert.equal(loaded.agentCommAriaAuthor(fanoutMany), "Messaged 3 Bots");
    assert.equal(loaded.agentCommAriaAuthor(threadOne), "1 message with 1 Bot");
    assert.equal(loaded.agentCommAriaAuthor(threadMany), "4 messages with 2 Bots");

    assert.equal(loaded.agentCommBotsChipLabel(1), "1 Bot");
    assert.equal(loaded.agentCommBotsChipLabel(3), "3 Bots");
    assert.equal(loaded.agentCommBotsChipAria(1), "1 Bot, show list");
    assert.equal(loaded.agentCommBotsChipAria(3), "3 Bots, show list");
    assert.equal(loaded.AGENT_COMM_EXCHANGE_TITLE, "Bots in this exchange");
    assert.equal(loaded.agentCommOpenExchangeAria("Puck"), "Open exchange with Puck");
  } finally {
    await cleanup();
  }
});

test("the transcript collapses comm rows and does not treat this as a reply pill", async () => {
  const transcript = await readFile(
    path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/transcript.tsx"),
    "utf8",
  );
  const model = await readFile(
    path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/model.ts"),
    "utf8",
  );
  const view = await readFile(
    path.join(repoRoot, "frontend/src/recovered/features/conversation/system-event/sand-system-event.tsx"),
    "utf8",
  );
  assert.match(transcript, /groupAgentCommRows/);
  assert.match(transcript, /SandSystemEvent/);
  assert.match(transcript, /isAgentCommGroupRow/);
  assert.doesNotMatch(transcript, /from ["'].*reply-preview|<ComposerReplyPill/);
  assert.match(model, /fromAgent\?: \{ id: string; name: string \}/);
  assert.match(model, /toAgent\?: \{ id: string; name: string; kind\?: string \}/);
  assert.doesNotMatch(model, /kind: "agent-comm-group"/);
  assert.match(view, /onOpenAgentExchange\?/);
  assert.match(view, /AgentAvatar/);
  assert.match(view, /size="xs"/);
  assert.doesNotMatch(view, /from ["'].*reply-preview|<ComposerReplyPill/);
  assert.doesNotMatch(view, /\bSendGrokBotAgentMessage\b|\bRequestGrokBotRoomMemberTurn\b|\bCancelGrokBotRoomMemberTurn\b/);
});
