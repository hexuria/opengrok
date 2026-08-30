import { z } from "zod";
import {
  AgentConversationTurn,
  ConversationState,
  ConversationStateStructure,
  ConversationStep,
  ConversationSummary,
  ConversationTurn,
  ConversationTurnStructure,
  ShellCommand,
  ShellConversationTurn,
  ShellOutput,
  UserMessage,
  type ConversationState as ConversationStateMessage,
  type ConversationStateStructure as ConversationStateStructureMessage,
  type SubagentPersistedState as SubagentPersistedStateMessage,
} from "../proto/generated/agent/v1/agent_pb.js";
import { TodoItem } from "../proto/generated/agent/v1/todo_tool_pb.js";
import { Disposable } from "../utils/disposable.js";
import type { BlobStore } from "./blob-store.js";
import { getBlobId } from "./blob-store.js";
import { ProtoSerde, fromHex, toHex, utf8Serde } from "./serde.js";
import { resolveSubagentPersistedStates } from "./subagent-states.js";

export const AgentModes = ["default", "plan", "debug", "search"] as const;
export const ApprovalModeSettings = ["allowlist", "unrestricted", "auto-review"] as const;
export type AgentMode = (typeof AgentModes)[number];
export type ApprovalModeSetting = (typeof ApprovalModeSettings)[number];

const BLOB_ENCRYPTION_KEY_LENGTH_BYTES = 32;
const BLOB_ENCRYPTION_KEY_HEX_PATTERN = /^[0-9a-f]+$/;

export interface AgentSubagentInfo {
  parentAgentId: string;
  rootParentAgentId: string;
  toolCallId: string;
  typeName: string;
}

export interface AgentMetadata {
  agentId: string;
  latestRootBlobId: Uint8Array;
  name: string;
  mode: AgentMode;
  isRunEverything: boolean;
  approvalMode?: ApprovalModeSetting | undefined;
  createdAt: number;
  lastUsedModel?: string | undefined;
  lastDebugServerPort?: number | undefined;
  currentPlanUri?: string | undefined;
  subagentInfo?: AgentSubagentInfo | undefined;
  blobEncryptionKey?: string | undefined;
}

export type AgentMetadataKey = keyof AgentMetadata;

export interface AgentMetadataStore {
  subscribe(key: AgentMetadataKey, callback: () => void): () => void;
  set<Key extends AgentMetadataKey>(key: Key, value: AgentMetadata[Key]): unknown;
  get<Key extends AgentMetadataKey>(key: Key): AgentMetadata[Key];
}

export function generateBlobEncryptionKeyHex(): string {
  const bytes = new Uint8Array(BLOB_ENCRYPTION_KEY_LENGTH_BYTES);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export function isValidBlobEncryptionKeyHex(value: unknown): value is string {
  return typeof value === "string"
    && value.length === BLOB_ENCRYPTION_KEY_LENGTH_BYTES * 2
    && BLOB_ENCRYPTION_KEY_HEX_PATTERN.test(value);
}

let agentMetadataSchema: z.ZodType<AgentMetadata> | null = null;
export function getAgentMetadataSchema(): z.ZodType<AgentMetadata> {
  agentMetadataSchema ??= z.object({
    agentId: z.string(),
    latestRootBlobId: z.custom<Uint8Array>((value) => value instanceof Uint8Array, {
      message: "Expected Uint8Array",
    }),
    name: z.string(),
    createdAt: z.number(),
    mode: z.enum(AgentModes),
    isRunEverything: z.boolean(),
    approvalMode: z.enum(ApprovalModeSettings).optional(),
    lastUsedModel: z.string().optional(),
    lastDebugServerPort: z.number().int().positive().optional(),
    currentPlanUri: z.string().optional(),
    subagentInfo: z.union([
      z.object({
        parentAgentId: z.string().min(1),
        rootParentAgentId: z.string().min(1),
        toolCallId: z.string().min(1),
        typeName: z.string().min(1),
      }),
      z.undefined(),
    ]),
    blobEncryptionKey: z.string().optional(),
  });
  return agentMetadataSchema;
}

export function getDefaultAgentMetadata(agentId?: string | null): AgentMetadata {
  return {
    agentId: agentId ?? crypto.randomUUID(),
    latestRootBlobId: new Uint8Array(),
    name: "New Agent",
    mode: "default",
    isRunEverything: false,
    approvalMode: undefined,
    createdAt: Date.now(),
    lastUsedModel: undefined,
    lastDebugServerPort: undefined,
    currentPlanUri: undefined,
    subagentInfo: undefined,
    blobEncryptionKey: generateBlobEncryptionKeyHex(),
  };
}

const agentModeSet = new Set<string>(AgentModes);
const approvalModeSettingSet = new Set<string>(ApprovalModeSettings);

function parseAgentSubagentInfo(value: unknown): AgentSubagentInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<AgentSubagentInfo>;
  if (
    typeof candidate.parentAgentId !== "string" || candidate.parentAgentId.length === 0
    || typeof candidate.rootParentAgentId !== "string" || candidate.rootParentAgentId.length === 0
    || typeof candidate.toolCallId !== "string" || candidate.toolCallId.length === 0
    || typeof candidate.typeName !== "string" || candidate.typeName.length === 0
  ) return undefined;
  return {
    parentAgentId: candidate.parentAgentId,
    rootParentAgentId: candidate.rootParentAgentId,
    toolCallId: candidate.toolCallId,
    typeName: candidate.typeName,
  };
}

export class AgentMetadataSerde {
  serialize(value: AgentMetadata): Uint8Array {
    return utf8Serde.serialize(JSON.stringify({
      ...value,
      latestRootBlobId: toHex(value.latestRootBlobId),
    }));
  }

  deserialize(blob: Uint8Array): AgentMetadata {
    const json = JSON.parse(utf8Serde.deserialize(blob)) as Record<string, unknown>;
    const defaults = getDefaultAgentMetadata(typeof json.agentId === "string" ? json.agentId : undefined);
    const latestRootBlobId = typeof json.latestRootBlobId === "string"
      ? fromHex(json.latestRootBlobId)
      : defaults.latestRootBlobId;
    let isRunEverything = json.isRunEverything === true;
    let rawMode = json.mode;
    if (rawMode === "auto-run") {
      rawMode = "default";
      isRunEverything = true;
    }
    const mode = typeof rawMode === "string" && agentModeSet.has(rawMode)
      ? rawMode as AgentMode
      : "default";
    const rawApprovalMode = json.approvalMode;
    const approvalMode = typeof rawApprovalMode === "string" && approvalModeSettingSet.has(rawApprovalMode)
      ? rawApprovalMode as ApprovalModeSetting
      : undefined;
    return getAgentMetadataSchema().parse({
      ...defaults,
      ...json,
      mode,
      isRunEverything,
      approvalMode,
      latestRootBlobId,
      subagentInfo: parseAgentSubagentInfo(json.subagentInfo),
      blobEncryptionKey: isValidBlobEncryptionKeyHex(json.blobEncryptionKey)
        ? json.blobEncryptionKey
        : defaults.blobEncryptionKey,
    });
  }

  getBlobType(): { kind: "json" } {
    return { kind: "json" };
  }
}

const todoItemSerde = new ProtoSerde(TodoItem);
const userMessageSerde = new ProtoSerde(UserMessage);
const conversationStepSerde = new ProtoSerde(ConversationStep);
const conversationTurnStructureSerde = new ProtoSerde(ConversationTurnStructure);
const conversationSummarySerde = new ProtoSerde(ConversationSummary);
const shellCommandSerde = new ProtoSerde(ShellCommand);
const shellOutputSerde = new ProtoSerde(ShellOutput);

export async function deriveConversationStateFromStructure<Context>(
  ctx: Context,
  structure: ConversationStateStructureMessage,
  blobStore: Pick<BlobStore<Context>, "getBlob">,
): Promise<ConversationStateMessage> {
  const state = new ConversationState();
  const turns: InstanceType<typeof ConversationTurn>[] = [];
  for (const turnBlobId of structure.turns) {
    const turnBlob = await blobStore.getBlob(ctx, turnBlobId);
    if (!turnBlob) continue;
    const turnStructure = conversationTurnStructureSerde.deserialize(turnBlob);
    let conversationTurn: InstanceType<typeof ConversationTurn> | undefined;
    if (turnStructure.turn.case === "agentConversationTurn") {
      const agentTurnStructure = turnStructure.turn.value;
      const userMessageBlob = await blobStore.getBlob(ctx, agentTurnStructure.userMessage);
      if (!userMessageBlob) continue;
      const steps: InstanceType<typeof ConversationStep>[] = [];
      for (const stepBlobId of agentTurnStructure.steps) {
        const stepBlob = await blobStore.getBlob(ctx, stepBlobId);
        if (stepBlob) steps.push(conversationStepSerde.deserialize(stepBlob));
      }
      conversationTurn = new ConversationTurn({
        turn: {
          case: "agentConversationTurn",
          value: new AgentConversationTurn({
            userMessage: userMessageSerde.deserialize(userMessageBlob),
            steps,
          }),
        },
      });
    } else if (turnStructure.turn.case === "shellConversationTurn") {
      const shellTurnStructure = turnStructure.turn.value;
      const shellCommandBlob = await blobStore.getBlob(ctx, shellTurnStructure.shellCommand);
      if (!shellCommandBlob) continue;
      const shellOutputBlob = await blobStore.getBlob(ctx, shellTurnStructure.shellOutput);
      if (!shellOutputBlob) continue;
      conversationTurn = new ConversationTurn({
        turn: {
          case: "shellConversationTurn",
          value: new ShellConversationTurn({
            shellCommand: shellCommandSerde.deserialize(shellCommandBlob),
            shellOutput: shellOutputSerde.deserialize(shellOutputBlob),
          }),
        },
      });
    }
    if (conversationTurn) turns.push(conversationTurn);
  }
  state.turns = turns;

  const todos: InstanceType<typeof TodoItem>[] = [];
  for (const todoBlobId of structure.todos) {
    const todoBlob = await blobStore.getBlob(ctx, todoBlobId);
    if (todoBlob) todos.push(todoItemSerde.deserialize(todoBlob));
  }
  state.todos = todos;
  if (structure.summary) {
    const summaryBlob = await blobStore.getBlob(ctx, structure.summary);
    if (summaryBlob) state.summary = conversationSummarySerde.deserialize(summaryBlob);
  }
  return state;
}

export class AgentStore2<Context = unknown> {
  private readonly serde = new ProtoSerde(ConversationStateStructure);
  private conversationStateStructure = new ConversationStateStructure();
  private readonly fixedRootBlobId: Uint8Array | undefined;

  constructor(
    private readonly blobStore: BlobStore<Context>,
    private readonly metadataStore: AgentMetadataStore,
    options: { fixedRootBlobId?: Uint8Array } = {},
  ) {
    this.fixedRootBlobId = options.fixedRootBlobId;
  }

  subscribeToMetadata<Key extends AgentMetadataKey>(
    key: Key,
    callback: (value: AgentMetadata[Key]) => void,
  ): () => void {
    return this.metadataStore.subscribe(key, () => callback(this.metadataStore.get(key)));
  }

  setMetadata<Key extends AgentMetadataKey>(key: Key, value: AgentMetadata[Key]): void {
    this.metadataStore.set(key, value);
  }

  getMetadata<Key extends AgentMetadataKey>(key: Key): AgentMetadata[Key] {
    return this.metadataStore.get(key);
  }

  getId(): string { return this.getMetadata("agentId"); }
  getBlobStore(): BlobStore<Context> { return this.blobStore; }
  getConversationStateStructure(): ConversationStateStructureMessage { return this.conversationStateStructure; }

  async getLastRequestIdFromConversation(ctx: Context): Promise<string | null> {
    const turns = this.conversationStateStructure.turns;
    if (turns.length === 0) return null;
    for (let index = turns.length - 1; index >= 0; index--) {
      const turnBlob = await this.blobStore.getBlob(ctx, turns[index]!);
      if (!turnBlob) continue;
      const turnStructure = conversationTurnStructureSerde.deserialize(turnBlob);
      if (turnStructure.turn.case === "agentConversationTurn") {
        return turnStructure.turn.value.requestId ?? null;
      }
    }
    return null;
  }

  async getFullConversation(ctx: Context): Promise<ConversationStateMessage> {
    return this.deserializeConversationStateStructure(ctx, this.conversationStateStructure);
  }

  async deserializeConversationStateStructure(
    ctx: Context,
    structure: ConversationStateStructureMessage,
  ): Promise<ConversationStateMessage> {
    return deriveConversationStateFromStructure(ctx, structure, this.blobStore);
  }

  async getFullConversationWithSubagents(ctx: Context): Promise<{
    conversationState: ConversationStateMessage;
    subagentStates: Record<string, {
      conversationState: ConversationStateMessage;
      createdTimestampMs: SubagentPersistedStateMessage["createdTimestampMs"];
      lastUsedTimestampMs: SubagentPersistedStateMessage["lastUsedTimestampMs"];
      subagentType: SubagentPersistedStateMessage["subagentType"];
    }>;
  }> {
    const structure = this.conversationStateStructure;
    const conversationState = await this.deserializeConversationStateStructure(ctx, structure);
    const subagentStates: Record<string, {
      conversationState: ConversationStateMessage;
      createdTimestampMs: SubagentPersistedStateMessage["createdTimestampMs"];
      lastUsedTimestampMs: SubagentPersistedStateMessage["lastUsedTimestampMs"];
      subagentType: SubagentPersistedStateMessage["subagentType"];
    }> = {};
    const persisted = await resolveSubagentPersistedStates(ctx, structure, this.blobStore);
    for (const [agentId, state] of Object.entries(persisted)) {
      if (state.conversationState) {
        subagentStates[agentId] = {
          conversationState: await this.deserializeConversationStateStructure(ctx, state.conversationState),
          createdTimestampMs: state.createdTimestampMs,
          lastUsedTimestampMs: state.lastUsedTimestampMs,
          subagentType: state.subagentType,
        };
      }
    }
    return { conversationState, subagentStates };
  }

  getLatestCheckpoint(): ConversationStateStructureMessage {
    return this.getConversationStateStructure();
  }

  async handleCheckpoint(ctx: Context, checkpoint: ConversationStateStructureMessage): Promise<void> {
    this.conversationStateStructure = checkpoint;
    const bytes = this.serde.serialize(checkpoint);
    const blobId = this.fixedRootBlobId ?? await getBlobId(bytes);
    await this.blobStore.setBlob(ctx, blobId, bytes);
    this.setMetadata("latestRootBlobId", blobId);
  }

  async resetFromDb(ctx: Context): Promise<void> {
    await this.tryResetFromDb(ctx);
  }

  async tryResetFromDb(ctx: Context): Promise<boolean> {
    try {
      const rootBlobId = this.getMetadata("latestRootBlobId");
      if (!rootBlobId || rootBlobId.length === 0) {
        this.conversationStateStructure = new ConversationStateStructure();
        return false;
      }
      const bytes = await this.blobStore.getBlob(ctx, rootBlobId);
      if (!bytes) {
        this.conversationStateStructure = new ConversationStateStructure();
        return false;
      }
      this.conversationStateStructure = this.serde.deserialize(bytes);
      return true;
    } catch {
      this.conversationStateStructure = new ConversationStateStructure();
      return false;
    }
  }

  async dispose(): Promise<void> {
    if (this.blobStore instanceof Disposable) {
      await (this.blobStore as unknown as Disposable & { dispose(): void | Promise<void> }).dispose();
    }
  }
}
