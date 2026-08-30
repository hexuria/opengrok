import { pathToFileURL } from "node:url";
import { getBlobId, isBlobDurable, type BlobStore } from "../agent-kv/blob-store.js";
import { BlobNotFoundError } from "../agent-kv/blob-not-found-error.js";
import { ProtoSerde, toHex, utf8Serde, type Serde } from "../agent-kv/serde.js";
import { EagerReference, LazyReference, Writeable } from "../agent-kv/reference.js";
import { getBlobMetadataCallback } from "../agent-kv/typed-blob-store.js";
import { conversationStateStructureSerde, createRedactedCoreMessageSerde, createRedactedProtoSerde } from "./serde.js";
import {
  AgentConversationTurnStructure,
  AgentMode,
  AssistantMessage,
  BackgroundTaskCompletion,
  BackgroundTaskCompletionReason,
  BackgroundTaskKind,
  BackgroundTaskStatus,
  ConversationStep,
  ConversationPlan,
  ConversationSummary,
  ConversationSummaryArchive,
  ConversationStateStructure,
  ConversationTurnStructure,
  CommunicateUpdateHistoryEntry,
  CommunicateUpdateTurnState,
  ConversationTokenDetails,
  FileStateStructure,
  GoalState,
  PlanRegistryEntry,
  ShellCommand,
  ShellOutput,
  ShellConversationTurnStructure,
  SimulatedMsgReason,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
  SubagentRunState,
  SubagentRunStatus,
  ThinkingMessage,
  UserMessage,
} from "../proto/generated/agent/v1/agent_pb.js";
import { SelectedContext } from "../proto/generated/agent/v1/selected_context_pb.js";
import { TodoItem } from "../proto/generated/agent/v1/todo_tool_pb.js";
import {
  fromRedactedConversationPlan,
  fromRedactedConversationStep,
  fromRedactedConversationSummary,
  fromRedactedConversationSummaryArchive,
  fromRedactedConversationStateStructure,
  fromRedactedConversationTokenDetails,
  createRedactedConversationTokenDetails,
  fromRedactedCommunicateUpdateHistoryEntry,
  fromRedactedCommunicateUpdateTurnState,
  fromRedactedGoalState,
  fromRedactedPlanRegistryEntry,
  fromRedactedSubagentRunState,
  fromRedactedShellCommand,
  fromRedactedShellOutput,
  fromRedactedSubagentPersistedState,
  fromRedactedUserMessage,
  toRedactedConversationPlan,
  toRedactedConversationStep,
  toRedactedConversationSummary,
  toRedactedConversationSummaryArchive,
  toRedactedConversationStateStructure,
  toRedactedShellCommand,
  toRedactedShellOutput,
  toRedactedSubagentPersistedState,
  toRedactedUserMessage,
} from "../redacted-protos/generated/agent/v1/agent_redacted.js";
import { fromRedactedTodoItem, toRedactedTodoItem } from "../redacted-protos/generated/agent/v1/todo_tool_redacted.js";
import { DataClassification, PrivacyCapability } from "../redaction/classification.js";
import { createRedactedString } from "../redaction/factory.js";
import { fromRedactedCoreMessage, toRedactedCoreMessage } from "../redaction/core-message.js";
import { PrivacyMode as PrivacyModes, type PrivacyMode } from "../redaction/privacy-mode.js";
import type { Context as OperationContext } from "../context/core.js";
import { createLogger } from "../context/logger.js";
import { createSpan, withSuppressedChildSpans } from "../context/otel.js";
import { recordCompletedSpanIfParented } from "../context/otel.js";
import type { SubagentType } from "../proto/generated/agent/v1/subagents_pb.js";
import type { GitRepoInfo, RequestContext } from "../proto/generated/agent/v1/request_context_exec_pb.js";
import { isEqual } from "./common.js";
import { createCounter, createHistogram } from "../metrics/index.js";
import { asyncMapValues } from "../utils/promise-extras.js";
import { isCursorBigModel } from "../utils/model-utils.js";
import { parseAgentType } from "./state-agent-type.js";
import { computeCoreMessageImagePresence } from "./conversation-image-presence.js";
import {
  joinUserTurnSystemReminders,
  processAntiAskQuestionSystemReminder,
  processModeSystemReminder,
  processWorkspaceChangeReminder,
  resolveCurrentTurnMode,
  type ModeProcessingConfig,
  type ModeProcessingRequestContext,
} from "./mode-processing.js";
import {
  formatProjectPrompt,
  formatProjectSideChatPrompt,
  formatProjectSubagentPrompt,
  formatProjectThreadPrompt,
  normalizeProjectName,
} from "./prompts/project-prompt.js";
import { isProjectSendMessageEnabled } from "../constants/project-send-message.js";
import { getConversationId, getRequestId } from "./utils/request-id.js";
import { getSubagentTypeName } from "./tools/core/subagent/subagent-config.js";
import { escapePromptXmlText } from "./utils/prompt-xml-escape.js";
import { persistPromptContextUsageSnapshot } from "./utils/prompt-context-usage-snapshot.js";
import { isNotificationOnlyUserMessage } from "./actions/user-message-action/synthetic-user-message.js";
import { createPromptReferenceId, parseLeadingUserMessageIdTag, renderUserMessageIdTag } from "./tools/prompt-reference-contract.js";
import { renderHookAdditionalContextSystemReminder } from "../hooks-carriers/hook-additional-context-render.js";
import { processSelectedContext } from "./context-processing.js";

// Intentionally partial recovery of ../packages/agent/dist/state.js.
// Recovered public exports are limited to proven leaf helpers and bounded
// turn/state-handle slices. Broader orchestration and all other state methods
// remain deliberately absent and uncomposed. The
// recovered tracking and serde helpers are private implementation details.

const _logger3 = createLogger("@anysphere/agent:state");
const textDecoder2 = new TextDecoder();

const conversationStateRestoreDurationMs = createHistogram("agent.conversation_state.restore.duration_ms", {
  description: "Wall time for fromConversationStateStructure (KV blob loads + handle setup).",
  labelNames: ["crossed_large_threshold"],
});
const conversationStateRestoreRootPromptMessageCount = createHistogram("agent.conversation_state.restore.root_prompt_message_count", {
  description: "Count of root prompt message blobs loaded (one getBlob per persisted message).",
  labelNames: ["crossed_large_threshold"],
});
const conversationStateRestoreTurnReferenceCount = createHistogram("agent.conversation_state.restore.turn_reference_count", {
  description: "Count of lazy turn references in persisted state (not materialized here).",
  labelNames: ["crossed_large_threshold"],
});
const conversationStateRestoreFileStatePathCount = createHistogram("agent.conversation_state.restore.file_state_path_count", {
  description: "Number of paths in file_states_v2.",
  labelNames: ["crossed_large_threshold"],
});
const conversationStateRestoreTotalBytes = createHistogram("agent.conversation_state.restore.total_restored_bytes", {
  description: "Bytes eagerly loaded during restore (root prompt blobs).",
  labelNames: ["crossed_large_threshold"],
});
const conversationStateRestorePhaseMs = createHistogram("agent.conversation_state.restore.phase_ms", {
  description: "Wall time for each phase of fromConversationStateStructure (root prompt blob loads, file-state wiring, subagent state refs, other setup). Sum ≈ restore.duration_ms.",
  labelNames: ["phase", "crossed_large_threshold"],
});
const conversationStateRestoreBlobFetchConcurrency = createHistogram("agent.conversation_state.restore.blob_fetch_concurrency", {
  description: "Effective max concurrent blob reads for this restore (agent_state_restore_config.blob_fetch_concurrency after schema validation; the 32 fallback means the console value was absent or failed to parse).",
});
const conversationStateComputeRootPromptMode = createCounter("agent.conversation_state.compute.root_prompt_mode", {
  description: "Counts whether computeNewStructure rebuilt root prompt blobs or reused a persisted prefix.",
  labelNames: ["mode"],
});

const SERIALIZE_MESSAGE_SLOW_THRESHOLD_MS = 1;
const LARGE_RESTORE_TOTAL_BYTES = 2 * 1024 * 1024;
const LARGE_RESTORE_IMAGE_BYTES = 512 * 1024;
const SLOW_RESTORE_DURATION_MS = 200;
const RESTORE_BLOB_FETCH_CONCURRENCY = 32;

type ConversationStateRestoreMetricValues = {
  context: OperationContext;
  restoreDurationMs: number;
  rootPromptPhaseMs: number;
  fileStatesPhaseMs: number;
  subagentStateRefsPhaseMs: number;
  rootPromptMessageCount: number;
  turnReferenceCount: number;
  fileStatePathCount: number;
  rootPromptBytes: number;
  restoreBlobFetchConcurrency: number;
  crossedLargeThreshold: boolean;
};

function recordConversationStateRestoreMetrics({
  context,
  restoreDurationMs,
  rootPromptPhaseMs,
  fileStatesPhaseMs,
  subagentStateRefsPhaseMs,
  rootPromptMessageCount,
  turnReferenceCount,
  fileStatePathCount,
  rootPromptBytes,
  restoreBlobFetchConcurrency,
  crossedLargeThreshold,
}: ConversationStateRestoreMetricValues): void {
  const largeLabel = {
    crossed_large_threshold: crossedLargeThreshold ? "true" : "false",
  };
  const namedPhasesMs = rootPromptPhaseMs + fileStatesPhaseMs + subagentStateRefsPhaseMs;
  const otherPhaseMs = Math.max(0, restoreDurationMs - namedPhasesMs);
  conversationStateRestorePhaseMs.histogram(context, rootPromptPhaseMs, {
    phase: "root_prompt_messages",
    ...largeLabel,
  });
  conversationStateRestorePhaseMs.histogram(context, fileStatesPhaseMs, {
    phase: "file_states",
    ...largeLabel,
  });
  conversationStateRestorePhaseMs.histogram(context, subagentStateRefsPhaseMs, { phase: "subagent_state_refs", ...largeLabel });
  conversationStateRestorePhaseMs.histogram(context, otherPhaseMs, {
    phase: "other",
    ...largeLabel,
  });
  conversationStateRestoreDurationMs.histogram(context, restoreDurationMs, largeLabel);
  conversationStateRestoreBlobFetchConcurrency.histogram(context, restoreBlobFetchConcurrency);
  conversationStateRestoreRootPromptMessageCount.histogram(context, rootPromptMessageCount, largeLabel);
  conversationStateRestoreTurnReferenceCount.histogram(context, turnReferenceCount, largeLabel);
  conversationStateRestoreFileStatePathCount.histogram(context, fileStatePathCount, largeLabel);
  conversationStateRestoreTotalBytes.histogram(context, rootPromptBytes, largeLabel);
}

function estimatePayloadBytes(payload: unknown): number {
  if (typeof payload === "string") {
    return Buffer.byteLength(payload, "utf8");
  }
  if (payload instanceof Uint8Array) {
    return payload.byteLength;
  }
  if (payload instanceof ArrayBuffer) {
    return payload.byteLength;
  }
  if (payload instanceof URL) {
    return Buffer.byteLength(payload.toString(), "utf8");
  }
  return 0;
}

function getCoreMessageImagePayloadStats(message: { content?: unknown }): { imageBytes: number; imagePartCount: number } {
  const stats = { imageBytes: 0, imagePartCount: 0 };
  if (!Array.isArray(message.content)) {
    return stats;
  }
  for (const part of message.content) {
    if (part !== null && typeof part === "object" && "type" in part && part.type === "image") {
      const image = "image" in part ? part.image : undefined;
      const data = "data" in part ? part.data : undefined;
      stats.imagePartCount++;
      stats.imageBytes += estimatePayloadBytes(image ?? data);
    }
  }
  return stats;
}

function isValidTimeZone(timeZone?: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function resolveConversationStartTimeZone(timeZone?: string): string {
  if (timeZone && isValidTimeZone(timeZone)) {
    return timeZone;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function buildDateStringForTimestampMs(timestampMs: bigint, timeZone?: string): string {
  const timestamp = new Date(Number(timestampMs));
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: isValidTimeZone(timeZone) ? timeZone : "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(timestamp);
  const partLookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type === "literal") {
      continue;
    }
    partLookup[part.type] = part.value;
  }
  const year = partLookup.year;
  const month = partLookup.month;
  const day = partLookup.day;
  if (!year || !month || !day) {
    throw new Error(`Failed to build local date for timestamp ${timestampMs.toString()} in timezone ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}

type SerializedBlobCacheEntry = {
  readonly blobId: Uint8Array;
  readonly blobData: Uint8Array;
};

const serializedMessageCache = new WeakMap<object, SerializedBlobCacheEntry>();
const coreToRedactedMap = new WeakMap<object, object>();
const serializedSubagentStateCache = new WeakMap<object, SerializedBlobCacheEntry>();

type DisposableValue = {
  [Symbol.dispose]?: (this: DisposableValue) => void;
  [Symbol.asyncDispose]?: (this: DisposableValue) => void | Promise<void>;
};

type DisposableResource = {
  value?: DisposableValue;
  dispose?: (this: DisposableValue) => void | Promise<void>;
  async?: boolean;
};

type DisposableEnvironment = {
  stack: DisposableResource[];
  error: unknown;
  hasError: boolean;
};

function isDisposableValue(value: unknown): value is DisposableValue {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function __addDisposableResource19(env: DisposableEnvironment, value: unknown, async: boolean): unknown {
  if (value !== null && value !== undefined) {
    if (!isDisposableValue(value)) throw new TypeError("Object expected.");
    const disposableValue = value;
    let dispose = async ? disposableValue[Symbol.asyncDispose] : undefined;
    let inner: ((this: DisposableValue) => void | Promise<void>) | undefined;
    if (dispose === undefined) {
      if (Symbol.dispose === undefined) throw new TypeError("Symbol.dispose is not defined.");
      dispose = disposableValue[Symbol.dispose];
      if (async) inner = dispose;
    }
    if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
    if (inner !== undefined) {
      dispose = function () {
        try {
          inner!.call(this);
        } catch (error) {
          return Promise.reject(error);
        }
      };
    }
    env.stack.push({ value: disposableValue, dispose, async });
  } else if (async) {
    env.stack.push({ async: true });
  }
  return value;
}

function __disposeResources19(env: DisposableEnvironment): Promise<void> | void {
  const SuppressedErrorConstructor = typeof SuppressedError === "function"
    ? SuppressedError
    : class extends Error {
      readonly error: unknown;
      readonly suppressed: unknown;
      constructor(error: unknown, suppressed: unknown, message: string) {
        super(message);
        this.name = "SuppressedError";
        this.error = error;
        this.suppressed = suppressed;
      }
    };
  const fail = (error: unknown): void => {
    env.error = env.hasError
      ? new SuppressedErrorConstructor(error, env.error, "An error was suppressed during disposal.")
      : error;
    env.hasError = true;
  };
  let asyncState = 0;
  const next = (): Promise<void> | void => {
    let resource: DisposableResource | undefined;
    while ((resource = env.stack.pop()) !== undefined) {
      try {
        if (!resource.async && asyncState === 1) {
          asyncState = 0;
          env.stack.push(resource);
          return Promise.resolve().then(next).then(() => undefined);
        }
        if (resource.dispose !== undefined) {
          const result = resource.dispose.call(resource.value!);
          if (resource.async) {
            asyncState |= 2;
            return Promise.resolve(result).then(next, error => {
              fail(error);
              return next();
            }).then(() => undefined);
          }
        } else {
          asyncState |= 1;
        }
      } catch (error) {
        fail(error);
      }
    }
    if (asyncState === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
    if (env.hasError) throw env.error;
  };
  return next();
}

function hasInvalidXmlTextCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      return true;
    }
  }
  return false;
}

export function renderIncomingMessageIdTag(messageId?: string): string | undefined {
  const normalizedMessageId = messageId?.trim();
  if (
    normalizedMessageId === undefined ||
    normalizedMessageId.length === 0 ||
    hasInvalidXmlTextCharacter(normalizedMessageId)
  ) {
    return undefined;
  }
  return `<incoming_message_id>${escapePromptXmlText(normalizedMessageId)}</incoming_message_id>`;
}

function shouldExposeIncomingMessageId(userMessage: {
  readonly isSimulatedMsg: boolean;
  readonly simulatedMsgReason: SimulatedMsgReason;
  readonly text: string;
}): boolean {
  if (userMessage.isSimulatedMsg !== true) return true;
  if (userMessage.simulatedMsgReason !== SimulatedMsgReason.SUBSCRIPTION) return false;
  return isNotificationOnlyUserMessage({ role: "user", content: userMessage.text });
}

function buildDynamicToolsEnabledReminder(toolNames: {
  readonly discoveryToolName: string;
  readonly invocationToolName: string;
}): string {
  const { discoveryToolName, invocationToolName } = toolNames;
  return `<system_reminder>
Dynamic tools have been enabled for this conversation. Some tools that appeared as direct tool calls in earlier turns must now be called through ${invocationToolName}. Discover tool schemas with ${discoveryToolName}.
</system_reminder>`;
}

async function getPreviousAgentConversationTurn(
  ctx: OperationContext,
  turns: readonly { get(ctx: OperationContext): Promise<unknown> }[],
): Promise<AgentConversationTurnHandle | undefined> {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turnHandle = await turns[i]!.get(ctx);
    if (turnHandle instanceof AgentConversationTurnHandle) return turnHandle;
  }
  return undefined;
}

async function getPreviousRecordedDynamicToolCount(
  ctx: OperationContext,
  turns: readonly { get(ctx: OperationContext): Promise<unknown> }[],
): Promise<number | undefined> {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turnHandle = await turns[i]!.get(ctx);
    if (!(turnHandle instanceof AgentConversationTurnHandle)) continue;
    const count = turnHandle.getInnerStructure().dynamicToolCount;
    if (count !== undefined) return count;
  }
  return undefined;
}

function decryptTurnModelMcid(
  turnHandle: AgentConversationTurnHandle,
  decryptMcidAndParams: ((encrypted: string) => string | undefined) | undefined,
): string | undefined {
  if (decryptMcidAndParams === undefined) return undefined;
  const encrypted = turnHandle.getInnerStructure().encryptedModel;
  if (encrypted === undefined || encrypted.length === 0) return undefined;
  try {
    return decryptMcidAndParams(encrypted);
  } catch {
    return undefined;
  }
}

const MODEL_SWITCH_REMINDER = `<system_reminder>
Earlier turns were produced by a different AI model. It may have called tools that are no longer available to you. Call only the tools currently defined for you, using your current schemas, and follow your own response style rather than imitating the prior model's behavior.
</system_reminder>`;

const stateSnapshotDuration = createHistogram("agent.ttft.createTurn.stateSnapshotMs", {
  description: "Time for computeNewStructure + serialize + getBlobId at the start of createAgentTurn",
  labelNames: ["overlap"],
});
const snapshotJoinWaitDuration = createHistogram("agent.ttft.createTurn.snapshotJoinWaitMs", {
  description: "Time the overlap treatment waits for the pre-turn snapshot after selected-context processing",
});
const overlapSavedDuration = createHistogram("agent.ttft.createTurn.overlapSavedMs", {
  description: "Wall-clock pre-turn snapshot time hidden by concurrent turn preparation in the overlap treatment",
});
const userMessageBlobDuration = createHistogram("agent.ttft.createTurn.userMessageBlobMs", {
  description: "Time to serialize, hash, and persist the user message blob at the end of createAgentTurn",
});

function isTextPart(part: { readonly type?: string; readonly text?: string }): part is { readonly type: "text"; readonly text: string } {
  return part.type === "text";
}

function hasUserMessageIdTag(contentParts: readonly { readonly type?: string; readonly text?: string }[]): boolean {
  if (contentParts.length === 0) return false;
  const firstPart = contentParts[0]!;
  return isTextPart(firstPart) && parseLeadingUserMessageIdTag(firstPart.text) !== undefined;
}

function resolvePromptReferenceId(
  isMetaParentAgent: boolean,
  promptReferenceIdFromUserMessage: string | undefined,
  userMessageId: string,
  userContent: readonly { readonly type?: string; readonly text?: string }[],
): {
  hasStructuredPromptReferenceId: boolean;
  promptReferenceId: string | undefined;
  shouldIncludePromptReferenceIdTag: boolean;
} {
  const alreadyHasPromptReferenceIdTag = hasUserMessageIdTag(userContent);
  const existingPromptReferenceIdTag = alreadyHasPromptReferenceIdTag && userContent.length > 0 && isTextPart(userContent[0]!)
    ? parseLeadingUserMessageIdTag(userContent[0]!.text)
    : undefined;
  const hasStructuredPromptReferenceId = promptReferenceIdFromUserMessage !== undefined && promptReferenceIdFromUserMessage.length > 0;
  let promptReferenceId = hasStructuredPromptReferenceId ? promptReferenceIdFromUserMessage : existingPromptReferenceIdTag?.id;
  const shouldIncludePromptReferenceIdTag = isMetaParentAgent && !hasStructuredPromptReferenceId && !alreadyHasPromptReferenceIdTag;
  if (shouldIncludePromptReferenceIdTag && promptReferenceId === undefined) {
    promptReferenceId = createPromptReferenceId(userMessageId);
  }
  return { hasStructuredPromptReferenceId, promptReferenceId, shouldIncludePromptReferenceIdTag };
}

function toTrackedGitRepoBranches(gitRepos: readonly GitRepoInfo[]): TrackedGitRepoBranch[] {
  return gitRepos.map((repo) => ({ repoPath: repo.path, branchName: repo.branchName }));
}

function collectTrackedGitBranchChanges(
  previousRepos: readonly TrackedGitRepoBranch[],
  currentRepos: readonly TrackedGitRepoBranch[],
): { repoPath: string; from: string; to: string }[] {
  if (previousRepos.length === 0 || currentRepos.length === 0) return [];
  const previousByPath = new Map(previousRepos.map((repo) => [repo.repoPath, repo.branchName]));
  const changes: { repoPath: string; from: string; to: string }[] = [];
  for (const currentRepo of currentRepos) {
    const previousBranchName = previousByPath.get(currentRepo.repoPath);
    if (previousBranchName === undefined || previousBranchName === currentRepo.branchName) continue;
    changes.push({ repoPath: currentRepo.repoPath, from: previousBranchName, to: currentRepo.branchName });
  }
  return changes;
}

function buildLegacyTrackedGitRepoBranchReminder(changes: readonly { repoPath: string; from: string; to: string }[]): string {
  if (changes.length === 0) return "";
  const changedLines = changes.map((change) => `${change.repoPath} changed from ${change.from} to ${change.to}.`);
  return `<system_reminder>
The active branch changed since the last turn:
${changedLines.join("\n")}
Assume these branch changes were intentional and use the new branch state as the current working context.
</system_reminder>`;
}

function buildTrackedGitRepoBranchReminder(
  previousRepos: readonly TrackedGitRepoBranch[],
  currentGitRepos: readonly GitRepoInfo[],
  enhancedBranchChangeReminder: boolean,
): string {
  const currentTracked = toTrackedGitRepoBranches(currentGitRepos);
  const changes = collectTrackedGitBranchChanges(previousRepos, currentTracked);
  if (changes.length === 0) return "";
  if (!enhancedBranchChangeReminder) return buildLegacyTrackedGitRepoBranchReminder(changes);
  const repoByPath = new Map(currentGitRepos.map((repo) => [repo.path, repo]));
  const bodyLines: string[] = [];
  let anyAncestor = false;
  for (const change of changes) {
    let line = `${change.repoPath}: changed from "${change.from}" to "${change.to}".`;
    const repo = repoByPath.get(change.repoPath);
    if (repo?.previousBranchIsAncestor === true) {
      line += " The previous branch is an ancestor of the current HEAD.";
      anyAncestor = true;
    }
    bodyLines.push(line);
  }
  const footer = anyAncestor ? "Prior edits should be present on the current branch." : "Use the current branch as the working context.";
  return `<system_reminder>
The active git branch changed since the last turn:
${bodyLines.join("\n")}
${footer}
</system_reminder>`;
}

type RecentlyAddedPlugin = {
  readonly displayName?: string;
  readonly description?: string;
  readonly skills: readonly { readonly name: string; readonly description?: string }[];
  readonly subagents: readonly { readonly name: string; readonly description?: string }[];
  readonly hooks: readonly { readonly name: string; readonly description?: string }[];
  readonly rules: readonly { readonly name: string; readonly description?: string }[];
  readonly commands: readonly { readonly name: string; readonly description?: string }[];
  readonly mcpServers: readonly string[];
};

function buildRecentlyAddedPluginReminder(plugin: RecentlyAddedPlugin | undefined): string {
  if (!plugin || !plugin.displayName) return "";
  const capabilities: string[] = [];
  if (plugin.skills.length) capabilities.push(`Skills:\n${plugin.skills.map((skill) => `  - ${skill.name}${skill.description ? `: ${skill.description}` : ""}`).join("\n")}`);
  if (plugin.subagents.length) capabilities.push(`Subagents:\n${plugin.subagents.map((subagent) => `  - ${subagent.name}${subagent.description ? `: ${subagent.description}` : ""}`).join("\n")}`);
  if (plugin.hooks.length) capabilities.push(`Hooks:\n${plugin.hooks.map((hook) => `  - ${hook.name}${hook.description ? `: ${hook.description}` : ""}`).join("\n")}`);
  if (plugin.rules.length) capabilities.push(`Rules:\n${plugin.rules.map((rule) => `  - ${rule.name}${rule.description ? `: ${rule.description}` : ""}`).join("\n")}`);
  if (plugin.commands.length) capabilities.push(`Commands:\n${plugin.commands.map((command) => `  - ${command.name}${command.description ? `: ${command.description}` : ""}`).join("\n")}`);
  if (plugin.mcpServers.length) capabilities.push(`MCP Servers:\n${plugin.mcpServers.map((server) => `  - ${server}`).join("\n")}`);
  let prompt = `The user just installed the "${plugin.displayName}" plugin`;
  if (plugin.description) prompt += ` (${plugin.description})`;
  if (capabilities.length) prompt += ` with the following capabilities:\n\n${capabilities.join("\n\n")}`;
  prompt += `

Provide them with an overview of what is contained in the plugin. Keep in mind that:
- Commands can be invoked with \`/\`
- Skills and subagents can be invoked directly with \`/\` or will be used by the agent automatically
- Rules and hooks will be applied automatically`;
  if (plugin.mcpServers.length) prompt += `
- MCP servers likely require authentication. After providing an overview of the plugin, check the STATUS.md file in the server's folder to see if it needs authentication, and follow the instructions in the file to authenticate.`;
  prompt += `

Do NOT do any other searches over file system contents, search the web, etc. and do not think for too long. Just give the user an overview of the plugin they installed.`;
  return `<system_reminder>
${prompt}
</system_reminder>`;
}

function buildCurrentTimestamp(timeZone?: string): string {
  const now = new Date();
  try {
    const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || undefined,
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const formatted = dateTimeFormatter.format(now);
    const offsetFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || undefined,
      timeZoneName: "shortOffset",
    });
    const parts = offsetFormatter.formatToParts(now);
    const tzPart = parts.find(part => part.type === "timeZoneName");
    const utcOffset = (tzPart?.value ?? "UTC").replace("GMT", "UTC");
    return `${formatted} (${utcOffset})`;
  } catch {
    return now.toISOString();
  }
}

export function buildTimestampPrefix(timeZone?: string): string {
  return `<timestamp>${buildCurrentTimestamp(timeZone)}</timestamp>\n`;
}

const conversationTurnStructureSerde2 = new ProtoSerde(ConversationTurnStructure);

function withRedactionOptions<Redacted, Plain>(
  deserializer: (value: Redacted, purpose: PrivacyCapability, options: unknown) => Plain,
): (value: Redacted, purpose: PrivacyCapability) => Plain {
  return (value, purpose) => deserializer(value, purpose, undefined);
}

function createRedactedSerdes(privacyMode: PrivacyMode) {
  return {
    shellCommand: createRedactedProtoSerde(ShellCommand, toRedactedShellCommand, withRedactionOptions(fromRedactedShellCommand), privacyMode),
    shellOutput: createRedactedProtoSerde(ShellOutput, toRedactedShellOutput, withRedactionOptions(fromRedactedShellOutput), privacyMode),
    userMessage: createRedactedProtoSerde(UserMessage, toRedactedUserMessage, withRedactionOptions(fromRedactedUserMessage), privacyMode),
    conversationStep: createRedactedProtoSerde(ConversationStep, toRedactedConversationStep, withRedactionOptions(fromRedactedConversationStep), privacyMode),
    conversationSummary: createRedactedProtoSerde(ConversationSummary, toRedactedConversationSummary, withRedactionOptions(fromRedactedConversationSummary), privacyMode),
    conversationSummaryArchive: createRedactedProtoSerde(ConversationSummaryArchive, toRedactedConversationSummaryArchive, withRedactionOptions(fromRedactedConversationSummaryArchive), privacyMode),
    conversationPlan: createRedactedProtoSerde(ConversationPlan, toRedactedConversationPlan, withRedactionOptions(fromRedactedConversationPlan), privacyMode),
    todoItem: createRedactedProtoSerde(TodoItem, toRedactedTodoItem, withRedactionOptions(fromRedactedTodoItem), privacyMode),
    subagentPersistedState: createRedactedProtoSerde(SubagentPersistedState, toRedactedSubagentPersistedState, withRedactionOptions(fromRedactedSubagentPersistedState), privacyMode),
    coreMessage: createRedactedCoreMessageSerde(privacyMode),
  };
}

type FileStateContentReference<Context extends OperationContext> = EagerReference<string, Context> | LazyReference<string, Context> | undefined;
type FileStateReferenceSet<Context extends OperationContext> = {
  content: FileStateContentReference<Context>;
  initialContent: FileStateContentReference<Context>;
};

type WorkspaceRequestContext = {
  readonly env?: {
    readonly workspacePaths?: readonly unknown[];
  };
};

function toFileStateContentReference<Context extends OperationContext>(
  blobStore: BlobStore<Context>,
  content: string | undefined,
): FileStateContentReference<Context> {
  return content !== undefined ? new EagerReference(utf8Serde, blobStore, content) : undefined;
}

function recordFileStateInMap<Context extends OperationContext>(
  fileStates: Map<string, FileStateReferenceSet<Context>>,
  blobStore: BlobStore<Context>,
  path: string,
  content: string | undefined,
  prevContent: string | undefined,
  skipReprioritization: boolean | undefined,
): void {
  const existing = fileStates.get(path);
  const next = existing === undefined ? {
    content: toFileStateContentReference(blobStore, content),
    initialContent: toFileStateContentReference(blobStore, prevContent),
  } : {
    content: toFileStateContentReference(blobStore, content),
    initialContent: existing.initialContent,
  };
  if (skipReprioritization) {
    fileStates.set(path, next);
    return;
  }
  const otherEntries = Array.from(fileStates).filter(([key]) => key !== path);
  fileStates.clear();
  fileStates.set(path, next);
  for (const [key, value] of otherEntries) {
    fileStates.set(key, value);
  }
}

function extractWorkspaceUris(_ctx: unknown, requestContext: WorkspaceRequestContext) {
  const workspacePaths = requestContext.env?.workspacePaths ?? [];
  const uris: string[] = [];
  for (const workspacePath of workspacePaths) {
    if (typeof workspacePath !== "string") {
      continue;
    }
    const trimmedPath = workspacePath.trim();
    if (trimmedPath.length === 0) {
      continue;
    }
    if (trimmedPath.includes("://")) {
      uris.push(trimmedPath);
      continue;
    }
    try {
      uris.push(pathToFileURL(trimmedPath).toString());
    } catch {
    }
  }
  const sortedUris = uris.slice().sort((a, b) => a.localeCompare(b));
  return sortedUris.map(uri => createRedactedString(uri, DataClassification.PATH, "workspaceUri", PrivacyModes.UNSPECIFIED));
}

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

type UserMessageThreadFields = {
  readonly threadId?: string;
  readonly promptReferenceId?: string;
  readonly messageId?: string;
};

function getExplicitUserMessageThreadId(userMessage: UserMessageThreadFields): string | undefined {
  return normalizeNonEmptyString(userMessage.threadId);
}

function resolveUserMessageThreadId(userMessage: UserMessageThreadFields): string | undefined {
  return getExplicitUserMessageThreadId(userMessage)
    ?? normalizeNonEmptyString(userMessage.promptReferenceId)
    ?? normalizeNonEmptyString(userMessage.messageId);
}

function withUserMessageThreadId<T extends object>(userMessage: T, threadId: string): T & { threadId: string } {
  return { ...userMessage, threadId };
}

type RedactedCodeStringLike = { unwrap: (purpose: PrivacyCapability) => string };
type PossiblyRedactedCodeString = string | RedactedCodeStringLike | null | undefined;

function unwrapPossiblyRedactedCodeString(value: PossiblyRedactedCodeString): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" ? value : value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
}

type CommunicateUpdateTurnStateLike = {
  readonly history?: readonly {
    readonly step?: PossiblyRedactedCodeString;
    readonly messageIndex: number;
  }[];
  readonly finalSummary?: PossiblyRedactedCodeString;
  readonly completedSubtitle?: PossiblyRedactedCodeString;
};

function toCommunicateUpdateTurnState(state: CommunicateUpdateTurnStateLike): CommunicateUpdateTurnState {
  return new CommunicateUpdateTurnState({
    history: (state.history ?? []).map((entry) => new CommunicateUpdateHistoryEntry({
      step: unwrapPossiblyRedactedCodeString(entry.step) ?? "",
      messageIndex: entry.messageIndex,
    })),
    finalSummary: normalizeNonEmptyString(unwrapPossiblyRedactedCodeString(state.finalSummary))!,
    completedSubtitle: normalizeNonEmptyString(unwrapPossiblyRedactedCodeString(state.completedSubtitle))!,
  });
}

type SubagentTrackingState = {
  readonly lastUsedTimestampMs: bigint;
  readonly subagentType?: SubagentType;
};

function computeSubagentTracking(
  subagentStates: ReadonlyMap<string, SubagentTrackingState>,
): {
  lastUsedSubagentId: string | undefined;
  lastSubagentByType: Map<string, string>;
} {
  let lastUsedSubagentId: string | undefined;
  let maxTimestamp = BigInt(0);
  const typeMaxTimestamps = new Map<string, { id: string; timestamp: bigint }>();
  for (const [subagentId, state] of subagentStates) {
    const timestamp = state.lastUsedTimestampMs;
    const subagentType = state.subagentType;
    if (timestamp > maxTimestamp) {
      maxTimestamp = timestamp;
      lastUsedSubagentId = subagentId;
    }
    if (subagentType) {
      const typeName = getSubagentTypeName(subagentType);
      const existing = typeMaxTimestamps.get(typeName);
      if (!existing || timestamp > existing.timestamp) {
        typeMaxTimestamps.set(typeName, { id: subagentId, timestamp });
      }
    }
  }
  const lastSubagentByType = new Map<string, string>();
  for (const [typeName, { id }] of typeMaxTimestamps) {
    lastSubagentByType.set(typeName, id);
  }
  return { lastUsedSubagentId, lastSubagentByType };
}

function subagentRunStatusFromCompletionStatus(status: BackgroundTaskStatus): SubagentRunStatus {
  switch (status) {
    case BackgroundTaskStatus.SUCCESS:
      return SubagentRunStatus.SUCCESS;
    case BackgroundTaskStatus.ERROR:
      return SubagentRunStatus.ERROR;
    case BackgroundTaskStatus.ABORTED:
      return SubagentRunStatus.ABORTED;
    case BackgroundTaskStatus.UNSPECIFIED:
      return SubagentRunStatus.UNSPECIFIED;
    default: {
      const exhaustive = status;
      return exhaustive;
    }
  }
}

type RedactedCoreMessageForSerialization = {
  readonly _privacyMode: PrivacyMode;
  readonly role: string;
  readonly content: unknown;
  readonly providerOptions?: unknown;
  readonly id?: unknown;
  readonly [key: string]: unknown;
};

type RedactedConversationTokenDetailsLike = {
  readonly promptContextUsageTree?: Parameters<typeof persistPromptContextUsageSnapshot>[0]["usageTree"];
  readonly [key: string]: unknown;
};

type RootPromptBuilder = {
  appendMessages(messages: unknown | readonly unknown[]): void;
  getState(): readonly RedactedCoreMessageForSerialization[];
};
type RestoreRootPromptBuilder = RootPromptBuilder & { clearMessages(): void };
type RedactedTextLike = { safeTransform(transform: (value: string) => string): RedactedTextLike };
type RedactedToolCallLike = {
  toolCallId?: string;
  tool: { case: string | undefined };
  [key: string]: unknown;
};
type RedactedConversationStepLike = {
  _privacyMode: PrivacyMode;
  message:
    | { case: "assistantMessage"; value: { text: RedactedTextLike } }
    | { case: "toolCall"; value: RedactedToolCallLike }
    | { case: "thinkingMessage"; value: { text: RedactedTextLike; durationMs?: number } }
    | { case: undefined; value?: undefined };
};
type AgentConversationTurnSerdes = {
  userMessage: Serde<any>;
  conversationStep: Serde<any>;
};
type ShellConversationTurnSerdes = {
  shellCommand: Serde<unknown>;
  shellOutput: Serde<unknown>;
};
type ConversationStepReference =
  | LazyReference<RedactedConversationStepLike, OperationContext>
  | EagerReference<RedactedConversationStepLike, OperationContext>;

export class ShellConversationTurnHandle<Context extends OperationContext = OperationContext> extends Writeable<Context> {
  private readonly blobStore: BlobStore<Context>;
  private readonly serdes: ShellConversationTurnSerdes;
  private turnStructure: ShellConversationTurnStructure;
  private blobId: Uint8Array | undefined;
  private dirty: boolean;
  private readonly shellCommand: LazyReference<unknown, Context>;
  private readonly shellOutput: LazyReference<unknown, Context>;

  constructor(
    blobStore: BlobStore<Context>,
    serdes: ShellConversationTurnSerdes,
    turnStructure: ShellConversationTurnStructure,
    blobId: Uint8Array | undefined = undefined,
  ) {
    super();
    this.blobStore = blobStore;
    this.serdes = serdes;
    this.turnStructure = turnStructure;
    this.blobId = blobId;
    this.dirty = false;
    this.shellCommand = new LazyReference(serdes.shellCommand, blobStore, this.turnStructure.shellCommand);
    this.shellOutput = new LazyReference(serdes.shellOutput, blobStore, this.turnStructure.shellOutput);
  }

  serialize(): Uint8Array {
    return conversationTurnStructureSerde2.serialize(new ConversationTurnStructure({
      turn: { case: "shellConversationTurn", value: this.turnStructure },
    }));
  }

  async writeToBlobStore(ctx: Context): Promise<Uint8Array> {
    if (!this.dirty && this.blobId !== undefined) {
      return this.blobId;
    }
    const newShellCommandBlobId = await this.shellCommand.writeToBlobStore(ctx);
    const newShellOutputBlobId = await this.shellOutput.writeToBlobStore(ctx);
    const newTurnStructure = new ShellConversationTurnStructure({
      shellCommand: new Uint8Array(newShellCommandBlobId),
      shellOutput: new Uint8Array(newShellOutputBlobId),
    });
    const serializedWrapper = conversationTurnStructureSerde2.serialize(new ConversationTurnStructure({
      turn: { case: "shellConversationTurn", value: newTurnStructure },
    }));
    const newBlobId = await getBlobId(serializedWrapper);
    if (this.blobId !== undefined && isEqual(
      this.blobId as unknown as readonly number[],
      newBlobId as unknown as readonly number[],
    )) {
      this.dirty = false;
      return this.blobId;
    }
    getBlobMetadataCallback(this.blobStore)?.({
      blobId: newBlobId,
      blobType: { kind: "proto", typeName: "agent.v1.ConversationTurnStructure" },
    });
    await this.blobStore.setBlob(ctx, newBlobId, serializedWrapper);
    this.turnStructure = newTurnStructure;
    this.blobId = newBlobId;
    this.dirty = false;
    return newBlobId;
  }

  recordShellOutput(shellOutput: unknown): void {
    this.shellOutput.set(shellOutput);
    this.dirty = true;
  }
}

export class AgentConversationTurnHandle<Context extends OperationContext = OperationContext> extends Writeable<Context> {
  private readonly blobStore: BlobStore<Context>;
  private readonly serdes: AgentConversationTurnSerdes;
  private readonly privacyMode: PrivacyMode;
  private turnStructure: AgentConversationTurnStructure;
  private readonly rootPromptBuilder: RootPromptBuilder;
  private blobId: Uint8Array | undefined;
  private dirty: boolean;
  readonly userMessage: LazyReference<any, Context>;
  readonly steps: ConversationStepReference[];
  private readonly sendMessageStepIndices: number[];

  constructor(
    blobStore: BlobStore<Context>,
    serdes: AgentConversationTurnSerdes,
    privacyMode: PrivacyMode,
    turnStructure: AgentConversationTurnStructure,
    rootPromptBuilder: RootPromptBuilder,
    blobId: Uint8Array | undefined = undefined,
  ) {
    super();
    this.blobStore = blobStore;
    this.serdes = serdes;
    this.privacyMode = privacyMode;
    this.turnStructure = turnStructure;
    this.rootPromptBuilder = rootPromptBuilder;
    this.blobId = blobId;
    this.dirty = false;
    this.userMessage = new LazyReference(serdes.userMessage, blobStore, turnStructure.userMessage);
    this.steps = turnStructure.steps.map(blobId2 => new LazyReference(serdes.conversationStep, blobStore, blobId2));
    this.sendMessageStepIndices = turnStructure.sendMessageStepIndices.filter(index => index < this.steps.length);
  }

  getInnerStructure(): AgentConversationTurnStructure {
    return this.turnStructure;
  }

  setUserMessage(userMessage: unknown): void {
    this.userMessage.set(userMessage);
    this.dirty = true;
  }

  serialize(): Uint8Array {
    return conversationTurnStructureSerde2.serialize(new ConversationTurnStructure({
      turn: { case: "agentConversationTurn", value: this.turnStructure },
    }));
  }

  appendPromptMessages(messages: readonly unknown[]): void {
    this.rootPromptBuilder.appendMessages(messages);
  }

  private createToolCallStep(toolCall: RedactedToolCallLike, toolCallId?: string): RedactedConversationStepLike {
    const toolCallWithId = toolCallId !== undefined ? { ...toolCall, toolCallId } : toolCall;
    return {
      _privacyMode: this.privacyMode,
      message: { case: "toolCall", value: toolCallWithId },
    };
  }

  recordToolCall(toolCall: RedactedToolCallLike, toolCallId?: string): void {
    const redactedStep = this.createToolCallStep(toolCall, toolCallId);
    if (redactedStep.message.case === "toolCall" && redactedStep.message.value.tool.case === "sendMessageToolCall") {
      this.sendMessageStepIndices.push(this.steps.length);
    }
    this.steps.push(new EagerReference(this.serdes.conversationStep, this.blobStore, redactedStep));
    this.dirty = true;
  }

  async upsertToolCall(ctx: Context, toolCall: RedactedToolCallLike, toolCallId?: string): Promise<void> {
    const redactedStep = this.createToolCallStep(toolCall, toolCallId);
    for (let index = this.steps.length - 1; index >= 0; index -= 1) {
      const step = await this.steps[index]!.get(ctx);
      if (step.message.case === "toolCall" && step.message.value.toolCallId === toolCallId) {
        this.steps[index]!.set(redactedStep);
        this.dirty = true;
        return;
      }
    }
    if (redactedStep.message.case === "toolCall" && redactedStep.message.value.tool.case === "sendMessageToolCall") {
      this.sendMessageStepIndices.push(this.steps.length);
    }
    this.steps.push(new EagerReference(this.serdes.conversationStep, this.blobStore, redactedStep));
    this.dirty = true;
  }

  async recordThinking(ctx: Context, text: string, durationMs?: number): Promise<void> {
    if (this.steps.length > 0) {
      const lastStepReference = this.steps.at(-1)!;
      const lastStep = await lastStepReference.get(ctx);
      if (
        lastStep.message.case === "thinkingMessage" &&
        !((lastStep.message.value.durationMs ?? 0) > 0)
      ) {
        const newStep: RedactedConversationStepLike = {
          _privacyMode: this.privacyMode,
          message: {
            case: "thinkingMessage",
            value: {
              _privacyMode: this.privacyMode,
              text: lastStep.message.value.text.safeTransform(existingText => existingText + text),
              durationMs: durationMs ?? 0,
            },
          } as RedactedConversationStepLike["message"],
        };
        lastStepReference.set(newStep);
      } else {
        const newStep = new ConversationStep({
          message: {
            case: "thinkingMessage",
            value: new ThinkingMessage({ text, durationMs: durationMs! }),
          },
        });
        this.steps.push(new EagerReference(
          this.serdes.conversationStep,
          this.blobStore,
          toRedactedConversationStep(newStep, this.privacyMode) as RedactedConversationStepLike,
        ));
      }
    } else {
      const newStep = new ConversationStep({
        message: {
          case: "thinkingMessage",
          value: new ThinkingMessage({ text, durationMs: durationMs! }),
        },
      });
      this.steps.push(new EagerReference(
        this.serdes.conversationStep,
        this.blobStore,
        toRedactedConversationStep(newStep, this.privacyMode) as RedactedConversationStepLike,
      ));
    }
    this.dirty = true;
  }

  async recordText(ctx: Context, text: string): Promise<void> {
    if (this.steps.length > 0) {
      const lastStepReference = this.steps.at(-1)!;
      const lastStep = await lastStepReference.get(ctx);
      if (lastStep.message.case === "assistantMessage") {
        const newStep: RedactedConversationStepLike = {
          _privacyMode: this.privacyMode,
          message: {
            case: "assistantMessage",
            value: {
              _privacyMode: this.privacyMode,
              text: lastStep.message.value.text.safeTransform(existingText => existingText + text),
            },
          } as RedactedConversationStepLike["message"],
        };
        lastStepReference.set(newStep);
      } else {
        const newStep = new ConversationStep({
          message: {
            case: "assistantMessage",
            value: new AssistantMessage({ text }),
          },
        });
        this.steps.push(new EagerReference(
          this.serdes.conversationStep,
          this.blobStore,
          toRedactedConversationStep(newStep, this.privacyMode) as RedactedConversationStepLike,
        ));
      }
    } else {
      const newStep = new ConversationStep({
        message: {
          case: "assistantMessage",
          value: new AssistantMessage({ text }),
        },
      });
      this.steps.push(new EagerReference(
        this.serdes.conversationStep,
        this.blobStore,
        toRedactedConversationStep(newStep, this.privacyMode) as RedactedConversationStepLike,
      ));
    }
    this.dirty = true;
  }

  async writeToBlobStore(ctx: Context): Promise<Uint8Array> {
    if (!this.dirty && this.blobId !== undefined) {
      return this.blobId;
    }
    const newUserMessageBlobId = await this.userMessage.writeToBlobStore(ctx);
    const newStepsBlobIds = await Promise.all(this.steps.map(step => step.writeToBlobStore(ctx)));
    const newInnerStructure = new AgentConversationTurnStructure({
      userMessage: new Uint8Array(newUserMessageBlobId),
      steps: newStepsBlobIds,
      sendMessageStepIndices: this.sendMessageStepIndices,
      ...(this.turnStructure.requestId && { requestId: this.turnStructure.requestId }),
      ...(this.turnStructure.encryptedModel !== undefined && this.turnStructure.encryptedModel.length > 0
        ? { encryptedModel: this.turnStructure.encryptedModel }
        : {}),
      ...(this.turnStructure.dynamicToolCount !== undefined
        ? { dynamicToolCount: this.turnStructure.dynamicToolCount }
        : {}),
    });
    const serializedWrapper = conversationTurnStructureSerde2.serialize(new ConversationTurnStructure({
      turn: { case: "agentConversationTurn", value: newInnerStructure },
    }));
    const newBlobId = await getBlobId(serializedWrapper);
    if (this.blobId !== undefined && isEqual(
      this.blobId as unknown as readonly number[],
      newBlobId as unknown as readonly number[],
    )) {
      this.dirty = false;
      return this.blobId;
    }
    getBlobMetadataCallback(this.blobStore)?.({
      blobId: newBlobId,
      blobType: { kind: "proto", typeName: "agent.v1.ConversationTurnStructure" },
    });
    await this.blobStore.setBlob(ctx, newBlobId, serializedWrapper);
    this.turnStructure = newInnerStructure;
    this.blobId = newBlobId;
    this.dirty = false;
    return newBlobId;
  }
}

type RedactedValue<T> = {
  unwrap(purpose: PrivacyCapability, options?: object): T;
};

type UserMessageBlobHydrationTarget = {
  text: string;
  textBlobId?: Uint8Array;
  richText?: string;
  richTextBlobId?: Uint8Array;
};

type RedactedFileStateStructure = {
  readonly content?: RedactedValue<Uint8Array>;
  readonly initialContent?: RedactedValue<Uint8Array>;
};

type RedactedTrackedGitRepo = {
  readonly repoPath: RedactedValue<string>;
  readonly branchName: string;
};

type TrackedGitRepoBranch = {
  readonly repoPath: string;
  readonly branchName: string;
};

type RedactedConversationStateStructure = {
  readonly _privacyMode: PrivacyMode;
  readonly rootPromptMessagesJson: readonly Uint8Array[];
  readonly turns: readonly Uint8Array[];
  readonly todos: readonly Uint8Array[];
  readonly pendingToolCalls?: readonly RedactedValue<string>[];
  readonly tokenDetails?: RedactedConversationTokenDetailsLike;
  readonly summary?: Uint8Array;
  readonly plan?: Uint8Array;
  readonly previousWorkspaceUris: readonly RedactedValue<string>[];
  mode?: AgentMode;
  readonly summaryArchives: readonly Uint8Array[];
  readonly fileStatesV2: ReadonlyMap<RedactedValue<string>, RedactedFileStateStructure>;
  readonly selfSummaryCount?: number;
  readonly readPaths: readonly RedactedValue<string>[];
  readonly activeBranchName?: string;
  readonly plans?: ReadonlyMap<string, unknown>;
  readonly trackedGitRepoBranches?: readonly RedactedTrackedGitRepo[];
  readonly agentType?: string;
  readonly communicateUpdateHistory?: readonly {
    readonly step: RedactedValue<string>;
    readonly messageIndex: number;
  }[];
  readonly subagentThreads?: ReadonlyMap<string, string> | Record<string, string>;
  readonly communicateUpdateFinalSummary?: RedactedValue<string>;
  readonly communicateUpdateCompletedSubtitle?: RedactedValue<string>;
  readonly communicateUpdateStatesByParentToolCallId?: ReadonlyMap<string, unknown> | Record<string, unknown>;
  readonly subagentStates?: ReadonlyMap<string, unknown>;
  readonly subagentRunsByParentToolCallId?: ReadonlyMap<string, unknown>;
  readonly conversationStartedTimestampMs?: bigint;
  readonly conversationStartedTimeZone?: string;
  readonly subagentStateRefs?: ReadonlyMap<string, Uint8Array>;
  readonly goalState?: unknown;
  readonly isRootProjectConversation?: boolean;
  readonly completedAskQuestionToolCallIds?: readonly string[];
};

type ConversationStateRestoreOptions = {
  readonly shouldTrackAgentTypeChange?: boolean;
  readonly loadRootPromptBlobs?: boolean;
  readonly restoreBlobFetchConcurrency?: number;
  readonly serializeSubagentStatesAsBlobRefs?: boolean;
  readonly onRootPromptImagePresence?: (presence: ReturnType<typeof computeCoreMessageImagePresence>) => void;
};

type CreateAgentTurnOptions = {
  readonly isProjectKickoff?: boolean;
  readonly additionalUserTurnSystemReminder?: string;
  readonly dynamicToolCount?: number;
  readonly dynamicToolMetaNames?: {
    readonly discoveryToolName: string;
    readonly invocationToolName: string;
  };
};

type ProjectPromptText = NonNullable<Parameters<typeof formatProjectPrompt>[1]>["promptText"];

type CreateAgentTurnConfig = Parameters<typeof processSelectedContext>[3] & ModeProcessingConfig & {
  readonly featureFlags?: NonNullable<Parameters<typeof processSelectedContext>[3]["featureFlags"]> & {
    readonly enableTrackedGitRepoState?: boolean;
    readonly glassMetaParentAgent?: boolean;
    readonly skipPreTurnStateSnapshot?: boolean;
    readonly overlapPreTurnStateSnapshot?: boolean;
    readonly enhancedBranchChangeReminder?: boolean;
    readonly cloudCoordinatorToolsEnabled?: boolean;
    readonly userMessageTimestamps?: boolean;
    readonly enableHookAdditionalContext?: boolean;
    readonly enableAgentStoreConflictNotices?: boolean;
  };
  readonly model?: { readonly mcid?: string };
  readonly encryptedMcidAndParams?: string;
  readonly decryptMcidAndParams?: (encrypted: string) => string | undefined;
  readonly isEagerEditingModel?: boolean;
  readonly projectPromptTextGenerator?: () => ProjectPromptText;
};

type CreateAgentTurnResourceAccessor = Parameters<typeof processSelectedContext>[5];
type CreateAgentTurnRequestContext = RequestContext & ModeProcessingRequestContext;

type ConversationStateSerdes = ReturnType<typeof createRedactedSerdes>;
type ConversationTurnHandle = AgentConversationTurnHandle | ShellConversationTurnHandle;
type ConversationValueReference<Context extends OperationContext> = EagerReference<any, Context> | LazyReference<any, Context>;
type TurnUsageDelta = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens?: number;
};
type ConversationFileStateReference<Context extends OperationContext> = {
  content: FileStateContentReference<Context>;
  initialContent: FileStateContentReference<Context>;
};

export class ConversationStateHandle {
  blobStore: BlobStore<OperationContext>;
  conversationStateStructure: RedactedConversationStateStructure;
  rootPromptBuilder: RestoreRootPromptBuilder;
  formattingOptions: unknown;
  modelId: string | undefined;
  agentTypeChangedFromPersistedState: boolean;
  isRootProjectConversation: boolean;
  plans: Map<string, PlanRegistryEntry>;
  fileStates: Map<string, ConversationFileStateReference<OperationContext>>;
  readPaths: Set<string>;
  completedAskQuestionToolCallIds: Set<string>;
  communicateUpdateHistory: CommunicateUpdateHistoryEntry[];
  communicateUpdateStatesByParentToolCallId: Map<string, CommunicateUpdateTurnState>;
  backgroundSummarizationPromiseInfo: unknown;
  messagesUndergoingSummarization: unknown;
  backgroundSummarizationHasCompleted: boolean;
  backgroundSummarizationGenerationDurationMs: number | null;
  backgroundSummarizationCancellationToken: unknown;
  tokenDetailsStaleAfterSummarization: boolean;
  summaryArchives: ConversationValueReference<OperationContext>[];
  selfSummaryCount: number;
  selfSummaryInputLimitFailureTokenCount: number;
  trackedGitRepoBranches: TrackedGitRepoBranch[];
  subagentStates: Map<string, SubagentPersistedState>;
  subagentRunsByParentToolCallId: Map<string, SubagentRunState>;
  subagentThreads: Map<string, string>;
  lastSubagentByType: Map<string, string>;
  lastUsedSubagentId: string | undefined;
  turnUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  };
  pendingComputeStructure: Promise<RedactedConversationStateStructure> | null;
  skippedRootPromptBlobs: boolean;
  originalRootPromptMessagesJson: Uint8Array[];
  rootPromptPrefixInvalidated: boolean;
  userTurnMessageIdsIndexedTurnCount: number;
  userTurnMessageIdsIndex: Set<string> | undefined;
  privacyMode: PrivacyMode;
  serdes: ConversationStateSerdes;
  serializeSubagentStatesAsBlobRefs: boolean;
  restoreBlobFetchConcurrency: number;
  previousWorkspaceUris: RedactedValue<string>[] | undefined;
  mode: AgentMode | undefined;
  agentType: ReturnType<typeof parseAgentType>;
  activeBranchName: string | undefined;
  conversationStartedTimestampMs: bigint | undefined;
  conversationStartedTimeZone: string | undefined;
  turns: ConversationValueReference<OperationContext>[];
  todos: ConversationValueReference<OperationContext>[];
  tokenDetails: RedactedConversationTokenDetailsLike;
  summary: ConversationValueReference<OperationContext> | undefined;
  plan: ConversationValueReference<OperationContext> | undefined;
  communicateUpdateFinalSummary: string | undefined;
  communicateUpdateCompletedSubtitle: string | undefined;
  goalState: GoalState | undefined;

  createConversationTurnHandleSerde(): Serde<ConversationTurnHandle> {
    return {
      deserialize: (blob) => {
        const outer = conversationTurnStructureSerde2.deserialize(blob);
        switch (outer.turn.case) {
          case "agentConversationTurn":
            return new AgentConversationTurnHandle(this.blobStore, this.serdes, this.privacyMode, outer.turn.value, this.rootPromptBuilder);
          case "shellConversationTurn":
            return new ShellConversationTurnHandle(this.blobStore, this.serdes, outer.turn.value);
          default:
            throw new Error("Invalid ConversationTurnStructure: missing turn case");
        }
      },
      serialize: (value) => value.serialize(),
      getBlobType: () => ({
        kind: "proto",
        typeName: "agent.v1.ConversationTurnStructure",
      }),
    };
  }

  getRawPendingMessages(): readonly RedactedValue<string>[] | undefined {
    return this.conversationStateStructure.pendingToolCalls;
  }

  assertRootPromptBlobsLoadedForFullPromptRead(): void {
    if (!this.skippedRootPromptBlobs) return;
    throw new Error("Cannot read full root prompt messages when root prompt blobs were not loaded");
  }

  invalidateRootPromptPrefix(): void {
    if (this.skippedRootPromptBlobs) {
      this.rootPromptPrefixInvalidated = true;
    }
  }

  static async fromConversationStateStructure(
    ctx: OperationContext,
    blobStore: BlobStore<OperationContext>,
    conversationStateStructure: RedactedConversationStateStructure,
    rootPromptBuilder: RestoreRootPromptBuilder,
    formattingOptions: unknown,
    modelId: string | undefined,
    runtimeAgentType: ReturnType<typeof parseAgentType>,
    options2?: ConversationStateRestoreOptions,
  ): Promise<ConversationStateHandle> {
    const env_1: DisposableEnvironment = { stack: [], error: undefined, hasError: false };
    try {
      const span = createSpan(ctx.withName("fromConversationStateStructure"));
      __addDisposableResource19(env_1, span, false);
      const restoreStart = performance.now();
      let getBlobCount = 0;
      const shouldTrackAgentTypeChange = options2?.shouldTrackAgentTypeChange ?? false;
      const loadRootPromptBlobs = options2?.loadRootPromptBlobs ?? true;
      const restoreBlobFetchConcurrency = options2?.restoreBlobFetchConcurrency ?? RESTORE_BLOB_FETCH_CONCURRENCY;
      const serdes = createRedactedSerdes(conversationStateStructure._privacyMode);
      let rootPromptBytes = 0;
      let rootPromptImageBytes = 0;
      let rootPromptImagePartCount = 0;
      let rootPromptMessageCount = 0;
      const rootPromptPhaseStart = performance.now();
      if (loadRootPromptBlobs) {
        const span2 = createSpan(span.ctx.withName("loadRootPromptMessages"));
        const quietCtx2 = withSuppressedChildSpans(span2.ctx);
        const rootPromptMessageLoads = await asyncMapValues(conversationStateStructure.rootPromptMessagesJson, async (blobId) => {
          const blob = await blobStore.getBlob(quietCtx2, blobId);
          getBlobCount++;
          if (!blob) {
            return { kind: "missing" as const, blobIdHex: toHex(blobId) };
          }
          try {
            const message = serdes.coreMessage.deserialize(blob);
            serializedMessageCache.set(message, { blobId, blobData: blob });
            const plainMessage = fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
            const imageStats = getCoreMessageImagePayloadStats(plainMessage);
            return {
              kind: "loaded" as const,
              entry: {
                message,
                plainMessage,
                blobBytes: blob.byteLength,
                imageBytes: imageStats.imageBytes,
                imagePartCount: imageStats.imagePartCount,
              },
            };
          } catch (error4) {
            return { kind: "failed" as const, error: error4 };
          }
        }, { max: restoreBlobFetchConcurrency });
        const missingRootPromptBlobIdHexes = rootPromptMessageLoads.flatMap((load2) => load2.kind === "missing" ? [load2.blobIdHex] : []);
        if (missingRootPromptBlobIdHexes.length > 0) {
          span2.span.setAttribute("missingBlobCount", missingRootPromptBlobIdHexes.length);
          span2.span.end();
          throw new BlobNotFoundError(missingRootPromptBlobIdHexes);
        }
        const firstFailedLoad = rootPromptMessageLoads.find((load2) => load2.kind === "failed");
        if (firstFailedLoad !== undefined && firstFailedLoad.kind === "failed") {
          span2.span.end();
          throw firstFailedLoad.error;
        }
        const rootPromptMessageEntries = rootPromptMessageLoads.flatMap((load2) => load2.kind === "loaded" ? [load2.entry] : []);
        const rootPromptMessages = rootPromptMessageEntries.map(({ message }) => message);
        if (options2?.onRootPromptImagePresence !== undefined) {
          const plainRootPromptMessages = rootPromptMessageEntries.map(({ plainMessage }) => plainMessage);
          options2.onRootPromptImagePresence(computeCoreMessageImagePresence(plainRootPromptMessages));
        }
        rootPromptBytes = rootPromptMessageEntries.reduce((total, entry) => total + entry.blobBytes, 0);
        rootPromptImageBytes = rootPromptMessageEntries.reduce((total, entry) => total + entry.imageBytes, 0);
        rootPromptImagePartCount = rootPromptMessageEntries.reduce((total, entry) => total + entry.imagePartCount, 0);
        rootPromptMessageCount = rootPromptMessages.length;
        for (const { message, plainMessage } of rootPromptMessageEntries) {
          coreToRedactedMap.set(plainMessage, message);
        }
        rootPromptBuilder.clearMessages();
        rootPromptBuilder.appendMessages(rootPromptMessages);
        span2.span.setAttribute("getBlobCount", getBlobCount);
        span2.span.setAttribute("rootPromptBytes", rootPromptBytes);
        span2.span.setAttribute("rootPromptImageBytes", rootPromptImageBytes);
        span2.span.setAttribute("rootPromptImagePartCount", rootPromptImagePartCount);
        span2.span.end();
      } else {
        rootPromptBuilder.clearMessages();
        rootPromptMessageCount = conversationStateStructure.rootPromptMessagesJson.length;
      }
      const rootPromptPhaseMs = performance.now() - rootPromptPhaseStart;
      const span3 = createSpan(span.ctx.withName("loadFileStates"));
      const quietCtx3 = withSuppressedChildSpans(span3.ctx);
      const state = new ConversationStateHandle(blobStore, conversationStateStructure, rootPromptBuilder, formattingOptions, modelId, options2);
      const subagentPhaseStart = performance.now();
      await state.loadSubagentStateRefs(quietCtx3);
      const subagentStateRefsPhaseMs = performance.now() - subagentPhaseStart;
      state.skippedRootPromptBlobs = !loadRootPromptBlobs;
      state.originalRootPromptMessagesJson = loadRootPromptBlobs ? [] : [...conversationStateStructure.rootPromptMessagesJson];
      const persistedAgentType = state.agentType;
      if (runtimeAgentType !== undefined) {
        state.agentTypeChangedFromPersistedState = shouldTrackAgentTypeChange && persistedAgentType !== undefined && persistedAgentType !== runtimeAgentType;
        state.agentType = runtimeAgentType;
      }
      const fileStateEntries = Array.from(conversationStateStructure.fileStatesV2.entries());
      const fileStateLoadStart = performance.now();
      for (const [pathString, fileStateStructure] of fileStateEntries) {
        const path29 = pathString.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
        const contentBlobId = fileStateStructure.content?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
        const initialContentBlobId = fileStateStructure.initialContent?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
        state.fileStates.set(path29, {
          content: contentBlobId !== undefined ? new LazyReference(utf8Serde, blobStore, contentBlobId) : undefined,
          initialContent: initialContentBlobId !== undefined ? new LazyReference(utf8Serde, blobStore, initialContentBlobId) : undefined,
        });
      }
      span3.span.setAttribute("fileStatePathCount", fileStateEntries.length);
      span3.span.end();
      const fileStatesPhaseMs = performance.now() - fileStateLoadStart;
      for (const path29 of conversationStateStructure.readPaths) {
        state.recordReadPath(path29);
      }
      for (const toolCallId of conversationStateStructure.completedAskQuestionToolCallIds ?? []) {
        state.completedAskQuestionToolCallIds.add(toolCallId);
      }
      if (conversationStateStructure.plans !== undefined) {
        for (const [planId, redactedEntry] of conversationStateStructure.plans) {
          state.plans.set(planId, fromRedactedPlanRegistryEntry(redactedEntry, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined));
        }
      }
      if (conversationStateStructure.goalState !== undefined) {
        state.goalState = fromRedactedGoalState(conversationStateStructure.goalState, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined);
      }
      const restoreDurationMs = performance.now() - restoreStart;
      const crossedLargeThreshold = rootPromptBytes >= LARGE_RESTORE_TOTAL_BYTES || rootPromptImageBytes >= LARGE_RESTORE_IMAGE_BYTES || restoreDurationMs >= SLOW_RESTORE_DURATION_MS;
      recordConversationStateRestoreMetrics({
        context: span.ctx,
        restoreDurationMs,
        rootPromptPhaseMs,
        fileStatesPhaseMs,
        subagentStateRefsPhaseMs,
        rootPromptMessageCount,
        turnReferenceCount: conversationStateStructure.turns.length,
        fileStatePathCount: fileStateEntries.length,
        rootPromptBytes,
        restoreBlobFetchConcurrency,
        crossedLargeThreshold,
      });
      if (crossedLargeThreshold) {
        const mem = process.memoryUsage();
        _logger3.warn(span.ctx, "Large conversation state restore", {
          restoreDurationMs,
          rootPromptBytes,
          rootPromptImageBytes,
          rootPromptImagePartCount,
          rootPromptMessageCount,
          turnReferenceCount: conversationStateStructure.turns.length,
          fileStateCount: fileStateEntries.length,
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          external: mem.external,
          arrayBuffers: mem.arrayBuffers,
        });
      }
      return state;
    } catch (e_1) {
      env_1.error = e_1;
      env_1.hasError = true;
      throw e_1;
    } finally {
      __disposeResources19(env_1);
    }
  }

  constructor(
    blobStore: BlobStore<OperationContext>,
    conversationStateStructure: RedactedConversationStateStructure,
    rootPromptBuilder: RestoreRootPromptBuilder,
    formattingOptions: unknown,
    modelId: string | undefined,
    options2?: ConversationStateRestoreOptions,
  ) {
    this.blobStore = blobStore;
    this.conversationStateStructure = conversationStateStructure;
    this.rootPromptBuilder = rootPromptBuilder;
    this.formattingOptions = formattingOptions;
    this.modelId = modelId;
    this.agentTypeChangedFromPersistedState = false;
    this.isRootProjectConversation = false;
    this.plans = new Map();
    this.fileStates = new Map();
    this.readPaths = new Set();
    this.completedAskQuestionToolCallIds = new Set();
    this.communicateUpdateHistory = [];
    this.communicateUpdateStatesByParentToolCallId = new Map();
    this.backgroundSummarizationPromiseInfo = null;
    this.messagesUndergoingSummarization = null;
    this.backgroundSummarizationHasCompleted = false;
    this.backgroundSummarizationGenerationDurationMs = null;
    this.backgroundSummarizationCancellationToken = null;
    this.tokenDetailsStaleAfterSummarization = false;
    this.summaryArchives = [];
    this.selfSummaryCount = 0;
    this.selfSummaryInputLimitFailureTokenCount = 0;
    this.trackedGitRepoBranches = [];
    this.subagentStates = new Map();
    this.subagentRunsByParentToolCallId = new Map();
    this.subagentThreads = new Map();
    this.lastSubagentByType = new Map();
    this.turnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    this.pendingComputeStructure = null;
    this.skippedRootPromptBlobs = false;
    this.originalRootPromptMessagesJson = [];
    this.rootPromptPrefixInvalidated = false;
    this.userTurnMessageIdsIndexedTurnCount = 0;
    this.privacyMode = this.conversationStateStructure._privacyMode;
    this.serdes = createRedactedSerdes(this.privacyMode);
    this.serializeSubagentStatesAsBlobRefs = options2?.serializeSubagentStatesAsBlobRefs === true;
    this.restoreBlobFetchConcurrency = options2?.restoreBlobFetchConcurrency ?? RESTORE_BLOB_FETCH_CONCURRENCY;
    this.previousWorkspaceUris = this.conversationStateStructure.previousWorkspaceUris.length > 0 ? [...this.conversationStateStructure.previousWorkspaceUris] : undefined;
    this.trackedGitRepoBranches = (this.conversationStateStructure.trackedGitRepoBranches ?? []).map((repo) => ({
      repoPath: repo.repoPath.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      branchName: repo.branchName,
    }));
    this.mode = this.conversationStateStructure.mode;
    this.agentType = parseAgentType(this.conversationStateStructure.agentType);
    this.activeBranchName = this.conversationStateStructure.activeBranchName;
    this.isRootProjectConversation = this.conversationStateStructure.isRootProjectConversation === true;
    this.conversationStartedTimestampMs = this.conversationStateStructure.conversationStartedTimestampMs;
    this.conversationStartedTimeZone = this.conversationStateStructure.conversationStartedTimeZone;
    const conversationTurnHandleSerde = this.createConversationTurnHandleSerde();
    this.turns = this.conversationStateStructure.turns.map((blobId) => new LazyReference(conversationTurnHandleSerde, this.blobStore, blobId));
    this.todos = this.conversationStateStructure.todos.map((blobId) => new LazyReference(this.serdes.todoItem, this.blobStore, blobId));
    this.tokenDetails = this.conversationStateStructure.tokenDetails ?? createRedactedConversationTokenDetails(this.conversationStateStructure._privacyMode, {});
    if (this.conversationStateStructure.summary !== undefined) {
      this.summary = new LazyReference(this.serdes.conversationSummary, this.blobStore, this.conversationStateStructure.summary);
    }
    if (this.conversationStateStructure.plan !== undefined) {
      this.plan = new LazyReference(this.serdes.conversationPlan, this.blobStore, this.conversationStateStructure.plan);
    }
    if (this.conversationStateStructure.summaryArchives.length > 0) {
      this.summaryArchives = this.conversationStateStructure.summaryArchives.map((blobId) => new LazyReference(this.serdes.conversationSummaryArchive, this.blobStore, blobId));
    }
    this.selfSummaryCount = this.conversationStateStructure.selfSummaryCount ?? 0;
    if (this.conversationStateStructure.subagentStates !== undefined) {
      for (const [subagentId, redactedState] of this.conversationStateStructure.subagentStates) {
        this.subagentStates.set(subagentId, fromRedactedSubagentPersistedState(redactedState, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined));
      }
    }
    if (this.conversationStateStructure.subagentRunsByParentToolCallId !== undefined) {
      for (const [parentToolCallId, redactedState] of this.conversationStateStructure.subagentRunsByParentToolCallId) {
        this.subagentRunsByParentToolCallId.set(parentToolCallId, fromRedactedSubagentRunState(redactedState, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined));
      }
    }
    const persistedSubagentThreads = this.conversationStateStructure.subagentThreads;
    if (persistedSubagentThreads instanceof Map) {
      for (const [subagentId, threadId] of persistedSubagentThreads) {
        const normalizedThreadId = normalizeNonEmptyString(threadId);
        if (normalizedThreadId !== undefined) this.subagentThreads.set(subagentId, normalizedThreadId);
      }
    } else if (persistedSubagentThreads !== undefined) {
      for (const [subagentId, threadId] of Object.entries(persistedSubagentThreads)) {
        const normalizedThreadId = normalizeNonEmptyString(threadId);
        if (normalizedThreadId !== undefined) this.subagentThreads.set(subagentId, normalizedThreadId);
      }
    }
    const legacyCommunicateUpdateHistory = (this.conversationStateStructure.communicateUpdateHistory ?? []).map((entry) => new CommunicateUpdateHistoryEntry({
      step: entry.step.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      messageIndex: entry.messageIndex,
    }));
    this.communicateUpdateFinalSummary = this.conversationStateStructure.communicateUpdateFinalSummary?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    this.communicateUpdateCompletedSubtitle = this.conversationStateStructure.communicateUpdateCompletedSubtitle?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    this.communicateUpdateHistory = legacyCommunicateUpdateHistory;
    const persistedCommunicateUpdateStatesByParentToolCallId = this.conversationStateStructure.communicateUpdateStatesByParentToolCallId;
    if (persistedCommunicateUpdateStatesByParentToolCallId instanceof Map) {
      for (const [parentToolCallId, state] of persistedCommunicateUpdateStatesByParentToolCallId) {
        this.communicateUpdateStatesByParentToolCallId.set(parentToolCallId, new CommunicateUpdateTurnState({ ...toCommunicateUpdateTurnState(state) }));
      }
    } else if (persistedCommunicateUpdateStatesByParentToolCallId !== undefined) {
      for (const [parentToolCallId, state] of Object.entries(persistedCommunicateUpdateStatesByParentToolCallId)) {
        this.communicateUpdateStatesByParentToolCallId.set(parentToolCallId, new CommunicateUpdateTurnState({ ...toCommunicateUpdateTurnState(state) }));
      }
    }
    this.computeSubagentTrackingFromTimestamps();
  }

  async createAgentTurn(
    parentCtx: OperationContext,
    userMessage: UserMessage,
    requestContext: CreateAgentTurnRequestContext,
    config3: CreateAgentTurnConfig,
    resourceAccessor: CreateAgentTurnResourceAccessor | undefined,
    options2?: CreateAgentTurnOptions,
  ): Promise<AgentConversationTurnHandle> {
    const env_3: DisposableEnvironment = { stack: [], error: undefined, hasError: false };
    try {
      const span = createSpan(parentCtx.withName("createAgentTurn"));
      __addDisposableResource19(env_3, span, false);
      const ctx = span.ctx;
      if (userMessage.isSimulatedMsg !== true) {
        this.resetSelfSummaryCount();
      }
      const projectSubagentDetails = userMessage.projectDetails?.subagent;
      const projectSideChatDetails = userMessage.projectDetails?.sideChat;
      const isRootProjectMessage = userMessage.projectDetails !== undefined && projectSubagentDetails === undefined && projectSideChatDetails === undefined;
      if (isRootProjectMessage) {
        this.isRootProjectConversation = true;
      }
      this.getOrInitializeConversationStartedDate(requestContext.env?.timeZone);
      const sendMessageEnabled = isProjectSendMessageEnabled(this);
      const isProject = isRootProjectMessage;
      const isProjectKickoff = isProject && (options2?.isProjectKickoff ?? this.turns.length === 0);
      const projectName = isProjectKickoff ? normalizeProjectName(unwrapPossiblyRedactedCodeString(userMessage.projectDetails?.name)) : undefined;
      const projectChildName = projectSubagentDetails !== undefined || projectSideChatDetails !== undefined
        ? normalizeProjectName(unwrapPossiblyRedactedCodeString(userMessage.projectDetails?.name))
        : undefined;
      const skipPreTurnStateSnapshot = config3.featureFlags?.skipPreTurnStateSnapshot === true;
      const overlapPreTurnStateSnapshot = !skipPreTurnStateSnapshot && config3.featureFlags?.overlapPreTurnStateSnapshot === true;
      const stateSnapshotStart = performance.now();
      let stateSnapshotCompletedAt = stateSnapshotStart;
      const stateBeforeMessageBlobIdPromise = skipPreTurnStateSnapshot
        ? Promise.resolve(undefined)
        : (async (): Promise<Uint8Array> => {
          const stateBeforeMessage = await this.computeNewStructure(ctx);
          const stateBeforeMessageBytes = conversationStateStructureSerde.serialize(
            fromRedactedConversationStateStructure(stateBeforeMessage, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
          );
          const stateBeforeMessageBlobId = await getBlobId(stateBeforeMessageBytes);
          stateSnapshotCompletedAt = performance.now();
          stateSnapshotDuration.histogram(ctx, stateSnapshotCompletedAt - stateSnapshotStart, {
            overlap: overlapPreTurnStateSnapshot ? "true" : "false",
          });
          getBlobMetadataCallback(this.blobStore)?.({
            blobId: stateBeforeMessageBlobId,
            blobType: { kind: "proto", typeName: "agent.v1.RedactedConversationStateStructure" },
          });
          void this.blobStore.setBlob(ctx, stateBeforeMessageBlobId, stateBeforeMessageBytes);
          return stateBeforeMessageBlobId;
        })();
      const overlappingTurnPreparationStart = performance.now();
      if (overlapPreTurnStateSnapshot) {
        void stateBeforeMessageBlobIdPromise.catch(() => undefined);
      }
      let stateBeforeMessageBlobId: Uint8Array | undefined;
      if (!overlapPreTurnStateSnapshot) {
        stateBeforeMessageBlobId = await stateBeforeMessageBlobIdPromise;
      }
      userMessage = new UserMessage({ ...userMessage });
      if (stateBeforeMessageBlobId !== undefined) {
        userMessage.conversationStateBlobId = new Uint8Array(stateBeforeMessageBlobId);
      }
      if (!overlapPreTurnStateSnapshot && userMessage.projectDetails !== undefined) {
        const nameToKeep = projectName ?? projectChildName;
        if (nameToKeep !== undefined) {
          userMessage.projectDetails.name = nameToKeep;
        } else {
          delete userMessage.projectDetails.name;
        }
      }
      await this.hydrateUserMessageBlobText(ctx, userMessage);
      const modeForContextProcessing = resolveCurrentTurnMode(this.mode, userMessage.mode);
      const { userContent, selectedImages, selectedVideos, selectedDocuments, imageFilePaths } = await processSelectedContext(
        ctx,
        userMessage.selectedContext ?? new SelectedContext(),
        this.blobStore,
        config3,
        requestContext,
        resourceAccessor,
        modeForContextProcessing,
        this.modelId,
        userMessage.text,
        userMessage.simulatedMsgReason!,
        this.privacyMode,
      );
      if (overlapPreTurnStateSnapshot) {
        const snapshotJoinStart = performance.now();
        stateBeforeMessageBlobId = await stateBeforeMessageBlobIdPromise;
        snapshotJoinWaitDuration.histogram(ctx, performance.now() - snapshotJoinStart);
        overlapSavedDuration.histogram(ctx, Math.max(0, Math.min(stateSnapshotCompletedAt, snapshotJoinStart) - overlappingTurnPreparationStart));
        if (stateBeforeMessageBlobId !== undefined) {
          userMessage.conversationStateBlobId = new Uint8Array(stateBeforeMessageBlobId);
        }
        if (userMessage.projectDetails !== undefined) {
          const nameToKeep = projectName ?? projectChildName;
          if (nameToKeep !== undefined) {
            userMessage.projectDetails.name = nameToKeep;
          } else {
            delete userMessage.projectDetails.name;
          }
        }
      }
      if (imageFilePaths.length > 0 && config3.enableImageFiles) {
        const imageFilePathsText = `<image_files>
The following images were provided by the user and saved to the workspace for future use:
${imageFilePaths.map((path29, i) => `${i + 1}. ${path29}`).join("\n")}

These images can be copied for use in other locations.
</image_files>`;
        userContent.push({ type: "text", text: imageFilePathsText });
      }
      let previousMode: AgentMode | undefined;
      if (this.turns.length > 0) {
        previousMode = this.mode;
      }
      const previousAgentType = this.hasAgentTypeChangedFromPersistedState() === true
        ? parseAgentType(this.conversationStateStructure.agentType)
        : this.agentType;
      const workspaceUris = extractWorkspaceUris(parentCtx, requestContext);
      const workspaceReminder = processWorkspaceChangeReminder(
        parentCtx,
        workspaceUris.map((uri) => uri.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)),
        this.previousWorkspaceUris?.map((uri) => uri.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)),
        this.agentType,
        previousAgentType,
      );
      if (workspaceReminder) {
        const needsNewline = userContent.length > 0;
        userContent.push({ type: "text", text: needsNewline ? `\n\n${workspaceReminder}` : workspaceReminder });
      }
      this.previousWorkspaceUris = workspaceUris.length > 0 ? [...workspaceUris] : undefined;
      const currentTrackedGitRepoBranches = toTrackedGitRepoBranches(requestContext.gitRepos);
      if (config3.featureFlags?.enableTrackedGitRepoState === true) {
        const branchReminder = buildTrackedGitRepoBranchReminder(
          this.trackedGitRepoBranches,
          requestContext.gitRepos,
          config3.featureFlags.enhancedBranchChangeReminder === true,
        );
        if (branchReminder) {
          const needsNewline = userContent.length > 0;
          userContent.push({ type: "text", text: needsNewline ? `\n\n${branchReminder}` : branchReminder });
        }
      }
      this.trackedGitRepoBranches = currentTrackedGitRepoBranches;
      const currentModeForReminder = resolveCurrentTurnMode(this.mode, userMessage.mode);
      const modeReminder = processModeSystemReminder(currentModeForReminder, config3, requestContext, previousMode);
      const shouldSuppressFirstTurnMultitaskEnterReminderInUserContent = this.turns.length === 0 && config3.userInfoDisplayOptions?.disable !== true && currentModeForReminder === AgentMode.MULTITASK;
      const projectSubagentStoreDir = unwrapPossiblyRedactedCodeString(projectSubagentDetails?.storeDir);
      const projectSubagentId = getConversationId(ctx);
      const isProjectThreadFirstMessage = options2?.isProjectKickoff ?? this.turns.length === 0;
      const projectSubagentPrompt = projectSubagentDetails !== undefined && projectSubagentId !== undefined && isProjectThreadFirstMessage
        ? (() => {
          const projectPromptText = config3.projectPromptTextGenerator?.();
          return formatProjectThreadPrompt({
            ...(projectChildName !== undefined ? { projectName: projectChildName } : {}),
            storeDir: projectSubagentStoreDir!,
            subagentId: projectSubagentId,
            ...(projectPromptText !== undefined ? { promptText: projectPromptText } : {}),
          });
        })()
        : projectSubagentStoreDir !== undefined && projectSubagentId !== undefined
          ? formatProjectSubagentPrompt({ storeDir: projectSubagentStoreDir, subagentId: projectSubagentId })
          : undefined;
      const projectSideChatStoreDir = unwrapPossiblyRedactedCodeString(projectSideChatDetails?.storeDir);
      const projectSideChatPrompt = projectSideChatStoreDir !== undefined
        ? (() => {
          const projectPromptText = config3.projectPromptTextGenerator?.();
          return formatProjectSideChatPrompt({
            ...(projectChildName !== undefined ? { projectName: projectChildName } : {}),
            storeDir: projectSideChatStoreDir,
            ...(projectPromptText !== undefined ? { promptText: projectPromptText } : {}),
          });
        })()
        : undefined;
      const projectChildPrompt = projectSubagentPrompt ?? projectSideChatPrompt;
      const projectPrompt = isProject
        ? (() => {
          const projectPromptText = config3.projectPromptTextGenerator?.();
          return `<system_reminder>\n${formatProjectPrompt(isProjectKickoff ? "initial" : "reminder", {
            ...(projectName !== undefined ? { projectName } : {}),
            ...(projectPromptText !== undefined ? { promptText: projectPromptText } : {}),
            sendMessageEnabled,
            coordinatorToolsEnabled: config3.featureFlags?.cloudCoordinatorToolsEnabled === true,
          })}\n</system_reminder>`;
        })()
        : projectChildPrompt !== undefined
          ? `<system_reminder>\n${projectChildPrompt}\n</system_reminder>`
          : "";
      const userTurnSystemReminder = joinUserTurnSystemReminders(
        options2?.additionalUserTurnSystemReminder ?? "",
        processAntiAskQuestionSystemReminder(config3),
        shouldSuppressFirstTurnMultitaskEnterReminderInUserContent ? "" : modeReminder,
        projectPrompt,
      );
      if (userTurnSystemReminder) {
        const needsNewline = userContent.length > 0;
        userContent.push({ type: "text", text: needsNewline ? `\n\n${userTurnSystemReminder}` : userTurnSystemReminder });
      }
      const subagentReminder = userMessage.subagentSystemReminder !== undefined && userMessage.subagentSystemReminder !== ""
        ? `<system_reminder>\n${userMessage.subagentSystemReminder}\n</system_reminder>`
        : "";
      if (subagentReminder) {
        const needsNewline = userContent.length > 0;
        userContent.push({ type: "text", text: needsNewline ? `\n\n${subagentReminder}` : subagentReminder });
      }
      const previousAgentTurn = await getPreviousAgentConversationTurn(ctx, this.turns);
      const previousModelMcid = previousAgentTurn !== undefined ? decryptTurnModelMcid(previousAgentTurn, config3.decryptMcidAndParams) : undefined;
      const currentModelMcid = config3.model?.mcid;
      const skipBetweenTurnReminders = userMessage.simulatedMsgReason === SimulatedMsgReason.BACKGROUND_TASK_COMPLETION;
      if (!skipBetweenTurnReminders && previousModelMcid !== undefined && previousModelMcid.length > 0 && currentModelMcid !== undefined && currentModelMcid.length > 0 && config3.encryptedMcidAndParams !== undefined && config3.encryptedMcidAndParams.length > 0 && previousModelMcid !== currentModelMcid) {
        const needsNewline = userContent.length > 0;
        userContent.push({ type: "text", text: needsNewline ? `\n\n${MODEL_SWITCH_REMINDER}` : MODEL_SWITCH_REMINDER });
      }
      const currentDynamicToolCount = options2?.dynamicToolCount;
      const dynamicToolMetaNames = options2?.dynamicToolMetaNames;
      if (!skipBetweenTurnReminders && currentDynamicToolCount !== undefined && currentDynamicToolCount > 0 && dynamicToolMetaNames !== undefined) {
        const previousDynamicToolCount = await getPreviousRecordedDynamicToolCount(ctx, this.turns);
        if (previousDynamicToolCount === 0) {
          const reminder = buildDynamicToolsEnabledReminder(dynamicToolMetaNames);
          const needsNewline = userContent.length > 0;
          userContent.push({ type: "text", text: needsNewline ? `\n\n${reminder}` : reminder });
        }
      }
      const recentlyAddedPluginReminder = buildRecentlyAddedPluginReminder(requestContext.recentlyAddedPlugin);
      if (recentlyAddedPluginReminder) {
        const needsNewline = userContent.length > 0;
        userContent.push({ type: "text", text: needsNewline ? `\n\n${recentlyAddedPluginReminder}` : recentlyAddedPluginReminder });
      }
      const enableHookAdditionalContext = config3.featureFlags?.enableHookAdditionalContext === true;
      const enableAgentStoreConflictNotices = config3.featureFlags?.enableAgentStoreConflictNotices === true;
      if (enableHookAdditionalContext || enableAgentStoreConflictNotices) {
        const contexts = enableHookAdditionalContext
          ? userMessage.hookAdditionalContexts
          : userMessage.hookAdditionalContexts.filter((context) => context.hookEventName === "agentStoreConflict");
        for (const hookAdditionalContext of contexts) {
          const hookAdditionalContextReminder = renderHookAdditionalContextSystemReminder(hookAdditionalContext.content);
          if (hookAdditionalContextReminder) {
            const needsNewline = userContent.length > 0;
            userContent.push({ type: "text", text: needsNewline ? `\n\n${hookAdditionalContextReminder}` : hookAdditionalContextReminder });
          }
        }
      }
      const eagerEditingNote = config3.isEagerEditingModel === true
        ? `<system_reminder>\nIMPORTANT: It is bad to be over-eager with making edits vs just answering the question when that is not what the user wants. Think carefully before deciding to edit.\n</system_reminder>\n`
        : "";
      const currentTimePrefix = config3.featureFlags?.userMessageTimestamps === true ? buildTimestampPrefix(requestContext.env?.timeZone) : "";
      const promptReferenceIdResolution = resolvePromptReferenceId(config3.featureFlags?.glassMetaParentAgent === true, userMessage.promptReferenceId, userMessage.messageId, userContent);
      if (promptReferenceIdResolution.shouldIncludePromptReferenceIdTag && promptReferenceIdResolution.promptReferenceId !== undefined) {
        userContent.unshift({ type: "text", text: renderUserMessageIdTag(promptReferenceIdResolution.promptReferenceId) });
      }
      const incomingMessageIdTag = sendMessageEnabled && shouldExposeIncomingMessageId({
        isSimulatedMsg: userMessage.isSimulatedMsg === true,
        simulatedMsgReason: userMessage.simulatedMsgReason ?? SimulatedMsgReason.UNSPECIFIED,
        text: userMessage.text,
      }) ? renderIncomingMessageIdTag(userMessage.messageId) : undefined;
      if (incomingMessageIdTag !== undefined) {
        userContent.unshift({ type: "text", text: incomingMessageIdTag });
      }
      const isNotificationOnlyText = isNotificationOnlyUserMessage({ role: "user", content: userMessage.text });
      userContent.push({
        type: "text",
        text: isNotificationOnlyText ? `${currentTimePrefix}${userMessage.text}` : `${currentTimePrefix}<user_query>\n${eagerEditingNote}${userMessage.text}\n</user_query>`,
      });
      const promptReferenceId = !promptReferenceIdResolution.hasStructuredPromptReferenceId && promptReferenceIdResolution.promptReferenceId !== undefined
        ? promptReferenceIdResolution.promptReferenceId
        : userMessage.promptReferenceId;
      const threadId = resolveUserMessageThreadId({
        ...(userMessage.threadId !== undefined ? { threadId: userMessage.threadId } : {}),
        ...(promptReferenceId !== undefined ? { promptReferenceId } : {}),
        messageId: userMessage.messageId,
      });
      const storedSelectedDocuments = this.privacyMode === PrivacyModes.NO_STORAGE ? [] : selectedDocuments;
      const storedSelectedVideos = this.privacyMode === PrivacyModes.NO_STORAGE ? [] : selectedVideos;
      userMessage = new UserMessage({
        ...userMessage,
        ...(promptReferenceId !== undefined ? { promptReferenceId } : {}),
        selectedContext: new SelectedContext({
          ...userMessage.selectedContext,
          selectedDocuments: storedSelectedDocuments,
          selectedImages,
          selectedVideos: storedSelectedVideos,
        }),
      });
      if (threadId !== undefined) {
        userMessage.threadId = threadId;
      }
      const requestId2 = getRequestId(ctx);
      const message = {
        role: "user",
        content: userContent,
        ...(requestId2 !== undefined ? { providerOptions: { cursor: { requestId: requestId2 } } } : {}),
      };
      const redactedMessage = toRedactedCoreMessage(message, this.privacyMode);
      coreToRedactedMap.set(message, redactedMessage);
      if (userMessage.simulatedMsgReason !== SimulatedMsgReason.BACKGROUND_TASK_COMPLETION) {
        this.rootPromptBuilder.appendMessages(redactedMessage);
      }
      const redactedUserMessage = toRedactedUserMessage(userMessage, this.privacyMode);
      const userMessageBlobStart = performance.now();
      const serializedUserMessage = this.serdes.userMessage.serialize(redactedUserMessage);
      const userMessageBlobId = await getBlobId(serializedUserMessage);
      getBlobMetadataCallback(this.blobStore)?.({
        blobId: userMessageBlobId,
        blobType: { kind: "proto", typeName: "agent.v1.UserMessage" },
      });
      await this.blobStore.setBlob(ctx, userMessageBlobId, serializedUserMessage);
      userMessageBlobDuration.histogram(ctx, performance.now() - userMessageBlobStart);
      const inner = new AgentConversationTurnStructure({
        userMessage: new Uint8Array(userMessageBlobId),
        steps: [],
        requestId: requestId2!,
        encryptedModel: config3.encryptedMcidAndParams!,
        ...(currentDynamicToolCount !== undefined ? { dynamicToolCount: currentDynamicToolCount } : {}),
      });
      const turn = new AgentConversationTurnHandle(this.blobStore, this.serdes, this.privacyMode, inner, this.rootPromptBuilder);
      this.turns.push(new EagerReference({
        deserialize: (blob) => {
          const outer = conversationTurnStructureSerde2.deserialize(blob);
          if (outer.turn.case !== "agentConversationTurn") {
            throw new Error("Expected agent turn");
          }
          return new AgentConversationTurnHandle(this.blobStore, this.serdes, this.privacyMode, outer.turn.value, this.rootPromptBuilder);
        },
        serialize: (value) => value.serialize(),
      }, this.blobStore, turn));
      if (this.userTurnMessageIdsIndex !== undefined) {
        if (userMessage.messageId.length > 0) {
          this.userTurnMessageIdsIndex.add(userMessage.messageId);
        }
        this.userTurnMessageIdsIndexedTurnCount = this.turns.length;
      }
      return turn;
    } catch (error) {
      env_3.error = error;
      env_3.hasError = true;
    } finally {
      __disposeResources19(env_3);
    }
    throw new Error("Unreachable createAgentTurn completion");
  }

  computeSubagentTrackingFromTimestamps(): void {
    const result = computeSubagentTracking(this.subagentStates);
    this.lastUsedSubagentId = result.lastUsedSubagentId;
    this.lastSubagentByType = result.lastSubagentByType;
  }

  async loadSubagentStateRefs(ctx: OperationContext): Promise<void> {
    const subagentStateRefs = this.conversationStateStructure.subagentStateRefs;
    if (subagentStateRefs === undefined || subagentStateRefs.size === 0) return;
    const loadedEntries = await asyncMapValues(Array.from(subagentStateRefs.entries()), async ([subagentId, blobId]) => {
      const blob = await this.blobStore.getBlob(ctx, blobId);
      if (!blob) {
        if (!this.subagentStates.has(subagentId)) return { kind: "missing" as const, blobIdHex: toHex(blobId) };
        _logger3.warn(ctx, "Subagent state ref blob not found; falling back to inline entry", { subagentId });
        return { kind: "fallback" as const };
      }
      try {
        const redactedState = this.serdes.subagentPersistedState.deserialize(blob);
        const state = fromRedactedSubagentPersistedState(redactedState, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined);
        return { kind: "loaded" as const, subagentId, state, blobId, blobData: blob };
      } catch (error4) {
        return { kind: "failed" as const, error: error4 };
      }
    }, { max: this.restoreBlobFetchConcurrency });
    const missingBlobIdHexes = loadedEntries.flatMap((entry) => entry.kind === "missing" ? [entry.blobIdHex] : []);
    if (missingBlobIdHexes.length > 0) throw new BlobNotFoundError(missingBlobIdHexes);
    const firstFailedLoad = loadedEntries.find((entry) => entry.kind === "failed");
    if (firstFailedLoad !== undefined && firstFailedLoad.kind === "failed") throw firstFailedLoad.error;
    for (const entry of loadedEntries) {
      if (entry.kind === "loaded") {
        serializedSubagentStateCache.set(entry.state, { blobId: entry.blobId, blobData: entry.blobData });
        this.subagentStates.set(entry.subagentId, entry.state);
      }
    }
    this.computeSubagentTrackingFromTimestamps();
  }

  isDsv3(): boolean {
    return isCursorBigModel(this.modelId);
  }

  getOrInitializeConversationStartedDate(timeZone?: string): string {
    if (this.conversationStartedTimestampMs !== undefined) {
      if (this.conversationStartedTimeZone === undefined) {
        throw new Error("conversationStartedTimestampMs was set without conversationStartedTimeZone");
      }
      return buildDateStringForTimestampMs(this.conversationStartedTimestampMs, this.conversationStartedTimeZone);
    }
    if (this.conversationStartedTimeZone !== undefined) {
      throw new Error("conversationStartedTimeZone was set without conversationStartedTimestampMs");
    }
    const conversationStartedTimestampMs = BigInt(Date.now());
    const conversationStartedTimeZone = resolveConversationStartTimeZone(timeZone);
    const conversationStartedDate = buildDateStringForTimestampMs(conversationStartedTimestampMs, conversationStartedTimeZone);
    this.conversationStartedTimestampMs = conversationStartedTimestampMs;
    this.conversationStartedTimeZone = conversationStartedTimeZone;
    return conversationStartedDate;
  }

  setTodos(todos: readonly unknown[]): void {
    this.todos.length = 0;
    this.todos.push(...todos.map((todo) => new EagerReference(this.serdes.todoItem, this.blobStore, todo)));
  }

  setSummary(summary: unknown): void {
    this.summary = new EagerReference(this.serdes.conversationSummary, this.blobStore, summary);
  }

  pushSummaryArchive(summaryArchive: unknown): void {
    this.summaryArchives.push(new EagerReference(this.serdes.conversationSummaryArchive, this.blobStore, summaryArchive));
  }

  incrementSelfSummaryCount(): void {
    this.selfSummaryCount++;
    this.clearSelfSummaryInputLimitFailureTokenCount();
  }

  resetSelfSummaryCount(): void {
    this.selfSummaryCount = 0;
  }

  setSelfSummaryInputLimitFailureTokenCount(tokens: number): void {
    this.selfSummaryInputLimitFailureTokenCount = tokens;
  }

  clearSelfSummaryInputLimitFailureTokenCount(): void {
    this.selfSummaryInputLimitFailureTokenCount = 0;
  }

  shouldSuppressSelfSummaryAfterInputLimitFailure(usedTokens: number): boolean {
    return this.selfSummaryInputLimitFailureTokenCount !== 0 && usedTokens >= this.selfSummaryInputLimitFailureTokenCount;
  }

  setPlan(plan: unknown | undefined): void {
    this.plan = plan !== undefined ? new EagerReference(this.serdes.conversationPlan, this.blobStore, plan) : undefined;
  }

  async getPlan(ctx: OperationContext): Promise<unknown | undefined> {
    if (this.plan === undefined) return undefined;
    return await this.plan.get(ctx);
  }

  upsertPlanEntry(entry: PlanRegistryEntry): void {
    this.plans.set(entry.id, entry);
  }

  setGoalState(goalState: GoalState): void {
    this.goalState = goalState;
  }

  recordFileState(path29: string, content: string | undefined, prevContent: string | undefined, skipReprioritization?: boolean): void {
    recordFileStateInMap(this.fileStates, this.blobStore, path29, content, prevContent, skipReprioritization);
  }

  async getFileState(ctx: OperationContext, path29: string): Promise<string | undefined> {
    const contentRef = this.fileStates.get(path29)?.content;
    if (contentRef === undefined) return undefined;
    return contentRef.get(ctx);
  }

  async hydrateUserMessageBlobText(ctx: OperationContext, userMessage: UserMessageBlobHydrationTarget): Promise<void> {
    const [textBytes, richTextBytes] = await Promise.all([
      userMessage.text.length === 0 && userMessage.textBlobId !== undefined && userMessage.textBlobId.length > 0
        ? this.blobStore.getBlob(ctx, userMessage.textBlobId)
        : Promise.resolve(undefined),
      (userMessage.richText === undefined || userMessage.richText.length === 0) && userMessage.richTextBlobId !== undefined && userMessage.richTextBlobId.length > 0
        ? this.blobStore.getBlob(ctx, userMessage.richTextBlobId)
        : Promise.resolve(undefined),
    ]);
    if (textBytes !== undefined) {
      userMessage.text = textDecoder2.decode(textBytes);
    } else if (userMessage.text.length === 0 && userMessage.textBlobId !== undefined && userMessage.textBlobId.length > 0) {
      _logger3.warn(ctx, "Failed to hydrate user message text blob", {
        textBlobIdLength: userMessage.textBlobId.length,
      });
    }
    if (richTextBytes !== undefined) {
      userMessage.richText = textDecoder2.decode(richTextBytes);
    } else if ((userMessage.richText === undefined || userMessage.richText.length === 0) && userMessage.richTextBlobId !== undefined && userMessage.richTextBlobId.length > 0) {
      _logger3.warn(ctx, "Failed to hydrate user message rich text blob", {
        richTextBlobIdLength: userMessage.richTextBlobId.length,
      });
    }
  }

  async getLastUserPromptText(ctx: OperationContext): Promise<string | undefined> {
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const turn = await this.turns[i]!.get(ctx);
      if (turn instanceof AgentConversationTurnHandle) {
        const userMessage = await turn.userMessage.get(ctx);
        if (userMessage.isSimulatedMsg !== true) {
          return userMessage.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
        }
      }
    }
    return undefined;
  }

  async syncUserTurnMessageIdsIndex(ctx: OperationContext): Promise<Set<string>> {
    if (this.userTurnMessageIdsIndex === undefined) {
      this.userTurnMessageIdsIndex = new Set();
      this.userTurnMessageIdsIndexedTurnCount = 0;
    }
    if (this.userTurnMessageIdsIndexedTurnCount > this.turns.length) {
      this.userTurnMessageIdsIndex.clear();
      this.userTurnMessageIdsIndexedTurnCount = 0;
    }
    for (let i = this.userTurnMessageIdsIndexedTurnCount; i < this.turns.length; i += 1) {
      const turn = await this.turns[i]!.get(ctx);
      if (!(turn instanceof AgentConversationTurnHandle)) continue;
      const userMessage = await turn.userMessage.get(ctx);
      const messageId = userMessage.messageId;
      if (messageId.length > 0) {
        this.userTurnMessageIdsIndex.add(messageId);
      }
    }
    this.userTurnMessageIdsIndexedTurnCount = this.turns.length;
    return this.userTurnMessageIdsIndex;
  }

  async getUserTurnMessageIdsIndex(ctx: OperationContext): Promise<Set<string>> {
    return this.syncUserTurnMessageIdsIndex(ctx);
  }

  async getUserPromptTextsByReferenceId(ctx: OperationContext): Promise<Map<string, string>> {
    const promptTextsByReferenceId = new Map<string, string>();
    for (const turnRef of this.turns) {
      const turn = await turnRef.get(ctx);
      if (!(turn instanceof AgentConversationTurnHandle)) continue;
      const userMessage = await turn.userMessage.get(ctx);
      if (userMessage.isSimulatedMsg === true) continue;
      const promptReferenceId = userMessage.promptReferenceId;
      if (promptReferenceId === undefined || promptReferenceId.length === 0 || promptTextsByReferenceId.has(promptReferenceId)) continue;
      promptTextsByReferenceId.set(promptReferenceId, userMessage.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED));
    }
    return promptTextsByReferenceId;
  }

  async resolvePromptReferenceUserMessageMatches(
    ctx: OperationContext,
    promptReferenceIds: readonly string[],
  ): Promise<{
    promptReferenceId: string;
    messageId: string;
    threadId: string;
    turnIndex: number;
  }[]> {
    const requestedPromptReferenceIds = new Set(promptReferenceIds.filter((id) => id.length > 0));
    if (requestedPromptReferenceIds.size === 0) return [];
    const seenPromptReferenceIds = new Set<string>();
    const matches: {
      promptReferenceId: string;
      messageId: string;
      threadId: string;
      turnIndex: number;
    }[] = [];
    for (let i = 0; i < this.turns.length; i += 1) {
      const turn = await this.turns[i]!.get(ctx);
      if (!(turn instanceof AgentConversationTurnHandle)) continue;
      const userMessage = await turn.userMessage.get(ctx);
      if (userMessage.isSimulatedMsg === true) continue;
      const promptReferenceId = userMessage.promptReferenceId;
      if (
        promptReferenceId === undefined ||
        promptReferenceId.length === 0 ||
        !requestedPromptReferenceIds.has(promptReferenceId) ||
        seenPromptReferenceIds.has(promptReferenceId)
      ) continue;
      matches.push({
        promptReferenceId,
        messageId: userMessage.messageId,
        threadId: resolveUserMessageThreadId(userMessage) ?? promptReferenceId,
        turnIndex: i,
      });
      seenPromptReferenceIds.add(promptReferenceId);
      if (seenPromptReferenceIds.size >= requestedPromptReferenceIds.size) break;
    }
    return matches;
  }

  async reassignThreadIds(
    ctx: OperationContext,
    sourceThreadIds: ReadonlySet<string>,
    targetThreadId: string,
  ): Promise<void> {
    if (sourceThreadIds.size === 0 || targetThreadId.length === 0) return;
    for (const turnRef of this.turns) {
      const turn = await turnRef.get(ctx);
      if (!(turn instanceof AgentConversationTurnHandle)) continue;
      const userMessage = await turn.userMessage.get(ctx);
      const currentThreadId = getExplicitUserMessageThreadId(userMessage);
      if (currentThreadId !== undefined && sourceThreadIds.has(currentThreadId) && currentThreadId !== targetThreadId) {
        turn.setUserMessage(withUserMessageThreadId(userMessage, targetThreadId));
      }
    }
    for (const [subagentId, threadId] of this.subagentThreads) {
      if (sourceThreadIds.has(threadId) && threadId !== targetThreadId) {
        this.subagentThreads.set(subagentId, targetThreadId);
      }
    }
  }

  async assignPromptReferenceMatchesToThread(
    ctx: OperationContext,
    matches: readonly { turnIndex: number }[],
    threadId: string,
  ): Promise<void> {
    for (const match2 of matches) {
      const turnRef = this.turns[match2.turnIndex];
      if (turnRef === undefined) continue;
      const turn = await turnRef.get(ctx);
      if (!(turn instanceof AgentConversationTurnHandle)) continue;
      const userMessage = await turn.userMessage.get(ctx);
      if (getExplicitUserMessageThreadId(userMessage) === threadId) continue;
      turn.setUserMessage(withUserMessageThreadId(userMessage, threadId));
    }
  }

  async getEarliestTurnIndexByThreadId(
    ctx: OperationContext,
    candidateThreadIds: ReadonlySet<string>,
  ): Promise<Map<string, number>> {
    const earliestTurnIndexByThreadId = new Map<string, number>();
    if (candidateThreadIds.size === 0) return earliestTurnIndexByThreadId;
    for (let i = 0; i < this.turns.length; i += 1) {
      const turn = await this.turns[i]!.get(ctx);
      if (!(turn instanceof AgentConversationTurnHandle)) continue;
      const userMessage = await turn.userMessage.get(ctx);
      const threadId = resolveUserMessageThreadId(userMessage);
      if (threadId === undefined || !candidateThreadIds.has(threadId) || earliestTurnIndexByThreadId.has(threadId)) continue;
      earliestTurnIndexByThreadId.set(threadId, i);
      if (earliestTurnIndexByThreadId.size >= candidateThreadIds.size) break;
    }
    return earliestTurnIndexByThreadId;
  }

  async resolveCanonicalThreadIdForPromptReferenceMatches(
    ctx: OperationContext,
    matches: readonly { readonly threadId: string; readonly turnIndex: number }[],
    additionalThreadIds: readonly string[] = [],
  ): Promise<string | undefined> {
    const orderedThreadIds: string[] = [];
    const addThreadId = (candidate: string | undefined): void => {
      const threadId = normalizeNonEmptyString(candidate);
      if (threadId === undefined || orderedThreadIds.includes(threadId)) return;
      orderedThreadIds.push(threadId);
    };
    for (const threadId of additionalThreadIds) addThreadId(threadId);
    for (const match of matches) addThreadId(match.threadId);
    if (orderedThreadIds.length === 0) return undefined;
    const earliestTurnIndexByThreadId = await this.getEarliestTurnIndexByThreadId(ctx, new Set(orderedThreadIds));
    let canonicalThreadId = orderedThreadIds[0]!;
    let canonicalTurnIndex = earliestTurnIndexByThreadId.get(canonicalThreadId) ?? Infinity;
    for (const threadId of orderedThreadIds.slice(1)) {
      const turnIndex = earliestTurnIndexByThreadId.get(threadId) ?? Infinity;
      if (turnIndex < canonicalTurnIndex || (turnIndex === canonicalTurnIndex && threadId < canonicalThreadId)) {
        canonicalThreadId = threadId;
        canonicalTurnIndex = turnIndex;
      }
    }
    return canonicalThreadId;
  }

  async canonicalizePromptReferenceMatchThreads(args: {
    readonly ctx: OperationContext;
    readonly matches: readonly { readonly threadId: string; readonly turnIndex: number }[];
    readonly canonicalThreadId: string | undefined;
    readonly additionalThreadIds?: readonly string[];
  }): Promise<void> {
    const { ctx, matches, canonicalThreadId, additionalThreadIds = [] } = args;
    const normalizedCanonicalThreadId = normalizeNonEmptyString(canonicalThreadId);
    if (normalizedCanonicalThreadId === undefined) return;
    const sourceThreadIds = new Set<string>();
    for (const threadId of additionalThreadIds) {
      const normalizedThreadId = normalizeNonEmptyString(threadId);
      if (normalizedThreadId !== undefined && normalizedThreadId !== normalizedCanonicalThreadId) {
        sourceThreadIds.add(normalizedThreadId);
      }
    }
    for (const match of matches) {
      if (match.threadId !== normalizedCanonicalThreadId) sourceThreadIds.add(match.threadId);
    }
    await this.reassignThreadIds(ctx, sourceThreadIds, normalizedCanonicalThreadId);
    await this.assignPromptReferenceMatchesToThread(ctx, matches, normalizedCanonicalThreadId);
  }

  async clearTurns(): Promise<void> {
    this.turns.length = 0;
    this.userTurnMessageIdsIndex?.clear();
    this.userTurnMessageIdsIndex = undefined;
    this.userTurnMessageIdsIndexedTurnCount = 0;
  }

  appendCommunicateUpdateHistoryEntry(entry: {
    readonly step: string;
    readonly messageIndex: number;
    readonly parentToolCallId?: string;
    readonly finalSummary?: string;
    readonly completedSubtitle?: string;
  }): void {
    const historyEntry = new CommunicateUpdateHistoryEntry({
      step: entry.step,
      messageIndex: entry.messageIndex,
    });
    const parentToolCallId = normalizeNonEmptyString(entry.parentToolCallId);
    if (parentToolCallId !== undefined) {
      const existingState = this.communicateUpdateStatesByParentToolCallId.get(parentToolCallId);
      const nextHistory = [...existingState?.history ?? [], historyEntry];
      this.communicateUpdateStatesByParentToolCallId.set(parentToolCallId, new CommunicateUpdateTurnState({
        history: nextHistory,
        finalSummary: (entry.finalSummary ?? existingState?.finalSummary)!,
        completedSubtitle: (entry.completedSubtitle ?? existingState?.completedSubtitle)!,
      }));
      return;
    }
    this.communicateUpdateHistory.push(historyEntry);
    if (entry.finalSummary !== undefined) this.communicateUpdateFinalSummary = entry.finalSummary;
    if (entry.completedSubtitle !== undefined) this.communicateUpdateCompletedSubtitle = entry.completedSubtitle;
  }

  getNextMessageIndex(): number {
    const loadedMessageCount = this.rootPromptBuilder.getState().length;
    if (this.skippedRootPromptBlobs) return this.originalRootPromptMessagesJson.length + loadedMessageCount;
    if (loadedMessageCount > 0) return loadedMessageCount;
    return this.conversationStateStructure.rootPromptMessagesJson.length;
  }

  generateModeChangeContent(
    config: ModeProcessingConfig,
    requestContext: ModeProcessingRequestContext,
    previousMode?: AgentMode,
  ): string {
    const currentMode = this.mode;
    if (currentMode === undefined) return "";
    return processModeSystemReminder(currentMode, config, requestContext, previousMode);
  }

  serialize(): Uint8Array {
    return conversationStateStructureSerde.serialize(
      fromRedactedConversationStateStructure(this.conversationStateStructure, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
    );
  }

  async computeNewStructure(parentCtx: OperationContext): Promise<RedactedConversationStateStructure> {
    const previousPending = this.pendingComputeStructure;
    const computation = (async (): Promise<RedactedConversationStateStructure> => {
      if (previousPending) {
        await previousPending.catch(() => undefined);
      }
      return this.doComputeNewStructure(parentCtx);
    })();
    this.pendingComputeStructure = computation;
    return computation;
  }

  private async doComputeNewStructure(parentCtx: OperationContext): Promise<RedactedConversationStateStructure> {
    const env_2: DisposableEnvironment = { stack: [], error: undefined, hasError: false };
    try {
      const span = createSpan(parentCtx.withName("computeNewStructure"));
      __addDisposableResource19(env_2, span, false);
      const ctx = span.ctx;
      const quietCtx = withSuppressedChildSpans(ctx);
      const serializeStart = performance.now();
      let setBlobCount = 0;
      const serializeRootPromptMessages = async (messages: readonly RedactedCoreMessageForSerialization[]): Promise<Uint8Array[]> => {
        const blobIds = await Promise.all(messages.map(async (message) => {
          const cached = serializedMessageCache.get(message);
          if (cached !== undefined) {
            if (!isBlobDurable(this.blobStore, cached.blobId)) {
              await this.blobStore.setBlob(quietCtx, cached.blobId, cached.blobData);
            }
            return cached.blobId;
          }
          let serializedMessage: Uint8Array;
          {
            const startEpochMs = Date.now();
            const start = performance.now();
            serializedMessage = this.serdes.coreMessage.serialize(message);
            const durationMs = performance.now() - start;
            if (durationMs > SERIALIZE_MESSAGE_SLOW_THRESHOLD_MS) {
              recordCompletedSpanIfParented(ctx.withName("serializeMessage.slow"), {
                startTime: startEpochMs,
                attributes: {
                  serializedMessageLength: serializedMessage.length,
                  durationMs,
                  slowThresholdMs: SERIALIZE_MESSAGE_SLOW_THRESHOLD_MS,
                },
              }, startEpochMs + durationMs);
            }
            if (durationMs > 1e4) {
              _logger3.warn(ctx, "Serializing message took more than 10 seconds", {
                serializedMessageLength: serializedMessage.length,
                serializationDuration: durationMs,
              });
            }
          }
          const blobId = await getBlobId(serializedMessage);
          setBlobCount += 1;
          getBlobMetadataCallback(this.blobStore)?.({ blobId, blobType: { kind: "json" } });
          await this.blobStore.setBlob(quietCtx, blobId, serializedMessage);
          serializedMessageCache.set(message, { blobId, blobData: serializedMessage });
          return blobId;
        }));
        return blobIds;
      };
      const rootPromptMessages = this.rootPromptBuilder.getState();
      span.span.setAttribute("rootPromptBlobMode", this.skippedRootPromptBlobs ? "skipped" : "loaded");
      const newRootPromptMessagesJsonPromise = (async (): Promise<Uint8Array[]> => {
        if (!this.skippedRootPromptBlobs) {
          conversationStateComputeRootPromptMode.increment(ctx, 1, { mode: "full" });
          return serializeRootPromptMessages(rootPromptMessages);
        }
        if (this.rootPromptPrefixInvalidated) {
          conversationStateComputeRootPromptMode.increment(ctx, 1, { mode: "invalidated" });
          throw new Error("Cannot compute root prompt pass-through after root prompt prefix was invalidated");
        }
        conversationStateComputeRootPromptMode.increment(ctx, 1, { mode: "passthrough" });
        const appendedRootPromptMessagesJson = await serializeRootPromptMessages(rootPromptMessages);
        return [...this.originalRootPromptMessagesJson, ...appendedRootPromptMessagesJson];
      })();
      const newTurnsPromise = Promise.all(this.turns.map((ref) => {
        setBlobCount += 1;
        return ref.writeToBlobStore(quietCtx);
      }));
      const newTodosPromise = Promise.all(this.todos.map((ref) => {
        setBlobCount += 1;
        return ref.writeToBlobStore(quietCtx);
      }));
      let newSummaryPromise: Promise<Uint8Array> | undefined;
      if (this.summary !== undefined) {
        setBlobCount += 1;
        newSummaryPromise = this.summary.writeToBlobStore(quietCtx);
      }
      let newSummaryArchivesPromise: Promise<Uint8Array[]> | undefined;
      if (this.summaryArchives.length > 0) {
        newSummaryArchivesPromise = Promise.all(this.summaryArchives.map((ref) => {
          setBlobCount += 1;
          return ref.writeToBlobStore(quietCtx);
        }));
      }
      let newPlanPromise: Promise<Uint8Array> | undefined;
      if (this.plan !== undefined) {
        setBlobCount += 1;
        newPlanPromise = this.plan.writeToBlobStore(quietCtx);
      }
      const fileStatesEntriesPromise = Promise.all(Array.from(this.fileStates.entries()).map(async ([path29, fileState]) => {
        let contentBlobIdPromise: Promise<Uint8Array | undefined> = Promise.resolve(undefined);
        if (fileState.content !== undefined) {
          setBlobCount += 1;
          contentBlobIdPromise = fileState.content.writeToBlobStore(quietCtx);
        }
        let initialContentBlobIdPromise: Promise<Uint8Array | undefined> = Promise.resolve(undefined);
        if (fileState.initialContent !== undefined) {
          setBlobCount += 1;
          initialContentBlobIdPromise = fileState.initialContent.writeToBlobStore(quietCtx);
        }
        const [contentBlobId, initialContentBlobId] = await Promise.all([contentBlobIdPromise, initialContentBlobIdPromise]);
        const fileStateStructure = new FileStateStructure({
          content: contentBlobId!,
          initialContent: initialContentBlobId!,
        });
        return [path29, fileStateStructure] as const;
      }));
      const subagentStatesObj: Record<string, SubagentPersistedState> = {};
      const subagentStateRefsObj: Record<string, Uint8Array> = {};
      let subagentStateRefsPromise: Promise<void> | undefined;
      if (this.serializeSubagentStatesAsBlobRefs) {
        subagentStateRefsPromise = Promise.all(Array.from(this.subagentStates.entries()).map(async ([subagentId, state]) => {
          const cached = serializedSubagentStateCache.get(state);
          if (cached !== undefined) {
            if (!isBlobDurable(this.blobStore, cached.blobId)) {
              await this.blobStore.setBlob(quietCtx, cached.blobId, cached.blobData);
            }
            subagentStateRefsObj[subagentId] = cached.blobId;
            return;
          }
          const serialized = this.serdes.subagentPersistedState.serialize(toRedactedSubagentPersistedState(state, this.privacyMode));
          const blobId = await getBlobId(serialized);
          setBlobCount += 1;
          getBlobMetadataCallback(this.blobStore)?.({
            blobId,
            blobType: { kind: "proto", typeName: "agent.v1.SubagentPersistedState" },
          });
          await this.blobStore.setBlob(quietCtx, blobId, serialized);
          serializedSubagentStateCache.set(state, { blobId, blobData: serialized });
          subagentStateRefsObj[subagentId] = blobId;
        })).then(() => undefined);
      } else {
        for (const [subagentId, state] of this.subagentStates) {
          subagentStatesObj[subagentId] = state;
        }
      }
      const subagentRunsByParentToolCallIdObj: Record<string, SubagentRunState> = {};
      for (const [parentToolCallId, state] of this.subagentRunsByParentToolCallId) {
        subagentRunsByParentToolCallIdObj[parentToolCallId] = state;
      }
      const subagentThreadsObj: Record<string, string> = {};
      for (const [subagentId, threadId] of this.subagentThreads) {
        subagentThreadsObj[subagentId] = threadId;
      }
      const communicateUpdateStatesByParentToolCallIdObj: Record<string, CommunicateUpdateTurnState> = {};
      for (const [parentToolCallId, state] of this.communicateUpdateStatesByParentToolCallId) {
        communicateUpdateStatesByParentToolCallIdObj[parentToolCallId] = new CommunicateUpdateTurnState({ ...toCommunicateUpdateTurnState(state) });
      }
      const plansObj: Record<string, { id: string; path: string }> = {};
      for (const [planId, entry] of this.plans) {
        plansObj[planId] = { id: entry.id, path: entry.path };
      }
      await subagentStateRefsPromise;
      const rootPromptMessagesJson = await newRootPromptMessagesJsonPromise;
      const usageTree = this.tokenDetails.promptContextUsageTree;
      const promptContextUsageSnapshotBlobId = await persistPromptContextUsageSnapshot({
        ctx: quietCtx,
        blobStore: this.blobStore,
        privacyMode: this.privacyMode,
        usageTree,
        rootPromptMessagesJson,
      });
      const tokenDetails = fromRedactedConversationTokenDetails(this.tokenDetails, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined);
      tokenDetails.promptContextUsageSnapshotBlobId = promptContextUsageSnapshotBlobId!;
      const conversationStateInit = {
        rootPromptMessagesJson,
        turns: await newTurnsPromise,
        todos: await newTodosPromise,
        tokenDetails,
        summary: (await newSummaryPromise)!,
        plan: (await newPlanPromise)!,
        summaryArchives: (await newSummaryArchivesPromise)!,
        previousWorkspaceUris: this.previousWorkspaceUris?.map((uri) => uri.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)) ?? [],
        trackedGitRepoBranches: this.trackedGitRepoBranches.map((repo) => ({
          repoPath: repo.repoPath,
          branchName: repo.branchName,
        })),
        mode: this.mode!,
        agentType: this.agentType!,
        activeBranchName: this.activeBranchName!,
        isRootProjectConversation: (this.isRootProjectConversation || undefined)!,
        conversationStartedTimestampMs: this.conversationStartedTimestampMs!,
        conversationStartedTimeZone: this.conversationStartedTimeZone!,
        fileStatesV2: Object.fromEntries(await fileStatesEntriesPromise),
        subagentStates: subagentStatesObj,
        subagentStateRefs: subagentStateRefsObj,
        subagentRunsByParentToolCallId: subagentRunsByParentToolCallIdObj,
        subagentThreads: subagentThreadsObj,
        selfSummaryCount: this.selfSummaryCount,
        readPaths: Array.from(this.readPaths),
        completedAskQuestionToolCallIds: Array.from(this.completedAskQuestionToolCallIds),
        plans: plansObj,
        goalState: this.goalState!,
        communicateUpdateHistory: this.communicateUpdateHistory.map((entry) => new CommunicateUpdateHistoryEntry({
          step: entry.step,
          messageIndex: entry.messageIndex,
        })),
        communicateUpdateFinalSummary: this.communicateUpdateFinalSummary!,
        communicateUpdateCompletedSubtitle: this.communicateUpdateCompletedSubtitle!,
        communicateUpdateStatesByParentToolCallId: communicateUpdateStatesByParentToolCallIdObj,
      };
      const newConversationStateStructure = new ConversationStateStructure(conversationStateInit);
      const newRedactedConversationStateStructure = toRedactedConversationStateStructure(newConversationStateStructure, this.conversationStateStructure._privacyMode);
      const serializeDurationMs = performance.now() - serializeStart;
      span.span.setAttribute("setBlobCount", setBlobCount);
      span.span.setAttribute("serializeDurationMs", serializeDurationMs);
      if (setBlobCount >= 50 || serializeDurationMs >= SLOW_RESTORE_DURATION_MS) {
        _logger3.debug(span.ctx, "Large conversation state serialize", {
          serializeDurationMs,
          setBlobCount,
          rootPromptMessageCount: newConversationStateStructure.rootPromptMessagesJson.length,
          turnCount: newConversationStateStructure.turns.length,
          todoCount: newConversationStateStructure.todos.length,
          fileStateCount: Object.keys(newConversationStateStructure.fileStatesV2).length,
          hasSummary: newConversationStateStructure.summary !== undefined,
          summaryArchiveCount: newConversationStateStructure.summaryArchives.length,
        });
      }
      this.conversationStateStructure = newRedactedConversationStateStructure;
      return newRedactedConversationStateStructure;
    } catch (e_2) {
      env_2.error = e_2;
      env_2.hasError = true;
    } finally {
      __disposeResources19(env_2);
    }
    throw new Error("Unreachable computeNewStructure completion");
  }

  async createShellTurn(
    ctx: OperationContext,
    shellCommand: Parameters<ConversationStateSerdes["shellCommand"]["serialize"]>[0],
  ): Promise<ShellConversationTurnHandle> {
    const shellCommandBlob = this.serdes.shellCommand.serialize(shellCommand);
    const shellCommandBlobId = await getBlobId(shellCommandBlob);
    getBlobMetadataCallback(this.blobStore)?.({
      blobId: shellCommandBlobId,
      blobType: { kind: "proto", typeName: "agent.v1.ShellCommand" },
    });
    await this.blobStore.setBlob(ctx, shellCommandBlobId, shellCommandBlob);
    const emptyOutput = toRedactedShellOutput(new ShellOutput({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }), this.privacyMode);
    const shellOutputBlob = this.serdes.shellOutput.serialize(emptyOutput);
    const shellOutputBlobId = await getBlobId(shellOutputBlob);
    getBlobMetadataCallback(this.blobStore)?.({
      blobId: shellOutputBlobId,
      blobType: { kind: "proto", typeName: "agent.v1.ShellOutput" },
    });
    await this.blobStore.setBlob(ctx, shellOutputBlobId, shellOutputBlob);
    const shellTurnInner = new ShellConversationTurnStructure({
      shellCommand: new Uint8Array(shellCommandBlobId),
      shellOutput: new Uint8Array(shellOutputBlobId),
    });
    const turn = new ShellConversationTurnHandle(this.blobStore, this.serdes, shellTurnInner);
    this.turns.push(new EagerReference({
      deserialize: (blob) => {
        const outer = conversationTurnStructureSerde2.deserialize(blob);
        if (outer.turn.case !== "shellConversationTurn") {
          throw new Error("Expected shell turn");
        }
        return new ShellConversationTurnHandle(this.blobStore, this.serdes, outer.turn.value);
      },
      serialize: (value) => value.serialize(),
    }, this.blobStore, turn));
    return turn;
  }

  getBlobStore(): BlobStore<OperationContext> {
    return this.blobStore;
  }

  getPrivacyMode(): PrivacyMode {
    return this.privacyMode;
  }

  addTurnUsage(usage: TurnUsageDelta): void {
    this.turnUsage.inputTokens += usage.inputTokens;
    this.turnUsage.outputTokens += usage.outputTokens;
    this.turnUsage.cacheReadTokens += usage.cacheReadTokens;
    this.turnUsage.cacheWriteTokens += usage.cacheWriteTokens;
    this.turnUsage.reasoningTokens = (this.turnUsage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
  }

  getTurnUsageAndReset(): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  } {
    const usage = { ...this.turnUsage };
    this.turnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    return usage;
  }

  setTokenDetails(tokenDetails: RedactedConversationTokenDetailsLike): void {
    this.tokenDetails = tokenDetails;
    this.tokenDetailsStaleAfterSummarization = false;
  }

  getSubagentThreadId(subagentId: string): string | undefined {
    const threadId = this.subagentThreads.get(subagentId);
    if (threadId === undefined || threadId.length === 0) {
      return undefined;
    }
    return threadId;
  }

  setSubagentThreadId(subagentId: string, threadId: string | undefined): void {
    if (subagentId.length === 0) {
      return;
    }
    if (threadId === undefined || threadId.length === 0) {
      this.subagentThreads.delete(subagentId);
      return;
    }
    this.subagentThreads.set(subagentId, threadId);
  }

  persistSubagentState(
    _ctx: OperationContext,
    subagentId: string,
    subagentType: SubagentType,
    state: Partial<SubagentPersistedState>,
  ): void {
    const now = BigInt(Date.now());
    const existingState = this.subagentStates.get(subagentId);
    const createdTimestamp = existingState?.createdTimestampMs ?? now;
    const persistedModelId = state.modelId ?? existingState?.modelId;
    const updatedState = new SubagentPersistedState({
      ...state,
      createdTimestampMs: createdTimestamp,
      lastUsedTimestampMs: now,
      subagentType,
      modelId: persistedModelId!,
    });
    this.subagentStates.set(subagentId, updatedState);
    const typeName = getSubagentTypeName(subagentType);
    this.lastSubagentByType.set(typeName, subagentId);
    this.lastUsedSubagentId = subagentId;
  }

  recordSubagentRunCompletion(completion: BackgroundTaskCompletion): void {
    if (completion.kind !== BackgroundTaskKind.SUBAGENT || completion.reason === BackgroundTaskCompletionReason.TASK_PROGRESS) {
      return;
    }
    const parentToolCallId = normalizeNonEmptyString(completion.toolCallId);
    if (parentToolCallId === undefined) {
      return;
    }
    const subagentId = normalizeNonEmptyString(completion.subagentId) ?? normalizeNonEmptyString(completion.taskId);
    const existingRun = this.subagentRunsByParentToolCallId.get(parentToolCallId);
    const persistedSubagentState = subagentId !== undefined
      ? this.subagentStates.get(this.resolveSubagentId(subagentId) ?? subagentId)
      : undefined;
    const persistedEnvironment = persistedSubagentState?.environment !== undefined && persistedSubagentState.environment !== SubagentExecutionEnvironment.UNSPECIFIED
      ? persistedSubagentState.environment
      : undefined;
    const existingEnvironment = existingRun?.environment !== undefined && existingRun.environment !== SubagentExecutionEnvironment.UNSPECIFIED
      ? existingRun.environment
      : undefined;
    const completionReason = completion.reason !== BackgroundTaskCompletionReason.UNSPECIFIED
      ? completion.reason
      : existingRun?.completionReason;
    const status = completion.status !== BackgroundTaskStatus.UNSPECIFIED
      ? subagentRunStatusFromCompletionStatus(completion.status)
      : existingRun?.status ?? SubagentRunStatus.UNSPECIFIED;
    this.subagentRunsByParentToolCallId.set(parentToolCallId, new SubagentRunState({
      parentToolCallId,
      subagentId: subagentId!,
      environment: persistedEnvironment ?? existingEnvironment ?? SubagentExecutionEnvironment.UNSPECIFIED,
      status,
      title: normalizeNonEmptyString(completion.title) ?? existingRun?.title!,
      detail: normalizeNonEmptyString(completion.detail) ?? existingRun?.detail!,
      transcriptPath: normalizeNonEmptyString(persistedSubagentState?.cloudSubagent?.transcriptPath) ?? existingRun?.transcriptPath!,
      outputPath: normalizeNonEmptyString(completion.outputPath) ?? existingRun?.outputPath!,
      completedTimestampMs: BigInt(Date.now()),
      completionReason: completionReason!,
    }));
  }

  resolveSubagentId(subagentIdOrBcId: string): string | undefined {
    if (this.subagentStates.has(subagentIdOrBcId)) {
      return subagentIdOrBcId;
    }
    for (const [subagentId, state] of this.subagentStates) {
      if (state.cloudSubagent?.bcId === subagentIdOrBcId) {
        return subagentId;
      }
    }
    return undefined;
  }

  restoreSubagentState(_ctx: OperationContext, subagentId: string): SubagentPersistedState | undefined {
    const resolved = this.resolveSubagentId(subagentId);
    return resolved !== undefined ? this.subagentStates.get(resolved) : undefined;
  }

  getSubagentIdToResume(
    typeName: string,
    mode: "DEFAULT" | "LAST_AGENT" | "LAST_AGENT_SAME_TYPE",
  ): string | undefined {
    switch (mode) {
      case "DEFAULT":
        return undefined;
      case "LAST_AGENT":
        return this.lastUsedSubagentId;
      case "LAST_AGENT_SAME_TYPE":
        return this.lastSubagentByType.get(typeName);
      default: {
        const exhaustiveCheck: never = mode;
        throw new Error(`Unknown resume mode: ${exhaustiveCheck}`);
      }
    }
  }

  recordReadPath(path29: RedactedValue<string>): void {
    this.readPaths.add(path29.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED));
  }

  hasReadPath(path29: RedactedValue<string>): boolean {
    return this.readPaths.has(path29.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED));
  }

  hasCompletedAskQuestion(originalToolCallId: string): boolean {
    return this.completedAskQuestionToolCallIds.has(originalToolCallId);
  }

  markAskQuestionCompleted(originalToolCallId: string): void {
    this.completedAskQuestionToolCallIds.add(originalToolCallId);
  }

  retainCompletedAskQuestionReceipts(liveOriginalIds: ReadonlySet<string>): void {
    for (const id of this.completedAskQuestionToolCallIds) {
      if (!liveOriginalIds.has(id)) this.completedAskQuestionToolCallIds.delete(id);
    }
  }

  setMode(mode: AgentMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.conversationStateStructure.mode = mode;
  }

  hasAgentTypeChangedFromPersistedState(): boolean {
    return this.agentTypeChangedFromPersistedState;
  }

  setActiveBranchName(activeBranchName: string | undefined): void {
    this.activeBranchName = activeBranchName;
  }

  setBackgroundSummarizationState(
    promiseInfo: unknown,
    messagesUndergoingSummarization: unknown,
    cancellationToken: unknown,
  ): void {
    this.backgroundSummarizationPromiseInfo = promiseInfo;
    this.messagesUndergoingSummarization = messagesUndergoingSummarization;
    this.backgroundSummarizationHasCompleted = false;
    this.backgroundSummarizationCancellationToken = cancellationToken;
  }

  setBackgroundSummarizationHasCompleted(generationDurationMs: number): void {
    this.backgroundSummarizationHasCompleted = true;
    this.backgroundSummarizationGenerationDurationMs = generationDurationMs;
  }

  clearBackgroundSummarizationState(): void {
    this.backgroundSummarizationPromiseInfo = null;
    this.messagesUndergoingSummarization = null;
    this.backgroundSummarizationHasCompleted = false;
    this.backgroundSummarizationGenerationDurationMs = null;
    this.backgroundSummarizationCancellationToken = null;
  }
}
