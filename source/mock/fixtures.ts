import { protoInt64 } from "@bufbuild/protobuf";
import {
  GrokBotAgent,
  GrokBotAgentClientState,
  GrokBotTranscriptEntry,
  GrokBotUserComputerHello,
  GrokBotUserComputerPresence,
} from "../packages/proto/generated/aiserver/v1/grok_bot_pb.js";
import {
  FIREFLY_AGENT_ID,
  GORK_AGENT_ID,
  HEXURIA_AGENT_ID,
  MOCK_ATTACHMENT_BYTES,
  MOCK_ATTACHMENT_PATH,
  MOCK_COMPUTER_MACHINE_ID,
  MOCK_TEACH_ATTACHMENT_BYTES,
  MOCK_TEACH_ATTACHMENT_PATH,
} from "./constants.js";

export interface LocalTranscriptBody extends Record<string, unknown> {
  id: string;
  kind: string;
}

const SEED_CREATED_AT_MS = 1_700_000_000_000;

export function encodeTranscriptBody(body: LocalTranscriptBody, seq: bigint): GrokBotTranscriptEntry {
  return new GrokBotTranscriptEntry({
    seq,
    entryKind: body.kind,
    body: new TextEncoder().encode(JSON.stringify(body)),
    updatedSeq: seq,
    entryId: body.id,
    bodyOmitted: false,
  });
}

export function seedAgents(nowMs = SEED_CREATED_AT_MS): GrokBotAgent[] {
  const created = protoInt64.parse(nowMs);
  return [
    new GrokBotAgent({
      id: HEXURIA_AGENT_ID,
      legacyAgentId: HEXURIA_AGENT_ID,
      agentId: HEXURIA_AGENT_ID,
      name: "Hexuria",
      title: "Hexuria",
      description: "Seeded reconstruction fixture.",
      avatarShape: "circle",
      avatarColor: "#c45c26",
      createdAtMs: created,
      updatedAtMs: created,
      harness: "box",
      role: "assistant",
    }),
    new GrokBotAgent({
      id: FIREFLY_AGENT_ID,
      legacyAgentId: FIREFLY_AGENT_ID,
      agentId: FIREFLY_AGENT_ID,
      name: "Firefly",
      title: "Firefly",
      description: "Peer bot used for agent-comm hops.",
      avatarShape: "circle",
      avatarColor: "#e8a317",
      createdAtMs: created,
      updatedAtMs: created,
      harness: "box",
      role: "assistant",
    }),
    new GrokBotAgent({
      id: GORK_AGENT_ID,
      legacyAgentId: GORK_AGENT_ID,
      agentId: GORK_AGENT_ID,
      name: "Gork",
      title: "Gork",
      description: "Third seeded bot.",
      avatarShape: "circle",
      avatarColor: "#5b8c5a",
      createdAtMs: created,
      updatedAtMs: created,
      harness: "box",
      role: "assistant",
    }),
  ];
}

export function seedHexuriaTranscriptBodies(): LocalTranscriptBody[] {
  return [
    {
      id: "hexuria-user-1",
      kind: "message",
      role: "user",
      content: "Ask Firefly if the mock server is up.",
      timestampMs: SEED_CREATED_AT_MS,
    },
    {
      id: "hexuria-hop-1",
      kind: "message",
      role: "assistant",
      content: "Checking with Firefly.",
      timestampMs: SEED_CREATED_AT_MS + 1,
      fromAgent: { id: HEXURIA_AGENT_ID, name: "Hexuria" },
      toAgent: { id: FIREFLY_AGENT_ID, name: "Firefly", kind: "agent" },
    },
    {
      id: "hexuria-assistant-1",
      kind: "message",
      role: "assistant",
      content: "Firefly says the mock is serving List/Watch/Commit locally.",
      timestampMs: SEED_CREATED_AT_MS + 2,
    },
    {
      id: "hexuria-notes-1",
      kind: "user-attachment",
      file_name: "notes.txt",
      file_path: MOCK_ATTACHMENT_PATH,
      timestampMs: SEED_CREATED_AT_MS + 3,
    },
  ];
}

export function seedHexuriaTranscriptEntries(): GrokBotTranscriptEntry[] {
  return seedHexuriaTranscriptBodies().map((body, index) => encodeTranscriptBody(body, protoInt64.parse(index + 1)));
}

export function seedClientState(agentId: string, nowMs = SEED_CREATED_AT_MS): GrokBotAgentClientState {
  return new GrokBotAgentClientState({
    agentId,
    unreadCount: 0,
    notificationsEnabled: true,
    notifyOnUpdatesEnabled: false,
    hiddenFromSidebar: false,
    updatedAtMs: protoInt64.parse(nowMs),
  });
}

export function seedUserComputer(nowMs = SEED_CREATED_AT_MS): GrokBotUserComputerPresence {
  return new GrokBotUserComputerPresence({
    machineId: MOCK_COMPUTER_MACHINE_ID,
    lastSeenAtMs: protoInt64.parse(nowMs),
    hello: new GrokBotUserComputerHello({
      label: "Mock laptop",
      localRoot: "/tmp/grok-bot-mock",
      terminalsFolder: "/tmp/grok-bot-mock/terminals",
      standing: "online",
      supervised: false,
      variant: "mock",
    }),
  });
}

export function seedAttachments(): Map<string, Uint8Array> {
  return new Map([
    [MOCK_ATTACHMENT_PATH, MOCK_ATTACHMENT_BYTES],
    [MOCK_TEACH_ATTACHMENT_PATH, MOCK_TEACH_ATTACHMENT_BYTES],
  ]);
}
