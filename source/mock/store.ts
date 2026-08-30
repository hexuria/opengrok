import { protoInt64 } from "@bufbuild/protobuf";
import { randomUUID } from "node:crypto";
import {
  GrokBotAgent,
  GrokBotAgentClientState,
  GrokBotAgentHarnessKind,
  GrokBotSendStatus,
  GrokBotTranscriptEntry,
  GrokBotTranscriptWatchFrame,
  GrokBotTranscriptWatchRows,
  GrokBotUserComputerPresence,
  type CreateGrokBotAgentRequest,
  type UpdateGrokBotAgentRequest,
} from "../packages/proto/generated/aiserver/v1/grok_bot_pb.js";
import { HEXURIA_AGENT_ID, MOCK_TEACH_ATTACHMENT_PATH } from "./constants.js";
import {
  encodeTranscriptBody,
  seedAgents,
  seedAttachments,
  seedClientState,
  seedHexuriaTranscriptEntries,
  seedUserComputer,
  type LocalTranscriptBody,
} from "./fixtures.js";

export interface StoredSendStatus {
  readonly agentId: string;
  readonly messageId: string;
  readonly status: GrokBotSendStatus;
  readonly echoEntryId: string;
  readonly acceptedAtMs: bigint;
}

export interface TranscriptPage {
  readonly entries: GrokBotTranscriptEntry[];
  readonly generation: number;
}

export interface MockTeachStatus {
  readonly status: "recording" | "idle";
  readonly recordingPath: typeof MOCK_TEACH_ATTACHMENT_PATH;
}

type WatchListener = (frame: GrokBotTranscriptWatchFrame) => void;

function nowMs(): number {
  return Date.now();
}

function asBigInt(value: bigint | string | number): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(value);
}

function nextSeq(entries: GrokBotTranscriptEntry[]): bigint {
  let max = 0n;
  for (const entry of entries) {
    const seq = asBigInt(entry.seq);
    if (seq > max) max = seq;
  }
  return max + 1n;
}

export class MockGrokBotStore {
  readonly agents = new Map<string, GrokBotAgent>();
  readonly transcripts = new Map<string, GrokBotTranscriptEntry[]>();
  readonly generations = new Map<string, number>();
  readonly clientState = new Map<string, GrokBotAgentClientState>();
  readonly sendStatus = new Map<string, StoredSendStatus>();
  readonly attachments = seedAttachments();
  computers: GrokBotUserComputerPresence[];
  teachRecording = false;
  private readonly watchers = new Set<WatchListener>();

  constructor() {
    for (const agent of seedAgents()) {
      this.agents.set(agent.id, agent);
      this.clientState.set(agent.id, seedClientState(agent.id));
      this.transcripts.set(agent.id, []);
      this.generations.set(agent.id, 1);
    }
    this.transcripts.set(HEXURIA_AGENT_ID, seedHexuriaTranscriptEntries());
    this.generations.set(HEXURIA_AGENT_ID, 1);
    this.computers = [seedUserComputer()];
  }

  subscribeWatch(listener: WatchListener): () => void {
    this.watchers.add(listener);
    return () => {
      this.watchers.delete(listener);
    };
  }

  private emit(frame: GrokBotTranscriptWatchFrame): void {
    for (const listener of this.watchers) listener(frame);
  }

  private emitRows(agentId: string, entries: GrokBotTranscriptEntry[], replay: boolean): void {
    this.emit(
      new GrokBotTranscriptWatchFrame({
        frame: {
          case: "rows",
          value: new GrokBotTranscriptWatchRows({
            agentId,
            generation: this.generations.get(agentId) ?? 1,
            entries,
            deletes: [],
            replay,
          }),
        },
      }),
    );
  }

  listAgents(role?: string): GrokBotAgent[] {
    const agents = [...this.agents.values()];
    if (role == null || role.length === 0) return agents;
    return agents.filter((agent) => agent.role === role);
  }

  createAgent(request: CreateGrokBotAgentRequest): GrokBotAgent {
    const id = request.agentId.length > 0 ? request.agentId : request.legacyAgentId.length > 0 ? request.legacyAgentId : `agent-${randomUUID()}`;
    const created = protoInt64.parse(nowMs());
    const harness = request.harness === GrokBotAgentHarnessKind.TEMPORAL ? "temporal" : "box";
    const agent = new GrokBotAgent({
      id,
      legacyAgentId: request.legacyAgentId.length > 0 ? request.legacyAgentId : id,
      agentId: id,
      name: request.name,
      title: request.title.length > 0 ? request.title : request.name,
      description: request.description,
      avatarShape: request.avatarShape,
      avatarColor: request.avatarColor,
      ...(request.avatarDataUrl != null && request.avatarDataUrl.length > 0
        ? { avatarUrl: request.avatarDataUrl }
        : {}),
      createdAtMs: created,
      updatedAtMs: created,
      harness,
      role: "assistant",
    });
    this.agents.set(id, agent);
    this.transcripts.set(id, this.transcripts.get(id) ?? []);
    this.generations.set(id, this.generations.get(id) ?? 1);
    this.clientState.set(id, this.clientState.get(id) ?? seedClientState(id));
    return agent;
  }

  updateAgent(request: UpdateGrokBotAgentRequest): GrokBotAgent | undefined {
    const current = this.agents.get(request.id);
    if (current == null) return undefined;
    const next = current.clone();
    if (request.name.length > 0) next.name = request.name;
    if (request.description.length > 0) next.description = request.description;
    if (request.title.length > 0) next.title = request.title;
    if (request.avatarShape.length > 0) next.avatarShape = request.avatarShape;
    if (request.avatarColor.length > 0) next.avatarColor = request.avatarColor;
    if (request.avatarChange.case === "avatarDataUrl") {
      next.avatarUrl = request.avatarChange.value;
    } else if (request.avatarChange.case === "clearAvatar") {
      delete next.avatarUrl;
    }
    next.updatedAtMs = protoInt64.parse(nowMs());
    this.agents.set(request.id, next);
    return next;
  }

  deleteAgent(id: string): boolean {
    const existed = this.agents.delete(id);
    this.transcripts.delete(id);
    this.generations.delete(id);
    this.clientState.delete(id);
    return existed;
  }

  listTranscript(agentId: string, options: { readonly limit?: number; readonly beforeSeq?: bigint } = {}): TranscriptPage {
    const all = this.transcripts.get(agentId) ?? [];
    const before = options.beforeSeq;
    const filtered = before == null ? all : all.filter((entry) => asBigInt(entry.seq) < before);
    const limit = options.limit != null && options.limit > 0 ? options.limit : filtered.length;
    return {
      entries: filtered.slice(Math.max(0, filtered.length - limit)),
      generation: this.generations.get(agentId) ?? 1,
    };
  }

  commit(
    agentId: string,
    entries: readonly GrokBotTranscriptEntry[],
    deletes: readonly { readonly entryId?: string }[],
  ): { committedCount: number; deletedCount: number } {
    const current = [...(this.transcripts.get(agentId) ?? [])];
    const byId = new Map(current.map((entry) => [entry.entryId ?? String(entry.seq), entry]));
    let deletedCount = 0;
    for (const del of deletes) {
      if (del.entryId == null || del.entryId.length === 0) continue;
      if (byId.delete(del.entryId)) deletedCount += 1;
    }
    const committed: GrokBotTranscriptEntry[] = [];
    for (const entry of entries) {
      const id = entry.entryId != null && entry.entryId.length > 0 ? entry.entryId : `entry-${randomUUID()}`;
      const seq = asBigInt(entry.seq) === 0n ? nextSeq([...byId.values(), ...committed]) : asBigInt(entry.seq);
      const stored = entry.clone();
      stored.entryId = id;
      stored.seq = protoInt64.parse(seq);
      stored.updatedSeq = protoInt64.parse(seq);
      byId.set(id, stored);
      committed.push(stored);
    }
    const next = [...byId.values()].sort((left, right) => {
      const delta = asBigInt(left.seq) - asBigInt(right.seq);
      return delta < 0n ? -1 : delta > 0n ? 1 : 0;
    });
    this.transcripts.set(agentId, next);
    this.generations.set(agentId, (this.generations.get(agentId) ?? 1) + 1);
    if (committed.length > 0 || deletedCount > 0) this.emitRows(agentId, committed, false);
    return { committedCount: committed.length, deletedCount };
  }

  appendBodies(agentId: string, bodies: readonly LocalTranscriptBody[]): GrokBotTranscriptEntry[] {
    const current = [...(this.transcripts.get(agentId) ?? [])];
    const added: GrokBotTranscriptEntry[] = [];
    for (const body of bodies) {
      const entry = encodeTranscriptBody(body, nextSeq([...current, ...added]));
      added.push(entry);
    }
    this.transcripts.set(agentId, [...current, ...added]);
    this.generations.set(agentId, (this.generations.get(agentId) ?? 1) + 1);
    this.emitRows(agentId, added, false);
    return added;
  }

  recordSend(status: StoredSendStatus): void {
    this.sendStatus.set(`${status.agentId}:${status.messageId}`, status);
  }

  getSend(agentId: string, messageId: string): StoredSendStatus | undefined {
    return this.sendStatus.get(`${agentId}:${messageId}`);
  }

  setClientState(
    agentId: string,
    patch: {
      readonly markRead?: boolean;
      readonly markUnread?: boolean;
      readonly notificationsEnabled?: boolean;
      readonly notifyOnUpdatesEnabled?: boolean;
      readonly hiddenFromSidebar?: boolean;
    },
  ): GrokBotAgentClientState {
    const current = this.clientState.get(agentId) ?? seedClientState(agentId);
    const next = current.clone();
    next.agentId = agentId;
    next.updatedAtMs = protoInt64.parse(nowMs());
    if (patch.markRead === true) next.unreadCount = 0;
    if (patch.markUnread === true) next.unreadCount = Math.max(1, next.unreadCount);
    if (patch.notificationsEnabled != null) next.notificationsEnabled = patch.notificationsEnabled;
    if (patch.notifyOnUpdatesEnabled != null) next.notifyOnUpdatesEnabled = patch.notifyOnUpdatesEnabled;
    if (patch.hiddenFromSidebar != null) next.hiddenFromSidebar = patch.hiddenFromSidebar;
    this.clientState.set(agentId, next);
    return next;
  }

  putAttachment(path: string, bytes: Uint8Array): void {
    this.attachments.set(path, bytes);
  }

  readAttachment(path: string, offset: bigint, length: number): { data: Uint8Array; totalSize: bigint } {
    const bytes = this.attachments.get(path) ?? new Uint8Array(0);
    const start = Number(offset);
    const end = length > 0 ? Math.min(bytes.byteLength, start + length) : bytes.byteLength;
    return {
      data: bytes.subarray(Math.max(0, start), Math.max(0, end)),
      totalSize: protoInt64.parse(bytes.byteLength),
    };
  }

  setTeachRecording(recording: boolean): MockTeachStatus {
    this.teachRecording = recording;
    return this.getTeachStatus();
  }

  getTeachStatus(): MockTeachStatus {
    return {
      status: this.teachRecording ? "recording" : "idle",
      recordingPath: MOCK_TEACH_ATTACHMENT_PATH,
    };
  }
}

export function createSeededMockStore(): MockGrokBotStore {
  return new MockGrokBotStore();
}
