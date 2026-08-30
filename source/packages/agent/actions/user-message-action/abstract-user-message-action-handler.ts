import { randomUUID } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { RE2JS } from "re2js";
import { InteractionUpdate, AgentMode, ResponseComparisonCompleted, ResponseComparisonDisplayOrder, ResponseComparisonSkipped, ResponseComparisonSkipReason, ResponseComparisonStarted, ResponseComparisonTextDelta, ResponseComparisonUpdate, UserMessage } from "../../../proto/generated/agent/v1/agent_pb.js";
import { TodoStatus } from "../../../proto/generated/agent/v1/todo_tool_pb.js";
import { RequestContext } from "../../../proto/generated/agent/v1/request_context_exec_pb.js";
import { createRedactedConversationTokenDetails, fromRedactedConversationPlan, fromRedactedToolCall, fromRedactedUserMessage, toRedactedConversationPlan, toRedactedInteractionUpdate, toRedactedToolCall } from "../../../redacted-protos/generated/agent/v1/agent_redacted.js";
import type { Context } from "../../../context/core.js";
import type { RequestContextResources } from "../../utils/request-context.js";
import { createSpan } from "../../../context/otel.js";
import { createLogger } from "../../../context/logger.js";
import { ProactiveSummarizationThresholdError, InputTokenLimitError, OutputTokensLimitExceededError } from "../../../chat-inference/prompt-executor.js";
import { PermissionsFileProvider } from "../../../cursor-config/permissions-file-provider.js";
import { createCounter, createHistogram } from "../../../metrics/index.js";
import { DataClassification, PrivacyCapability } from "../../../redaction/classification.js";
import { fromRedactedCoreMessages, toRedactedCoreMessages, type CoreMessageLike } from "../../../redaction/core-message.js";
import { createRedactedString, safeString } from "../../../redaction/factory.js";
import { PrivacyMode } from "../../../redaction/privacy-mode.js";
import { BackgroundSummarizationMode, getBackgroundSummarizationTriggerThreshold, shouldPersistBackgroundSummarization, shouldStartBackgroundSummarization, type BackgroundSummarizationProps } from "../../../agent-summarization/background-summarization.js";
import { isTooManyImagesOrDocumentsError } from "../../../agent-summarization/error-handling.js";
import { SummarizationHandler, shouldForceSummarizationForTesting } from "../../../agent-summarization/summarization-handler.js";
import { InteractionHandler } from "../../interaction-handler.js";
import { RedactedUpdates } from "../../../agent-core/redacted-interaction-updates.js";
import { Updates } from "../../../agent-core/interaction-updates.js";
import { applyAskQuestionCompletion, type AskQuestionCompletionAction } from "../ask-question-completion.js";
import { resolveCurrentStepMode, resolveCurrentTurnMode } from "../../mode-processing.js";
import { getBrowserToolNames } from "../../common.js";
import { AgentConversationTurnHandle } from "../../state.js";
import { toUnredactedInteractionListener } from "../../../agent-core/redacted-interaction-listener.js";
import { AgentLoopError, createLoopReminderMessage } from "../../loop-detection/agent-loop-detector.js";
import { enrichPendingToolCallJson, getAdmittedEffectiveToolName } from "../../pending-tool-call-contract.js";
import { getTaskToolName } from "../../tools/task-tool-name.js";
import { executeRemoteAfterAgentThoughtHook } from "../../tools/core/remote-hooks.js";
import { FileOperationLockManager } from "../../tools/core/file-operation-lock-manager.js";
import { appendToolCallIdTagsToToolResults, shouldTagToolCallIdsForCurrentContext } from "../../tools/tool-call-id-tagging.js";
import { extractToolMetadataMap, getDirectDynamicToolNames, getExecutableTools, toAgentTools } from "../../tools/core.js";
import { executeDeferredToolCall, getEffectiveToolCallArgs, getEffectiveToolCallName, type NativeToolCallDescriptor } from "../../tool-stream-executor.js";
import { ToolCountingStateTracker, createToolCountingMiddleware } from "../../tool-counting-middleware.js";
import { applyRemindersToToolResults } from "../../reminders/apply-reminders.js";
import { fromRedactedTodoItem, toRedactedTodoItem } from "../../../redacted-protos/generated/agent/v1/todo_tool_redacted.js";
import { agentStoreConflictNoticeExecutorResource, conflictNoticeAck, conflictNoticeRelease, conflictNoticeSyncAndPeek } from "../../../agent-exec/agent-store-conflict-notice.js";
import { sanitizeSystemReminderContent } from "../../../hooks/sanitize-system-reminder.js";
import { extractAutomationTriggerContext, getAllRules } from "../common.js";
import { mcpInputSchemaToJson, type McpInputSchemaLike } from "../../../agent-exec/mcp.js";
import { fromRedactedMcpToolDefinition } from "../../../redacted-protos/generated/agent/v1/mcp_redacted.js";
import { fromRedactedRequestContext } from "../../../redacted-protos/generated/agent/v1/request_context_exec_redacted.js";
import { getInvocationId } from "../../utils/invocation-id.js";
import { nextRedactedPromptContextDetails } from "../../utils/next-redacted-prompt-context-details.js";
import { EVAL_ENFORCED_WAIT_FOR_SUMMARIZATION_COMPLETION } from "../../utils/overridable-config.js";
import { trackPromptTokenUsage } from "../../utils/prompt-token-tracking.js";
import { getAgentEventTracker } from "../../utils/event-tracking.js";
import { requestPromptSuggestion } from "../../prompt-suggestion/prompt-suggestion-handler.js";
import { getAutoRoutingReasonFromContext, getClientVersionMetricTagsFromContext, getIsAnysphereTeamFromContext, getIsAutoFromContext, getIsDevFromContext, getIsPremiumFromContext, getIsSubagentFromContext, getIsUserApiKeyFromContext, getRequestId, getSdkFlavorMetricTagFromContext } from "../../utils/request-id.js";
import { smartModeAutoRunInstructionsFromProtos } from "../../utils/smart-mode-permissions-instructions.js";
import { isGoalContinuationNotificationMessage, isNotificationOnlyUserMessage } from "./synthetic-user-message.js";
import { warnIfLongTrailingUserMessageRun } from "./user-message-run-warning.js";
import type { AgentType } from "../../utils/agent-config.js";

type PromptTokenTrackingParamsLike = Parameters<typeof trackPromptTokenUsage>[0];
import type { AgentConfigToolingContract } from "../../agent-config-tooling-contract.js";
import type { AgentToolsGenerator } from "../../tools/tools-generator-contract.js";
import type { ToolSetHandle } from "../../tools/core.js";
import type { SummarizationStateHandler } from "../../summarization-orchestrator.js";

const DEFAULT_CLI_REFLECT_GENERAL_REMINDER_INTERVAL = 10;
const DEFAULT_CLI_REFLECT_GENERAL_MAX_FOLLOW_UPS_PER_TURN = -1;
const DEFAULT_CLI_REFLECT_GENERAL_REMINDER_TEXT =
  "<system_reminder>You MUST now use the Reflect tool to reflect on your current progress</system_reminder>";
const IMAGE_SUMMARIZATION_TRIGGER_COUNT = 85;
const AGENT_RESPONSE_COMPARISON_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_COMPARISON_WARMUPS_PER_TURN = 5;

type UnknownRecord = Record<string, unknown>;

interface AssistantContentPart extends UnknownRecord {
  readonly type: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly args?: unknown;
}

interface FinalAssistantMessageUxStats {
  readonly character_count: number;
  readonly word_count: number;
  readonly line_count: number;
  readonly paragraph_count: number;
  readonly sentence_count: number;
  readonly heading_count: number;
  readonly list_item_count: number;
  readonly code_block_count: number;
  readonly inline_code_count: number;
  readonly link_count: number;
}

interface UxStatsPatterns {
  readonly word: RE2JS;
  readonly sentenceTerminator: RE2JS;
  readonly heading: RE2JS;
  readonly listItem: RE2JS;
  readonly inlineCode: RE2JS;
  readonly markdownLink: RE2JS;
}

function alternateModelIdForAnalytics(selection: {
  readonly alternate: "parent" | { readonly modelId: string };
}): string {
  return selection.alternate === "parent" ? "same_as_parent" : selection.alternate.modelId;
}

function hasAutoRunInstructions(instructions: {
  readonly allowInstructions: readonly unknown[];
  readonly blockInstructions: readonly unknown[];
} | undefined): boolean {
  return instructions !== undefined &&
    (instructions.allowInstructions.length > 0 || instructions.blockInstructions.length > 0);
}

const logger = createLogger("@anysphere/agent");

async function loadUserPermissionsFileAutoRunInstructions(
  ctx: Context,
): Promise<{ readonly allowInstructions: readonly string[]; readonly blockInstructions: readonly string[] } | undefined> {
  try {
    const provider = await PermissionsFileProvider.load();
    const instructions = provider?.getAutoRunInstructions();
    return hasAutoRunInstructions(instructions) ? instructions : undefined;
  } catch (error) {
    logger.warn(ctx, "Failed to load user permissions auto-run instructions", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function getGrindPhaseOverrideFromResponse(
  responseMessages: readonly CoreMessageLike[],
): "executing" | "planning" | undefined {
  for (const message of responseMessages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as AssistantContentPart[]) {
        if (part.type === "tool-call") {
          if (part.toolName === "StartGrindExecution") {
            return "executing";
          }
          if (part.toolName === "StartGrindPlanning") {
            return "planning";
          }
        }
      }
    }
  }
  return undefined;
}

function countAssistantMessages(responseMessages: readonly CoreMessageLike[]): number {
  return responseMessages.filter(message => message.role === "assistant").length;
}

function extractAssistantText(message: CoreMessageLike): string | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content.map(part => {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      return part.text;
    }
    return "";
  }).join("");
}

function containsToolCall(responseMessages: readonly CoreMessageLike[]): boolean {
  return responseMessages.some(message =>
    message.role === "tool" ||
    message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(part =>
        typeof part === "object" && part !== null && "type" in part && part.type === "tool-call"
      )
  );
}

const FINAL_ASSISTANT_MESSAGE_UX_STAT_NAMES = [
  "character_count",
  "word_count",
  "line_count",
  "paragraph_count",
  "sentence_count",
  "heading_count",
  "list_item_count",
  "code_block_count",
  "inline_code_count",
  "link_count",
] as const;

function countRegexMatches(text: string, pattern: RE2JS): number {
  const matcher = pattern.matcher(text);
  let count = 0;
  while (matcher.find()) {
    count += 1;
  }
  return count;
}

function compileFinalAssistantMessageUxStatsPatterns(): UxStatsPatterns {
  return {
    word: RE2JS.compile("[\\p{L}\\p{N}]+(?:['-][\\p{L}\\p{N}]+)*"),
    sentenceTerminator: RE2JS.compile("[.!?](?:\\s|$)"),
    heading: RE2JS.compile("^\\s{0,3}#{1,6}\\s+\\S", RE2JS.MULTILINE),
    listItem: RE2JS.compile("^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)", RE2JS.MULTILINE),
    inlineCode: RE2JS.compile("`[^`\\n]+`"),
    markdownLink: RE2JS.compile("\\[[^\\]\\n]+\\]\\([^)]+\\)"),
  };
}

function countWords(text: string, patterns: UxStatsPatterns): number {
  return countRegexMatches(text, patterns.word);
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let lineCount = 1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") {
      lineCount += 1;
    } else if (char === "\r") {
      lineCount += 1;
      if (text[index + 1] === "\n") {
        index += 1;
      }
    }
  }
  return lineCount;
}

function countParagraphs(text: string): number {
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return 0;
  }
  let paragraphCount = 1;
  let newlineCountInWhitespaceRun = 0;
  let countedCurrentWhitespaceRun = false;
  for (let index = 0; index < trimmedText.length; index += 1) {
    const char = trimmedText[index]!;
    const isNewline = char === "\n" || char === "\r";
    if (isNewline) {
      newlineCountInWhitespaceRun += 1;
      if (newlineCountInWhitespaceRun >= 2 && !countedCurrentWhitespaceRun) {
        paragraphCount += 1;
        countedCurrentWhitespaceRun = true;
      }
      if (char === "\r" && trimmedText[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }
    if (!isWhitespace(char)) {
      newlineCountInWhitespaceRun = 0;
      countedCurrentWhitespaceRun = false;
    }
  }
  return paragraphCount;
}

function countSentences(text: string, patterns: UxStatsPatterns): number {
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return 0;
  }
  const terminalPunctuationCount = countRegexMatches(
    trimmedText,
    patterns.sentenceTerminator,
  );
  return terminalPunctuationCount === 0 ? 1 : terminalPunctuationCount;
}

function isWhitespace(char: string): boolean {
  return char.trim().length === 0;
}

function getFenceMarker(line: string): "```" | "~~~" | undefined {
  const trimmedStart = line.trimStart();
  if (trimmedStart.startsWith("```")) {
    return "```";
  }
  if (trimmedStart.startsWith("~~~")) {
    return "~~~";
  }
  return undefined;
}

function getNextLineWithEnding(text: string, startIndex: number): {
  readonly line: string;
  readonly lineWithEnding: string;
  readonly nextIndex: number;
} {
  let lineEndIndex = startIndex;
  while (
    lineEndIndex < text.length &&
    text[lineEndIndex] !== "\n" &&
    text[lineEndIndex] !== "\r"
  ) {
    lineEndIndex += 1;
  }
  let nextIndex = lineEndIndex;
  if (nextIndex < text.length) {
    if (text[nextIndex] === "\r" && text[nextIndex + 1] === "\n") {
      nextIndex += 2;
    } else {
      nextIndex += 1;
    }
  }
  return {
    line: text.slice(startIndex, lineEndIndex),
    lineWithEnding: text.slice(startIndex, nextIndex),
    nextIndex,
  };
}

function extractFencedCodeBlockStats(text: string): {
  readonly count: number;
  readonly textWithoutFencedCodeBlocks: string;
} {
  let count = 0;
  let textWithoutFencedCodeBlocks = "";
  let pendingFenceMarker: "```" | "~~~" | undefined;
  let pendingFenceText = "";
  for (let index = 0; index < text.length;) {
    const { line, lineWithEnding, nextIndex } = getNextLineWithEnding(text, index);
    index = nextIndex;
    const marker = getFenceMarker(line);
    if (pendingFenceMarker === undefined) {
      if (marker === undefined) {
        textWithoutFencedCodeBlocks += lineWithEnding;
      } else {
        pendingFenceMarker = marker;
        pendingFenceText = lineWithEnding;
      }
      continue;
    }
    pendingFenceText += lineWithEnding;
    if (marker === pendingFenceMarker) {
      count += 1;
      textWithoutFencedCodeBlocks += "\n";
      pendingFenceMarker = undefined;
      pendingFenceText = "";
    }
  }
  if (pendingFenceMarker !== undefined) {
    textWithoutFencedCodeBlocks += pendingFenceText;
  }
  return { count, textWithoutFencedCodeBlocks };
}

function analyzeAssistantMessageUxStats(text: string): FinalAssistantMessageUxStats {
  const patterns = compileFinalAssistantMessageUxStatsPatterns();
  const { count: codeBlockCount, textWithoutFencedCodeBlocks } =
    extractFencedCodeBlockStats(text);
  return {
    character_count: text.length,
    word_count: countWords(text, patterns),
    line_count: countLines(text),
    paragraph_count: countParagraphs(text),
    sentence_count: countSentences(text, patterns),
    heading_count: countRegexMatches(textWithoutFencedCodeBlocks, patterns.heading),
    list_item_count: countRegexMatches(textWithoutFencedCodeBlocks, patterns.listItem),
    code_block_count: codeBlockCount,
    inline_code_count: countRegexMatches(textWithoutFencedCodeBlocks, patterns.inlineCode),
    link_count: countRegexMatches(textWithoutFencedCodeBlocks, patterns.markdownLink),
  };
}

function getFinalAssistantMessageUxStats(
  responseMessages: readonly CoreMessageLike[],
): FinalAssistantMessageUxStats | undefined {
  const finalMessage = responseMessages.at(-1);
  if (finalMessage === undefined) {
    return undefined;
  }
  const assistantText = extractAssistantText(finalMessage);
  if (assistantText === undefined) {
    return undefined;
  }
  return analyzeAssistantMessageUxStats(assistantText);
}

function getFinalAssistantMessageCharacterCount(
  responseMessages: readonly CoreMessageLike[],
): number | undefined {
  const finalMessage = responseMessages.at(-1);
  if (finalMessage === undefined) {
    return undefined;
  }
  return extractAssistantText(finalMessage)?.length;
}

function hasReflectGeneralToolCall(
  responseMessages: readonly CoreMessageLike[],
  toolCallIdentityResolver: {
    resolveToolCallIdentity(input: { readonly toolName: string; readonly args: unknown }): {
      readonly toolIdentifier?: unknown;
    } | undefined;
  },
): boolean {
  for (const message of responseMessages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content as AssistantContentPart[]) {
      if (
        (part.type === "tool-call" || part.type === "tool-result") &&
        part.toolName === "Reflect"
      ) {
        return true;
      }
      if (
        part.type === "tool-call" &&
        toolCallIdentityResolver.resolveToolCallIdentity({
          toolName: part.toolName as string,
          args: part.args,
        })?.toolIdentifier === "REFLECT_GENERAL"
      ) {
        return true;
      }
    }
  }
  return false;
}

function isSuccessfulCreatePlanStep(step: unknown): boolean {
  if (typeof step !== "object" || step === null || !("message" in step)) return false;
  const message = step.message;
  if (typeof message !== "object" || message === null || !("case" in message) || message.case !== "toolCall" || !("value" in message)) return false;
  const messageValue = message.value;
  if (typeof messageValue !== "object" || messageValue === null || !("tool" in messageValue)) return false;
  const tool = messageValue.tool;
  if (typeof tool !== "object" || tool === null || !("case" in tool) || tool.case !== "createPlanToolCall" || !("value" in tool)) return false;
  const toolValue = tool.value;
  if (typeof toolValue !== "object" || toolValue === null || !("result" in toolValue)) return false;
  const result = toolValue.result;
  if (typeof result !== "object" || result === null || !("result" in result)) return false;
  return typeof result.result === "object" && result.result !== null && "case" in result.result && result.result.case === "success";
}

interface DeliveryTurnLike {
  readonly steps: readonly {
    get(ctx: Context): Promise<{
      readonly message: {
        readonly case?: string;
        readonly value?: {
          readonly tool?: {
            readonly case?: string;
            readonly value?: {
              readonly result?: { readonly result?: { readonly case?: string } };
            };
          };
        };
      };
    }>;
  }[];
  readonly userMessage: {
    get(ctx: Context): Promise<{ readonly isSimulatedMsg?: boolean }>;
  };
}

interface DeliveryStateHandlerLike {
  readonly turns: readonly { get(ctx: Context): Promise<unknown> }[];
}

function isDeliveryTurnLike(value: unknown): value is DeliveryTurnLike {
  return value instanceof AgentConversationTurnHandle;
}

async function isSendMessageDeliveryOwed(
  ctx: Context,
  stateHandler: DeliveryStateHandlerLike,
): Promise<boolean> {
  for (let turnIndex = stateHandler.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = await stateHandler.turns[turnIndex]!.get(ctx);
    if (!isDeliveryTurnLike(turn)) {
      continue;
    }
    for (let stepIndex = turn.steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
      const step = await turn.steps[stepIndex]!.get(ctx);
      if (
        step.message.case === "toolCall" &&
        step.message.value?.tool?.case === "sendMessageToolCall" &&
        step.message.value.tool.value?.result?.result?.case === "success"
      ) {
        return false;
      }
    }
    const userMessage = await turn.userMessage.get(ctx);
    if (userMessage.isSimulatedMsg !== true) {
      return true;
    }
  }
  return false;
}

function trailingToolBatchHasFailure(messages: readonly CoreMessageLike[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool") {
      break;
    }
    const highLevelResult = (
      message.providerOptions as {
        readonly cursor?: {
          readonly highLevelToolCallResult?: { readonly isError?: unknown };
        };
      } | undefined
    )?.cursor?.highLevelToolCallResult;
    if (highLevelResult?.isError !== false) {
      return true;
    }
  }
  return false;
}

function isTrailingTaskToolCallMessage(
  messages: readonly CoreMessageLike[],
  taskToolName: string | undefined,
  toolCallIdentityResolver: {
    resolveToolCallIdentity(input: { readonly toolName: string; readonly args: unknown }): {
      readonly toolIdentifier?: unknown;
    } | undefined;
  } | undefined,
): boolean {
  if (taskToolName === undefined) {
    return false;
  }
  const lastMessage = messages.at(-1);
  if (
    lastMessage?.role !== "assistant" ||
    !Array.isArray(lastMessage.content)
  ) {
    return false;
  }
  for (const part of lastMessage.content as AssistantContentPart[]) {
    if (part?.type !== "tool-call") {
      continue;
    }
    if (part.toolName === taskToolName) {
      return true;
    }
    if (toolCallIdentityResolver?.resolveToolCallIdentity({
      toolName: part.toolName as string,
      args: part.args,
    })?.toolIdentifier === "TASK") {
      return true;
    }
  }
  return false;
}

const EMPTY_RESPONSE_CONTINUATION_MESSAGE =
  "<system_reminder>Please continue. Respond to the user or make tool calls.</system_reminder>";

class EmptyResponseRetryError extends Error {
  readonly retryAction: unknown;
  readonly needsContinuationMessage: unknown;

  constructor(retryAction: unknown, needsContinuationMessage: unknown) {
    super(`Empty model response, retry action: ${String(retryAction)}`);
    this.name = "EmptyResponseRetryError";
    this.retryAction = retryAction;
    this.needsContinuationMessage = needsContinuationMessage;
  }
}

class StepRetriesExhaustedError extends Error {
  readonly reason: unknown;
  readonly isStepRetriesExhausted = true;

  constructor(reason: unknown) {
    super("Failed to run step, exceeded max retries");
    this.reason = reason;
    this.name = "StepRetriesExhaustedError";
  }
}

const MAX_RETRY_ITERATIONS = 5;
const MAX_EMPTY_RESPONSE_RETRIES_PER_TURN = 3;

function hasEmptyAssistantText(messages: readonly CoreMessageLike[]): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    if (typeof message.content === "string") {
      if (message.content.trim().length > 0) {
        return false;
      }
    } else if (Array.isArray(message.content)) {
      for (const part of message.content as AssistantContentPart[]) {
        if (part.type === "text" && (part.text?.trim().length ?? 0) > 0) {
          return false;
        }
      }
    }
  }
  return true;
}

function countImagePartsInMessages(messages: readonly CoreMessageLike[]): number {
  const countImagesInValue = (value: unknown): number => {
    if (Array.isArray(value)) {
      let total = 0;
      for (const item of value) {
        total += countImagesInValue(item);
      }
      return total;
    }
    if (typeof value !== "object" || value === null) {
      return 0;
    }
    let total = 0;
    if (
      "type" in value &&
      typeof value.type === "string" &&
      (value.type === "image" || value.type === "image_url" || value.type === "input_image")
    ) {
      total += 1;
    }
    if ("content" in value) {
      total += countImagesInValue(value.content);
    }
    if ("experimental_content" in value) {
      total += countImagesInValue(value.experimental_content);
    }
    return total;
  };
  let imageCount = 0;
  for (const message of messages) {
    imageCount += countImagesInValue(message.content);
  }
  return imageCount;
}

const agentStepCount = createCounter("agent.step.count", {
  description: "The number of steps taken by the agent",
});
const agentStoreConflictBarrier = createCounter("agent.store.conflict_barrier", {
  description: "Local-sync conflict turn-end barrier outcomes",
  labelNames: ["outcome", "timed_out"],
});
const firstStepSetupDuration = createHistogram("agent.ttft.firstStepSetupMs", {
  description: "Time from runStep entry to executeToolStream call (tool generation, message preparation) on the first step only",
});
const agentTurnDuration = createHistogram("agent.turn.duration_ms", {
  description: "Duration of agent turn execution in milliseconds",
});
const agentTurnResult = createCounter("agent.turn.result", {
  description: "Result status of agent turn execution",
  labelNames: [
    "outcome",
    "newConversation",
    "isauto",
    "ispremium",
    "isanysphereteam",
    "isuserapikey",
    "issubagent",
    "autoroutingreason",
  ],
});
const agentToolCallsPerTurn = createHistogram("agent.turn.tool_calls", {
  description: "Total number of tool calls executed in a turn",
  labelNames: [
    "outcome",
    "clientversion",
    "clienttype",
    "sdkflavor",
    "user.is_dev",
  ],
});
const finalAssistantMessageCharacters = createHistogram("agent.turn.final_assistant_message_chars", {
  description: "Character count of the final assistant message when a turn completes",
});
const finalAssistantMessageUxStatsMetric = createHistogram("agent.turn.final_assistant_message_ux_stats", {
  description: "UX stats for the final assistant message when a turn completes",
  labelNames: ["stat"],
});
const unifiedHandlerNumberOfToolCalls = createHistogram("agent.unified_handler_number_of_tool_calls", {
  description: "Number of tool calls in unified handler",
  labelNames: [
    "model",
    "hasFailedToolCalls",
    "hasUnexpectedToolCallErrors",
    "success",
    "errorName",
  ],
});
const unfinishedTodosMetric = createCounter("agent.turn.unfinished_todos", {
  description: "Number of unfinished todos at the end of a turn",
});
const backgroundSummarizationDiscarded = createCounter("agent.background_summarization.discarded", {
  description: "Background summarizations discarded at end of turn",
  labelNames: ["reason", "model"],
});
const emptyResponseRetryClassification = createCounter("nal.empty_response.retry_classification", {
  description: "Retry classification for empty model responses",
  labelNames: ["retryAction", "didRetry"],
});
const toolCallArgsOutputTokens = createHistogram("tool_call.args.output_tokens", {
  description: "Output tokens for tool call arguments",
  labelNames: ["toolCallName"],
});
const toolCallArgsCacheWriteTokens = createHistogram("tool_call.args.cache_write_tokens", {
  description: "Cache write tokens for tool call arguments",
  labelNames: ["toolCallName"],
});
const toolCallResultInputTokens = createHistogram("tool_call.result.input_tokens", {
  description: "Input tokens for tool call result",
  labelNames: ["toolCallName"],
});
const toolCallResultCachedReadTokens = createHistogram("tool_call.result.cached_read_tokens", {
  description: "Cached read tokens for tool call result",
  labelNames: ["toolCallName"],
});
const numberOfParallelToolCalls = createHistogram("agent.unified_handler.model_invocation.number_of_parallel_tool_calls", {
  description: "Number of parallel tool calls in a model invocation",
  labelNames: [
    "hasFailedToolCalls",
    "hasUnexpectedToolCallErrors",
    "success",
    "errorName",
  ],
});
const numberOfParallelToolCallsWithAtLeastOneCall = createHistogram("agent.unified_handler.model_invocation.number_of_parallel_tool_calls_with_at_least_one_call", {
  description: "Number of parallel tool calls in a model invocation when there is at least one call",
  labelNames: [
    "hasFailedToolCalls",
    "hasUnexpectedToolCallErrors",
    "success",
    "errorName",
    "clientversion",
    "clienttype",
    "user.is_dev",
  ],
});

type SmartModeRequestContextLike = Parameters<typeof smartModeAutoRunInstructionsFromProtos>[0];

interface ResponseComparisonSelectionLike {
  readonly displayOrder: "parent-first" | "alternate-first";
  readonly comparisonConfigId: string;
  readonly alternate: "parent" | { readonly modelId: string };
}

interface PreparedResponseComparisonAttemptLike {
  readonly selection: ResponseComparisonSelectionLike;
  readonly maxResponseChars: number;
  isParentLengthEligible(response: string): boolean;
  hasSufficientCharacterDiff(parentResponse: string, alternateResponse: string): boolean;
  commitCooldown(): Promise<boolean>;
}

interface ResponseComparisonStreamPartLike {
  readonly type: string;
  readonly textDelta?: string;
}

interface ResponseComparisonResultLike {
  readonly fullStream: AsyncIterable<ResponseComparisonStreamPartLike>;
  readonly response: Promise<{ readonly messages: readonly CoreMessageLike[]; readonly error?: unknown }>;
  readonly usage?: Promise<unknown>;
  readonly extendedUsage?: Promise<unknown>;
  readonly providerMetadata?: Promise<unknown>;
  readonly invocationId?: Promise<unknown>;
}

interface AgentResponseComparisonCapabilityLike {
  readonly supportsPendingUi?: boolean;
  readonly warm?: (args: {
    readonly ctx: Context;
    readonly selection: ResponseComparisonSelectionLike;
    readonly messages: readonly CoreMessageLike[];
    readonly tools: readonly unknown[];
  }) => Promise<unknown>;
  readonly preselect?: (args: {
    readonly isByok: boolean;
    readonly isSubagent: boolean;
  }) => Promise<PreparedResponseComparisonAttemptLike | undefined>;
  readonly resolve?: (args: {
    readonly responseText: string;
    readonly isByok: boolean;
    readonly isSubagent: boolean;
  }) => Promise<PreparedResponseComparisonAttemptLike | undefined>;
  readonly refineSelection?: (args: {
    readonly ctx: Context;
    readonly parentResponse: string;
    readonly messages: readonly CoreMessageLike[];
    readonly selection: ResponseComparisonSelectionLike;
  }) => Promise<ResponseComparisonSelectionLike | undefined>;
  execute(args: {
    readonly ctx: Context;
    readonly selection: ResponseComparisonSelectionLike;
    readonly messages: readonly CoreMessageLike[];
    readonly tools: readonly unknown[];
    readonly invocationId: string;
  }): ResponseComparisonResultLike;
}

type ConflictNoticeSyncAndPeekResultLike =
  | { readonly kind: "mount-passive" }
  | {
    readonly kind: "completed" | "timed-out";
    readonly reminder?: string;
    readonly events: readonly { readonly eventId: string }[];
  };

interface UserMessageActionHandlerConfigLike {
  readonly thinkingStyle?: unknown;
  readonly resolveWriteBarrierTimeoutMs?: (() => number | undefined) | undefined;
  readonly featureFlags?: {
    readonly writeBarrierTimeoutMs?: number | undefined;
    readonly nalLoopDetection?: boolean | undefined;
    readonly cloudAgentProactiveTokenLimitError?: boolean | undefined;
    readonly cloudAgentProactiveSelfSummarization?: boolean | undefined;
    readonly enableHookAdditionalContext?: boolean | undefined;
    readonly enableAgentStoreConflictNotices?: boolean | undefined;
    readonly enableEmptyResponseRetry?: boolean | undefined;
    readonly enableCliReflectGeneralTool?: boolean | undefined;
    readonly cliReflectGeneralConfig?: {
      readonly stepsUntilForcedFollowUp?: number | undefined;
      readonly maxForcedFollowUpsPerTurn?: number | undefined;
      readonly forcedFollowUpMessage?: string | undefined;
    } | undefined;
    readonly collectModelUxStats?: boolean | undefined;
    readonly enablePromptSuggestion?: boolean | undefined;
    readonly promptSuggestionMaxInputTokenCost?: number | undefined;
    readonly getModelInputCostForContext?: ((model: string, estimatedTokens: number) => number) | undefined;
    readonly getFeedbackRequestDetails?: ((args: { readonly canonicalModelName: string | undefined }) => Promise<{
      readonly categories: readonly { readonly id: unknown; readonly label: unknown }[];
      readonly categoryGroups?: readonly {
        readonly id: unknown;
        readonly prompt: unknown;
        readonly categories: readonly { readonly id: unknown; readonly label: unknown }[];
      }[] | undefined;
      readonly title?: string | undefined;
      readonly negativeTitle?: string | undefined;
      readonly commentPlaceholder?: string | undefined;
    } | undefined>) | undefined;
    readonly glassMetaParentAgent?: boolean | undefined;
    readonly disableBackgroundTaskFollowUp?: boolean | undefined;
    readonly enableBackgroundTaskProgress?: boolean | undefined;
    readonly enableAgentChatLinks?: boolean | undefined;
    readonly hideAsyncSubagentTaskNotifications?: boolean | undefined;
    readonly userMessageTimestamps?: boolean | undefined;
    readonly sandSendMessageDeliveryOwed?: boolean | undefined;
    readonly promptContextUsageTree?: boolean | undefined;
    readonly protectLoopSkillDescription?: boolean | undefined;
  } | undefined;
  readonly automationInstructions?: unknown;
  readonly reminders?: Parameters<typeof applyRemindersToToolResults>[1];
  readonly messageHistoryModifier?: ((messages: CoreMessageLike[]) => CoreMessageLike[] | undefined) | undefined;
  readonly systemPromptGenerator: (args: {
    readonly requestContext: RequestContext;
    readonly cursorRules: ReturnType<typeof getAllRules>;
    readonly env: unknown;
    readonly browserTools: readonly string[];
    readonly cloudRule: unknown;
    readonly mode: AgentMode;
    readonly grindMode: { readonly phase: "executing" | "planning" };
  }, toolSetHandle: ToolSetHandle) => string;
  readonly smartModeClassifierMode?: unknown;
  readonly smartModeClassifierShadowMode?: unknown;
  readonly agentResponseComparison?: AgentResponseComparisonCapabilityLike | undefined;
  readonly backgroundSummarizationProps: BackgroundSummarizationProps & {
    readonly requireTriggerThresholdForMidLoopPersist?: boolean | undefined;
  };
  readonly maxSteps?: number | undefined;
  readonly conversationId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly canonicalModelName?: string | undefined;
  readonly agentTokenLimit?: number | undefined;
  readonly modelInfo?: PromptTokenTrackingParamsLike["modelInfo"] & { readonly promptVersion: string };
  readonly agentType?: AgentType | undefined;
  readonly useLocalAgentPrompting?: boolean | undefined;
  readonly userInfoDisplayOptions?: PromptTokenTrackingParamsLike["userInfoDisplayOptions"];
  readonly model?: { readonly mcid?: string | undefined; readonly parameters?: readonly unknown[] | undefined } | undefined;
  readonly strictArgParsing?: boolean | undefined;
  readonly fireAndForgetCheckpoints?: boolean | undefined;
  readonly immediatelyUpdateStateOnNewTurn?: boolean | undefined;
  readonly doNotFailOnMaxSteps?: boolean | undefined;
  readonly skipErrorStateCheckpoint?: boolean | undefined;
  readonly enableExecuteHookExec?: boolean | undefined;
}

type UserMessageActionHandlerConfig = UserMessageActionHandlerConfigLike & AgentConfigToolingContract;

interface RedactedActionCarrier {
  readonly _privacyMode: PrivacyMode;
  readonly [key: string]: unknown;
}

interface RedactedUserMessageActionValue extends RedactedActionCarrier {
  readonly userMessage?: Parameters<typeof fromRedactedUserMessage>[0];
  readonly requestContext?: {
    readonly tools?: readonly Parameters<typeof fromRedactedMcpToolDefinition>[0][];
  };
}

type RedactedConversationActionOneof =
  | { readonly case: "asyncAskQuestionCompletionAction"; readonly value: AskQuestionCompletionAction }
  | { readonly case: "userMessageAction"; readonly value: RedactedUserMessageActionValue }
  | { readonly case: "resumeAction" | "cancelAction" | "summarizeAction" | "shellCommandAction" | "startPlanAction" | "executePlanAction" | "cancelSubagentAction" | "backgroundTaskCompletionAction" | "backgroundShellAction" | "backgroundSubagentAction" | "subscriptionNotificationAction" | "goalContinuationAction" | "injectContextAction"; readonly value: RedactedActionCarrier }
  | { readonly case: undefined; readonly value?: undefined };

type RedactedConversationAction = { readonly action: RedactedConversationActionOneof };

interface ConversationActionReceiverLike {
  peek(ctx: Context): Promise<{ readonly action: RedactedConversationAction["action"] } | undefined>;
  pop(ctx: Context): Promise<undefined>;
  peekIsClaimedInjection?(): boolean;
  failConsumedInjectionDelivery?(): void;
  getContextInjectionToolSignal?(): unknown;
}

interface RetryStateHandlerLike {
  backgroundSummarizationPromiseInfo: SummarizationStateHandler["backgroundSummarizationPromiseInfo"];
  readonly backgroundSummarizationHasCompleted: boolean;
  readonly tokenDetails: SummarizationStateHandler["tokenDetails"];
  tokenDetailsStaleAfterSummarization: SummarizationStateHandler["tokenDetailsStaleAfterSummarization"];
  readonly lastStepInvocationId?: string | undefined;
  shouldSuppressSelfSummaryAfterInputLimitFailure(usedTokens: number): boolean;
}

interface RetryRootPromptExecutorLike {
  appendMessages(messages: ReturnType<typeof toRedactedCoreMessages>): void;
  clearMessages(): void;
  getState(): unknown;
  getMessages(): readonly (
    Parameters<typeof extractAutomationTriggerContext>[0][number] &
    Parameters<typeof fromRedactedCoreMessages>[0][number]
  )[];
  executeToolStream(...args: readonly unknown[]): StepStreamResultLike;
  executeModelStreamOnly(...args: readonly unknown[]): ModelOnlyStreamResultLike;
  stream(...args: readonly unknown[]): PromptSuggestionStreamResultLike;
}

interface StepStreamResultLike {
  readonly fullStream: AsyncIterable<ResponseComparisonStreamPartLike>;
  readonly response: Promise<{
    readonly messages: readonly CoreMessageLike[];
    readonly error?: unknown;
  }>;
  readonly extendedUsage: Promise<{
    readonly maxTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly reasoningTokens: number;
  }>;
  readonly usage: Promise<{ readonly totalTokens: number }>;
  readonly invocationId: Promise<string>;
}

interface StepResultLike {
  readonly hasToolCall: boolean;
  readonly responseMessages: readonly CoreMessageLike[];
}

interface ModelOnlyStreamResultLike {
  readonly fullStream: AsyncIterable<ResponseComparisonStreamPartLike>;
  readonly response: Promise<{
    readonly messages: readonly CoreMessageLike[];
    readonly error?: unknown;
  }>;
  readonly extendedUsage: Promise<{
    readonly maxTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly reasoningTokens: number;
  }>;
  readonly usage: Promise<{ readonly totalTokens: number }>;
  readonly toolCallDescriptors: Promise<readonly unknown[]>;
  readonly invocationId: Promise<string>;
}

interface ModelOnlyStepResultLike {
  readonly toolCallDescriptors: readonly unknown[];
  readonly responseMessages: readonly CoreMessageLike[];
}

interface RunStepTurnLike extends SetupStepTurnLike {
  readonly steps: readonly {
    get(ctx: Context): Promise<{
      readonly message: {
        readonly case?: string;
        readonly value?: {
          readonly tool?: {
            readonly case?: string;
            readonly value?: { readonly result?: { readonly result?: { readonly case?: string } } };
          };
        };
      };
    }>;
  }[];
  readonly userMessage: {
    get(ctx: Context): Promise<{
      readonly mode?: AgentMode | undefined;
      readonly selectedContext?: PromptTokenTrackingParamsLike["selectedContext"];
      readonly messageId?: string | undefined;
    }>;
  };
  appendPromptMessages(messages: ReturnType<typeof toRedactedCoreMessages>): void;
  upsertToolCall(ctx: Context, toolCall: unknown, toolCallId?: string): Promise<unknown>;
}

interface RunStepStateHandlerLike extends RetryStateHandlerLike, SummarizationStateHandler {
  mode?: AgentMode | undefined;
  lastStepInvocationId?: string | undefined;
  lastSkillCatalogBudgetStrategy?: string | undefined;
  getPrivacyMode(): PrivacyMode;
  assertRootPromptBlobsLoadedForFullPromptRead(): void;
  invalidateRootPromptPrefix(): void;
  computeNewStructure(ctx: Context): Promise<{ pendingToolCalls: unknown[] }>;
  setTokenDetails(tokenDetails: ReturnType<typeof createRedactedConversationTokenDetails>): void;
  addTurnUsage(usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly reasoningTokens: number;
  }): void;
  setMode(mode: AgentMode): void;
  createAgentTurn(
    ctx: Context,
    userMessage: unknown,
    requestContext: unknown,
    config: unknown,
    resourceAccessor: unknown,
  ): Promise<RunStepTurnLike>;
  hasCompletedAskQuestion(toolCallId: string): boolean;
  markAskQuestionCompleted(toolCallId: string): void;
  readonly readPaths: ReadonlySet<string>;
  readonly backgroundSummarizationCancellationToken: { cancelled: boolean } | undefined;
  readonly selfSummaryInputLimitFailureTokenCount: number | undefined;
  generateModeChangeContent(config: unknown, requestContext: unknown, previousMode?: AgentMode): string;
}

interface RetryOrchestratorLike {
  shouldStartBackgroundSummarization(...args: unknown[]): boolean;
  handleSummarization(...args: unknown[]): Promise<void>;
  canUseSelfSummary(args: { readonly tools: unknown; readonly extraT: unknown }): boolean;
}

type ToolCountingExecutorLike = Parameters<ReturnType<typeof createToolCountingMiddleware>>[0];

interface StepExecutorsLike {
    readonly rootPromptExecutor: RetryRootPromptExecutorLike;
  readonly wrappedPromptExecutor: ToolCountingExecutorLike;
}

interface EmptyResponseRetryTurnBudgetLike {
  retriesUsed: number;
}

interface MaxOutputTokenRetryDebugLike {
  readonly didAddOutputTokenReminder: boolean;
  readonly outputTokenLimitRetryCount: number;
  readonly didRetryAfterEmptyResponse: boolean;
  readonly retryLoopIteration: number;
  readonly emptyResponseRetryTurnBudget: EmptyResponseRetryTurnBudgetLike | undefined;
}

interface StepToolCountingStateLike {
  readonly toolCallCount: number;
  hasFailedToolCalls(): "true" | "false";
  hasUnexpectedToolCallErrors(): "true" | "false";
}

interface RequestContextToolLike extends McpInputSchemaLike {
  readonly name: string;
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description: string;
}

interface RedactedRequestContextToolLike {
  readonly _privacyMode: unknown;
  readonly name: string;
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description: {
    unwrap(purpose: PrivacyCapability, options?: unknown): string;
  };
  readonly inputSchema?: unknown;
  readonly inputSchemaJson?: string | undefined;
}

type RequestContextToolInputLike = RequestContextToolLike | RedactedRequestContextToolLike;

interface MergedRequestContextToolLike {
  readonly name: string;
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly clientKey?: string | undefined;
}

interface SetupStepStateHandlerLike {
  readonly mode?: AgentMode | undefined;
  setMode(mode: AgentMode): void;
}

interface SetupStepTurnLike {
  readonly userMessage: {
    get(ctx: Context): Promise<{ readonly mode?: AgentMode | undefined }>;
  };
}

interface PostStepTurnLike extends SetupStepTurnLike {
  appendPromptMessages(messages: ReturnType<typeof toRedactedCoreMessages>): void;
}

interface InteractionListenerLike {
  sendUpdate(ctx: Context, update: unknown): Promise<void>;
  query(ctx: Context, query: unknown): Promise<any>;
  enqueuePostTurnEndedWork?: ((work: () => Promise<unknown>) => void) | undefined;
}

interface PromptSuggestionStreamResultLike {
  readonly response: Promise<unknown>;
  readonly fullStream: AsyncIterable<{ readonly type: string; readonly textDelta?: string | undefined }>;
  readonly extendedUsage: Promise<{ readonly inputTokens: number; readonly cacheReadTokens: number }>;
}

interface ResponseComparisonCandidateLike {
  readonly ctx: Context;
  readonly parentInvocationId: string;
  readonly responseText: string;
  readonly messages: readonly CoreMessageLike[];
  readonly tools: readonly unknown[];
  readonly privacyMode: PrivacyMode;
  readonly sequence: number;
}

interface ResponseComparisonPendingBaseLike {
  readonly kind: "awaiting-parent" | "parent-ready";
  readonly ctx: Context;
  readonly parentInvocationId: string;
  readonly messages: readonly CoreMessageLike[];
  readonly tools: readonly unknown[];
  readonly privacyMode: PrivacyMode;
  readonly preparedAttempt: PreparedResponseComparisonAttemptLike;
  readonly comparisonId: string;
  readonly alternateInvocationId: string;
}

type ResponseComparisonPendingLike =
  | (ResponseComparisonPendingBaseLike & { readonly kind: "awaiting-parent"; readonly parentResponse?: undefined })
  | (ResponseComparisonPendingBaseLike & { readonly kind: "parent-ready"; readonly parentResponse: string });

interface ResponseComparisonRunArgsLike {
  readonly ctx: Context;
  readonly parentInvocationId: string;
  readonly parentResponse: string;
  readonly messages: readonly CoreMessageLike[];
  readonly tools: readonly unknown[];
  readonly privacyMode: PrivacyMode;
  readonly selection: ResponseComparisonSelectionLike;
  readonly preparedAttempt: PreparedResponseComparisonAttemptLike;
  readonly pendingUi: boolean;
  readonly comparisonId?: string | undefined;
  readonly alternateInvocationId?: string | undefined;
}

type ResponseComparisonEventLike =
  | { readonly case: "started"; readonly value: ResponseComparisonStarted }
  | { readonly case: "textDelta"; readonly value: ResponseComparisonTextDelta }
  | { readonly case: "completed"; readonly value: ResponseComparisonCompleted }
  | { readonly case: "skipped"; readonly value: ResponseComparisonSkipped };

interface SplitStepStateMutationTarget {
  readonly mode?: AgentMode | undefined;
  readonly turns: readonly { get(ctx: Context): Promise<unknown> }[];
  getBlobStore(): unknown;
  setActiveBranchName(branchName: string | undefined): void;
  persistSubagentState(ctx: Context, subagentId: string, subagentType: unknown, state: Partial<Record<string, unknown>>): void;
  setPlan(plan: unknown | undefined): void;
  setMode(mode: AgentMode): void;
  setTodos(todos: readonly unknown[]): void;
  upsertPlanEntry(entry: unknown): void;
  setGoalState(goalState: unknown): void;
  appendCommunicateUpdateHistoryEntry(entry: unknown): void;
  recordReadPath(path: { unwrap(purpose: PrivacyCapability): string }): void;
  markAskQuestionCompleted?: (originalToolCallId: string) => void;
  getPrivacyMode(): PrivacyMode;
}

interface SplitStepTurnLike {
  upsertToolCall(ctx: Context, toolCall: unknown, toolCallId?: string): Promise<void>;
}

interface SplitStepToolCallRecorderLike {
  recordToolCall(toolCall: unknown, toolCallId?: string): void;
  recordPendingToolCall(ctx: Context, toolCall: unknown, toolCallId?: string): Promise<void>;
  upsertToolCall(ctx: Context, toolCall: unknown, toolCallId?: string): Promise<void>;
}

interface SplitStepReplayToolCallRecorderLike {
  recordToolCall(
    toolCall: Parameters<AgentConversationTurnHandle["recordToolCall"]>[0],
    toolCallId?: string,
  ): void;
  upsertToolCall(
    ctx: Context,
    toolCall: Parameters<AgentConversationTurnHandle["recordToolCall"]>[0],
    toolCallId?: string,
  ): Promise<void>;
}

interface SplitStepStateOpBase {
  readonly type: string;
}

type SplitStepStateOp =
  | (SplitStepStateOpBase & { readonly type: "setActiveBranchName"; readonly branchName: string | undefined })
  | (SplitStepStateOpBase & { readonly type: "persistSubagentState"; readonly subagentId: string; readonly subagentType: unknown; readonly state: Partial<Record<string, unknown>> })
  | (SplitStepStateOpBase & { readonly type: "setPlan"; readonly plan: unknown | undefined })
  | (SplitStepStateOpBase & { readonly type: "setMode"; readonly mode: AgentMode })
  | (SplitStepStateOpBase & { readonly type: "setTodos"; readonly todos: readonly unknown[] })
  | (SplitStepStateOpBase & { readonly type: "upsertPlanEntry"; readonly entry: unknown })
  | (SplitStepStateOpBase & { readonly type: "setGoalState"; readonly goalState: unknown })
  | (SplitStepStateOpBase & { readonly type: "appendCommunicateUpdateHistoryEntry"; readonly entry: unknown })
  | (SplitStepStateOpBase & { readonly type: "recordToolCall"; readonly toolCall: unknown; readonly toolCallId?: string | undefined })
  | (SplitStepStateOpBase & { readonly type: "recordReadPath"; readonly path: string })
  | (SplitStepStateOpBase & { readonly type: "markAskQuestionCompleted"; readonly originalToolCallId: string });

interface DeferredSplitStepDataLike {
  readonly allowedToolNames?: readonly string[] | undefined;
  stepReadPathDedup?: Set<string> | undefined;
}

interface ToolExecutionContextLike {
  readonly toolMap: Record<string, DeferredExecutableToolLike>;
  readonly interactionHandler: InteractionHandler;
  readonly extraT: UnknownRecord;
  readonly renderProps: { readonly allTools: Record<string, unknown> };
  readonly directDynamicToolNames: Set<string>;
  readonly recordToolCallResult: InteractionHandler["recordToolCallResult"];
}

interface DeferredExecutableToolLike extends Record<string, unknown> {
  readonly name: string;
  readonly toolIdentifier: string;
  readonly dynamicToolMetaRole?: string;
  readonly customToolFormat?: unknown;
  readonly prepareSubagent?: ((ctx: Context, args: unknown, metadata: Record<string, unknown>) => unknown | Promise<unknown>);
}

interface DeferredToolCallResultLike {
  readonly resultMessage: CoreMessageLike;
  readonly stateOps?: readonly SplitStepStateOp[] | undefined;
}

function isCoreMessageLike(value: Record<string, unknown>): value is CoreMessageLike {
  return typeof value.role === "string" && "content" in value;
}

function isDeferredExecutableTool(value: unknown): value is DeferredExecutableToolLike {
  return typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "toolIdentifier" in value &&
    typeof value.toolIdentifier === "string";
}

function createSplitStepStateHandler(
  stateHandler: SplitStepStateMutationTarget,
  turn: SplitStepTurnLike,
): {
  readonly stateHandler: SplitStepStateMutationTarget;
  readonly toolCallRecorder: SplitStepToolCallRecorderLike;
  readonly stateOps: SplitStepStateOp[];
} {
  const stateOps: SplitStepStateOp[] = [];
  const splitStateHandler = new Proxy(stateHandler, {
    get(target, property, receiver) {
      if (property === "setActiveBranchName") {
        return (branchName: string | undefined) => {
          stateOps.push({ type: "setActiveBranchName", branchName });
          return target.setActiveBranchName(branchName);
        };
      }
      if (property === "persistSubagentState") {
        return (ctx: Context, subagentId: string, subagentType: unknown, state: Partial<Record<string, unknown>>) => {
          stateOps.push({ type: "persistSubagentState", subagentId, subagentType, state });
          return target.persistSubagentState(ctx, subagentId, subagentType, state);
        };
      }
      if (property === "setPlan") {
        return (plan: unknown | undefined) => {
          stateOps.push({
            type: "setPlan",
            plan: plan === undefined ? undefined : fromRedactedConversationPlan(plan, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
          });
          return target.setPlan(plan);
        };
      }
      if (property === "setMode") {
        return (mode: AgentMode) => {
          stateOps.push({ type: "setMode", mode });
          return target.setMode(mode);
        };
      }
      if (property === "setTodos") {
        return (todos: readonly unknown[]) => {
          stateOps.push({
            type: "setTodos",
            todos: todos.map(todo => fromRedactedTodoItem(todo, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)),
          });
          return target.setTodos(todos);
        };
      }
      if (property === "upsertPlanEntry") {
        return (entry: unknown) => {
          stateOps.push({ type: "upsertPlanEntry", entry });
          return target.upsertPlanEntry(entry);
        };
      }
      if (property === "setGoalState") {
        return (goalState: unknown) => {
          stateOps.push({ type: "setGoalState", goalState });
          return target.setGoalState(goalState);
        };
      }
      if (property === "appendCommunicateUpdateHistoryEntry") {
        return (entry: unknown) => {
          stateOps.push({ type: "appendCommunicateUpdateHistoryEntry", entry });
          return target.appendCommunicateUpdateHistoryEntry(entry);
        };
      }
      if (property === "recordReadPath") {
        return (path: { unwrap(purpose: PrivacyCapability): string }) => {
          stateOps.push({ type: "recordReadPath", path: path.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) });
          return target.recordReadPath(path);
        };
      }
      if (property === "markAskQuestionCompleted") {
        return (originalToolCallId: string) => {
          stateOps.push({ type: "markAskQuestionCompleted", originalToolCallId });
          return target.markAskQuestionCompleted?.(originalToolCallId);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const splitToolCallRecorder: SplitStepToolCallRecorderLike = {
    recordToolCall(toolCall, toolCallId) {
      stateOps.push({
        type: "recordToolCall",
        toolCall: fromRedactedToolCall(toolCall, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
        toolCallId,
      });
    },
    async recordPendingToolCall(ctx, toolCall, toolCallId) {
      await turn.upsertToolCall(ctx, toolCall, toolCallId);
    },
    async upsertToolCall(_ctx, toolCall, toolCallId) {
      stateOps.push({
        type: "recordToolCall",
        toolCall: fromRedactedToolCall(toolCall, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
        toolCallId,
      });
    },
  };
  return { stateHandler: splitStateHandler, toolCallRecorder: splitToolCallRecorder, stateOps };
}

async function applyConversationStateOp(
  ctx: Context,
  stateHandler: SplitStepStateMutationTarget,
  toolCallRecorder: SplitStepReplayToolCallRecorderLike,
  stateOp: SplitStepStateOp,
): Promise<void> {
  switch (stateOp.type) {
    case "setActiveBranchName":
      stateHandler.setActiveBranchName(stateOp.branchName);
      break;
    case "persistSubagentState":
      stateHandler.persistSubagentState(ctx, stateOp.subagentId, stateOp.subagentType, stateOp.state);
      break;
    case "setPlan":
      stateHandler.setPlan(stateOp.plan === undefined ? undefined : toRedactedConversationPlan(stateOp.plan, stateHandler.getPrivacyMode()));
      break;
    case "setMode":
      stateHandler.setMode(stateOp.mode);
      break;
    case "setTodos":
      stateHandler.setTodos(stateOp.todos.map(todo => toRedactedTodoItem(todo, stateHandler.getPrivacyMode())));
      break;
    case "upsertPlanEntry":
      stateHandler.upsertPlanEntry(stateOp.entry);
      break;
    case "setGoalState":
      stateHandler.setGoalState(stateOp.goalState);
      break;
    case "appendCommunicateUpdateHistoryEntry":
      stateHandler.appendCommunicateUpdateHistoryEntry(stateOp.entry);
      break;
    case "recordToolCall":
      const toolCall = stateOp.toolCall as { readonly tool?: { readonly case?: string } };
      if (toolCall.tool?.case === "askQuestionToolCall" && stateOp.toolCallId !== undefined) {
        await toolCallRecorder.upsertToolCall(ctx, toRedactedToolCall(stateOp.toolCall, stateHandler.getPrivacyMode()), stateOp.toolCallId);
      } else {
        toolCallRecorder.recordToolCall(toRedactedToolCall(stateOp.toolCall, stateHandler.getPrivacyMode()), stateOp.toolCallId);
      }
      break;
    case "recordReadPath":
      stateHandler.recordReadPath(safeString(stateOp.path));
      break;
    case "markAskQuestionCompleted":
      if (typeof stateHandler.markAskQuestionCompleted === "function") {
        stateHandler.markAskQuestionCompleted(stateOp.originalToolCallId);
      }
      break;
    default: {
      const exhaustiveCheck: never = stateOp;
      throw new Error(`Unhandled conversation state op: ${exhaustiveCheck}`);
    }
  }
}

export class AbstractUserMessageActionHandler {
  protected readonly config: UserMessageActionHandlerConfig;
  protected readonly resourceAccessor: RequestContextResources & {
    get(resource: typeof agentStoreConflictNoticeExecutorResource): Parameters<typeof conflictNoticeSyncAndPeek>[0] | undefined;
  };
  protected readonly interactionListener: InteractionListenerLike;
  protected readonly summarizationHandler: unknown;
  protected readonly conversationActionReceiver: ConversationActionReceiverLike;
  protected readonly orchestrator: RetryOrchestratorLike;
  private cachedAutomationTriggerContext: string | undefined | null = null;
  private responseComparisonSequence = 0;
  private responseComparisonPendingUiAttempted = false;
  private responseComparisonModelStepStarted = false;
  private responseComparisonWarmupsInTurn = 0;
  private pendingResponseComparison: ResponseComparisonPendingLike | undefined;
  private responseComparisonCandidate: ResponseComparisonCandidateLike | undefined;

  constructor(
    config: UserMessageActionHandlerConfig,
    resourceAccessor: RequestContextResources & {
      get(resource: typeof agentStoreConflictNoticeExecutorResource): Parameters<typeof conflictNoticeSyncAndPeek>[0] | undefined;
    },
    interactionListener: InteractionListenerLike,
    summarizationHandler: unknown,
    conversationActionReceiver: ConversationActionReceiverLike,
    orchestrator: RetryOrchestratorLike,
  ) {
    this.config = config;
    this.resourceAccessor = resourceAccessor;
    this.interactionListener = interactionListener;
    this.summarizationHandler = summarizationHandler;
    this.conversationActionReceiver = conversationActionReceiver;
    this.orchestrator = orchestrator;
  }

  resolveWriteBarrierTimeoutMs(): number | undefined {
    return this.config.resolveWriteBarrierTimeoutMs?.() ?? this.config.featureFlags?.writeBarrierTimeoutMs;
  }

  getAutomationTriggerContext(
    messages: Parameters<typeof extractAutomationTriggerContext>[0],
  ): string | undefined {
    if (this.config.automationInstructions === void 0) return undefined;
    if (this.cachedAutomationTriggerContext !== null) return this.cachedAutomationTriggerContext;
    const result = extractAutomationTriggerContext(messages);
    this.cachedAutomationTriggerContext = result;
    return result;
  }

  getUserPermissionsFileAutoRunInstructions(
    ctx: Context,
    requestContext: SmartModeRequestContextLike,
  ): Promise<Awaited<ReturnType<typeof loadUserPermissionsFileAutoRunInstructions>>> {
    if (!this.config.smartModeClassifierMode && !this.config.smartModeClassifierShadowMode) {
      return Promise.resolve(undefined);
    }
    const { userAutoRunInstructions, hasAdminOverride } = smartModeAutoRunInstructionsFromProtos(requestContext);
    if (hasAdminOverride) return Promise.resolve(undefined);
    if (userAutoRunInstructions !== undefined) return Promise.resolve(userAutoRunInstructions);
    return loadUserPermissionsFileAutoRunInstructions(ctx);
  }

  getProjectPermissionsFileAutoRunInstructions(
    requestContext: SmartModeRequestContextLike,
  ) {
    const { projectAutoRunInstructions } = smartModeAutoRunInstructionsFromProtos(requestContext);
    return projectAutoRunInstructions;
  }

  tapAgentResponseComparisonWarmup(
    ctx: Context,
    fullStream: AsyncIterable<ResponseComparisonStreamPartLike>,
    messages: readonly CoreMessageLike[] | undefined,
    tools: readonly unknown[] | undefined,
  ): AsyncIterable<ResponseComparisonStreamPartLike> {
    const capability = this.config.agentResponseComparison;
    if (capability?.warm === undefined || messages === undefined || tools === undefined || this.pendingResponseComparison === undefined) {
      return fullStream;
    }
    const maybeWarm = () => this.maybeWarmAgentResponseComparison(ctx, capability, messages, tools);
    return (async function* () {
      let warmTriggered = false;
      for await (const part of fullStream) {
        if (!warmTriggered && part.type === "text-delta") {
          warmTriggered = true;
          maybeWarm();
        }
        yield part;
      }
    })();
  }

  maybeWarmAgentResponseComparison(
    ctx: Context,
    capability: AgentResponseComparisonCapabilityLike,
    messages: readonly CoreMessageLike[],
    tools: readonly unknown[],
  ): void {
    const pending = this.pendingResponseComparison;
    if (pending === undefined || capability.warm === undefined || this.responseComparisonWarmupsInTurn >= MAX_RESPONSE_COMPARISON_WARMUPS_PER_TURN) return;
    this.responseComparisonWarmupsInTurn += 1;
    void capability.warm({ ctx, selection: pending.preparedAttempt.selection, messages, tools }).catch(error => {
      logger.warn(ctx, "Agent response comparison warmup failed open", { error });
  });
}

  async preparePendingAgentResponseComparison(args: {
    readonly ctx: Context;
    readonly parentInvocationId: string;
    readonly messages: readonly CoreMessageLike[];
    readonly tools: readonly unknown[];
    readonly privacyMode: PrivacyMode;
  }): Promise<void> {
    const capability = this.config.agentResponseComparison;
    if (this.responseComparisonPendingUiAttempted || capability?.supportsPendingUi !== true || capability.preselect === undefined || this.interactionListener.enqueuePostTurnEndedWork === undefined || args.privacyMode !== PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED) return;
    this.responseComparisonPendingUiAttempted = true;
    let preparedAttempt: PreparedResponseComparisonAttemptLike | undefined;
    try {
      preparedAttempt = await capability.preselect({
        isByok: getIsUserApiKeyFromContext(args.ctx),
        isSubagent: getIsSubagentFromContext(args.ctx),
      });
    } catch (error) {
      logger.warn(args.ctx, "Agent response comparison preselection failed open", { error });
      return;
    }
    if (preparedAttempt === undefined) return;
    const pending: ResponseComparisonPendingLike = {
      kind: "awaiting-parent",
      ...args,
      preparedAttempt,
      comparisonId: randomUUID(),
      alternateInvocationId: getInvocationId(args.ctx),
    };
    this.pendingResponseComparison = pending;
    try {
      await this.sendAgentResponseComparisonEvent({
        ctx: args.ctx,
        privacyMode: args.privacyMode,
        comparisonId: pending.comparisonId,
        event: {
          case: "started",
          value: new ResponseComparisonStarted({
            displayOrder: preparedAttempt.selection.displayOrder === "parent-first" ? ResponseComparisonDisplayOrder.PARENT_FIRST : ResponseComparisonDisplayOrder.ALTERNATE_FIRST,
            parentInvocationId: args.parentInvocationId,
            alternateInvocationId: pending.alternateInvocationId,
            parentResponse: "",
            comparisonConfigId: preparedAttempt.selection.comparisonConfigId,
            alternateModelId: alternateModelIdForAnalytics(preparedAttempt.selection),
          }),
        },
      });
    } catch (error) {
      this.pendingResponseComparison = undefined;
      logger.warn(args.ctx, "Agent response comparison pending update failed open", { error });
    }
  }

  async finalizePendingAgentResponseComparison(shouldCompare: boolean): Promise<void> {
    const pending = this.pendingResponseComparison;
    if (pending === undefined) return;
    if (!shouldCompare || pending.kind !== "parent-ready") {
      await this.cancelPendingAgentResponseComparison();
      return;
    }
    this.pendingResponseComparison = undefined;
    this.interactionListener.enqueuePostTurnEndedWork?.(() => this.runAgentResponseComparison({
      ctx: pending.ctx,
      parentInvocationId: pending.parentInvocationId,
      parentResponse: pending.parentResponse,
      messages: pending.messages,
      tools: pending.tools,
      privacyMode: pending.privacyMode,
      selection: pending.preparedAttempt.selection,
      preparedAttempt: pending.preparedAttempt,
      pendingUi: true,
      comparisonId: pending.comparisonId,
      alternateInvocationId: pending.alternateInvocationId,
    }));
  }

  async cancelPendingAgentResponseComparison(
    reason: ResponseComparisonSkipReason = ResponseComparisonSkipReason.CANCELLED,
  ): Promise<void> {
    const pending = this.pendingResponseComparison;
    if (pending === undefined) return;
    this.pendingResponseComparison = undefined;
    try {
      await this.sendAgentResponseComparisonEvent({
        ctx: pending.ctx,
        privacyMode: pending.privacyMode,
        comparisonId: pending.comparisonId,
        event: { case: "skipped", value: new ResponseComparisonSkipped({ reason }) },
      });
    } catch (error) {
      logger.warn(pending.ctx, "Agent response comparison skip update failed open", { error });
    }
  }

  async enqueueAgentResponseComparisonIfEligible(args: {
    readonly ctx: Context;
    readonly parentInvocationId: string;
    readonly responseMessages: readonly CoreMessageLike[];
    readonly messages: readonly CoreMessageLike[];
    readonly tools: readonly unknown[];
    readonly privacyMode: PrivacyMode;
  }): Promise<void> {
    const capability = this.config.agentResponseComparison;
    if (capability === undefined || this.interactionListener.enqueuePostTurnEndedWork === undefined) return;
    if (capability.supportsPendingUi && this.responseComparisonPendingUiAttempted) {
      const pending = this.pendingResponseComparison;
      if (pending === undefined) return;
      if (args.privacyMode !== PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED || containsToolCall(args.responseMessages)) {
        await this.cancelPendingAgentResponseComparison();
        return;
      }
      const finalAssistantMessage = [...args.responseMessages].reverse().find(message => message.role === "assistant");
      const responseText = finalAssistantMessage === undefined ? undefined : extractAssistantText(finalAssistantMessage);
      if (responseText === undefined || !pending.preparedAttempt.isParentLengthEligible(responseText)) {
        await this.cancelPendingAgentResponseComparison();
        return;
      }
      this.pendingResponseComparison = {
        ...pending,
        kind: "parent-ready",
        parentInvocationId: args.parentInvocationId,
        parentResponse: responseText,
        messages: args.messages,
        tools: args.tools,
      };
      return;
    }
    if (args.privacyMode !== PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED || containsToolCall(args.responseMessages)) {
      this.responseComparisonCandidate = undefined;
      return;
    }
    const finalAssistantMessage = [...args.responseMessages].reverse().find(message => message.role === "assistant");
    const responseText = finalAssistantMessage === undefined ? undefined : extractAssistantText(finalAssistantMessage);
    if (responseText === undefined || responseText.length === 0) {
      this.responseComparisonCandidate = undefined;
      return;
    }
    const sequence = ++this.responseComparisonSequence;
    this.responseComparisonCandidate = { ...args, responseText, sequence };
    this.interactionListener.enqueuePostTurnEndedWork(() => this.runPendingAgentResponseComparison(capability, sequence));
  }

  async runPendingAgentResponseComparison(
    capability: AgentResponseComparisonCapabilityLike,
    sequence: number,
  ): Promise<void> {
    const candidate = this.responseComparisonCandidate;
    if (candidate === undefined || candidate.sequence !== sequence) return;
    this.responseComparisonCandidate = undefined;
    if (candidate.privacyMode !== PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED || capability.resolve === undefined) return;
    let preparedAttempt: PreparedResponseComparisonAttemptLike | undefined;
    try {
      preparedAttempt = await capability.resolve({
        responseText: candidate.responseText,
        isByok: getIsUserApiKeyFromContext(candidate.ctx),
        isSubagent: getIsSubagentFromContext(candidate.ctx),
      });
    } catch (error) {
      logger.warn(candidate.ctx, "Agent response comparison selection failed open", { error });
      return;
    }
    if (preparedAttempt === undefined) return;
    await this.runAgentResponseComparison({
      ctx: candidate.ctx,
      parentInvocationId: candidate.parentInvocationId,
      parentResponse: candidate.responseText,
      messages: candidate.messages,
      tools: candidate.tools,
      privacyMode: candidate.privacyMode,
      selection: preparedAttempt.selection,
      preparedAttempt,
      pendingUi: false,
    });
  }

  async runAgentResponseComparison(args: ResponseComparisonRunArgsLike): Promise<void> {
    const capability = this.config.agentResponseComparison;
    if (capability === undefined || args.privacyMode !== PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED) return;
    const comparisonId = args.comparisonId ?? randomUUID();
    const alternateInvocationId = args.alternateInvocationId ?? getInvocationId(args.ctx);
    const comparisonCtx = args.ctx.withTimeout(AGENT_RESPONSE_COMPARISON_TIMEOUT_MS);
    const sendEvent = async (event: ResponseComparisonEventLike, eventCtx: Context = comparisonCtx) => {
      await this.sendAgentResponseComparisonEvent({ ctx: eventCtx, privacyMode: args.privacyMode, comparisonId, event });
    };
    let result: ResponseComparisonResultLike | undefined;
    try {
      let selection = args.selection;
      if (capability.refineSelection !== undefined) {
        try {
          const refined = await capability.refineSelection({ ctx: comparisonCtx, parentResponse: args.parentResponse, messages: args.messages, selection });
          if (refined === undefined) {
            await sendEvent({ case: "skipped", value: new ResponseComparisonSkipped({ reason: ResponseComparisonSkipReason.CANCELLED }) });
            return;
          }
          selection = refined;
        } catch (error) {
          logger.warn(args.ctx, "Agent response comparison selection refinement failed open", { error });
        }
      }
      if (!args.pendingUi) {
        await sendEvent({ case: "started", value: new ResponseComparisonStarted({ displayOrder: selection.displayOrder === "parent-first" ? ResponseComparisonDisplayOrder.PARENT_FIRST : ResponseComparisonDisplayOrder.ALTERNATE_FIRST, parentInvocationId: args.parentInvocationId, alternateInvocationId, parentResponse: args.parentResponse, comparisonConfigId: selection.comparisonConfigId, alternateModelId: alternateModelIdForAnalytics(selection) }) });
      }
      result = capability.execute({ ctx: comparisonCtx, selection, messages: args.messages, tools: args.tools, invocationId: alternateInvocationId });
      let sawToolCall = false;
      let exceededMaxResponseChars = false;
      let bufferedTextLength = 0;
      const bufferedTextDeltas: string[] = [];
      for await (const part of result.fullStream) {
        if (part.type === "tool-call-streaming-start" || part.type === "tool-call-delta" || part.type === "tool-call") {
          sawToolCall = true;
          continue;
        }
        if (!sawToolCall && !exceededMaxResponseChars && part.type === "text-delta") {
          const textDelta = part.textDelta ?? "";
          bufferedTextLength += textDelta.length;
          if (bufferedTextLength > args.preparedAttempt.maxResponseChars) {
            exceededMaxResponseChars = true;
            bufferedTextDeltas.length = 0;
            continue;
          }
          bufferedTextDeltas.push(textDelta);
        }
      }
      const response = await result.response;
      if (sawToolCall || containsToolCall(response.messages)) {
        await sendEvent({ case: "skipped", value: new ResponseComparisonSkipped({ reason: ResponseComparisonSkipReason.ALTERNATE_TOOL_CALL }) });
        return;
      }
      if (response.error !== undefined) throw response.error;
      if (exceededMaxResponseChars) {
        await sendEvent({ case: "skipped", value: new ResponseComparisonSkipped({ reason: ResponseComparisonSkipReason.CANCELLED }) });
        return;
      }
      const alternateResponse = bufferedTextDeltas.join("");
      if (alternateResponse.trim().length === 0) throw new Error("Alternate response completed without text");
      if (!args.preparedAttempt.hasSufficientCharacterDiff(args.parentResponse, alternateResponse)) {
        await sendEvent({ case: "skipped", value: new ResponseComparisonSkipped({ reason: ResponseComparisonSkipReason.CANCELLED }) });
        return;
      }
      if (!args.pendingUi && !await args.preparedAttempt.commitCooldown()) {
        await sendEvent({ case: "skipped", value: new ResponseComparisonSkipped({ reason: ResponseComparisonSkipReason.CANCELLED }) });
        return;
      }
      if (args.pendingUi) {
        await sendEvent({ case: "started", value: new ResponseComparisonStarted({ displayOrder: selection.displayOrder === "parent-first" ? ResponseComparisonDisplayOrder.PARENT_FIRST : ResponseComparisonDisplayOrder.ALTERNATE_FIRST, parentInvocationId: args.parentInvocationId, alternateInvocationId, parentResponse: args.parentResponse, comparisonConfigId: selection.comparisonConfigId, alternateModelId: alternateModelIdForAnalytics(selection) }) });
      }
      await sendEvent({ case: "textDelta", value: new ResponseComparisonTextDelta({ text: alternateResponse }) });
      if (args.pendingUi && !await args.preparedAttempt.commitCooldown()) {
        await sendEvent({ case: "skipped", value: new ResponseComparisonSkipped({ reason: ResponseComparisonSkipReason.CANCELLED }) });
        return;
      }
      await sendEvent({ case: "completed", value: new ResponseComparisonCompleted() });
    } catch (error) {
      const reason = args.ctx.signal.aborted ? ResponseComparisonSkipReason.CANCELLED : comparisonCtx.signal.aborted ? ResponseComparisonSkipReason.TIMEOUT : ResponseComparisonSkipReason.INFERENCE_ERROR;
      try {
        await sendEvent({ case: "skipped", value: new ResponseComparisonSkipped({ reason }) }, args.ctx);
      } catch (sendError) {
        logger.warn(args.ctx, "Agent response comparison failed open", { error, sendError });
      }
    } finally {
      if (result !== undefined) {
        void Promise.allSettled([result.response, result.usage, result.extendedUsage, result.providerMetadata, result.invocationId]);
      }
    }
  }

  async sendAgentResponseComparisonEvent(args: {
    readonly ctx: Context;
    readonly privacyMode: PrivacyMode;
    readonly comparisonId: string;
    readonly event: ResponseComparisonEventLike;
  }): Promise<void> {
    await this.interactionListener.sendUpdate(args.ctx, toRedactedInteractionUpdate(new InteractionUpdate({
      message: {
        case: "responseComparison",
        value: new ResponseComparisonUpdate({ comparisonId: args.comparisonId, event: args.event }),
      },
    }), args.privacyMode));
  }

  createAfterAgentThoughtCallback(invocationId: string, requestContext: {
    readonly hooksConfig?: { readonly configuredSteps?: readonly unknown[] | undefined } | undefined;
  }): (hookCtx: Context, params: { readonly text: string; readonly durationMs?: number | undefined }) => Promise<void> {
    return async (hookCtx, params) => {
      try {
        using span = createSpan(hookCtx.withName("agent.lifecycleHook.afterAgentThought"));
        await executeRemoteAfterAgentThoughtHook({
          ctx: span.ctx,
          text: params.text,
          durationMs: params.durationMs,
          requestContext: {
            toolCallId: `after-agent-thought:${this.config.conversationId ?? invocationId}:${invocationId}:v1`,
            conversationId: this.config.conversationId,
            generationId: invocationId,
            model: this.config.modelId,
            modelId: this.config.model?.mcid,
            modelParams: this.config.model?.parameters !== undefined ? [...this.config.model.parameters] : undefined,
          },
          options: {
            resourceAccessor: this.resourceAccessor,
            enableExecuteHookExec: this.config.enableExecuteHookExec,
            configuredSteps: requestContext.hooksConfig?.configuredSteps,
            model: this.config.modelId,
            modelId: this.config.model?.mcid,
            modelParams: this.config.model?.parameters !== undefined ? [...this.config.model.parameters] : undefined,
          },
        });
      } catch {
        // The immutable host deliberately fails lifecycle hooks open.
      }
    };
  }

  async runStep(
    parentCtx: Context,
    turn: RunStepTurnLike,
    rootPromptExecutor: RetryRootPromptExecutorLike,
    stateHandler: RunStepStateHandlerLike,
    toolsGenerator: AgentToolsGenerator,
    mcpTools: PromptTokenTrackingParamsLike["mcpTools"],
    repositoryInfos: readonly unknown[],
    requestContext: RequestContext,
    fileOperationLockManager: FileOperationLockManager,
    onStateUpdate: ((ctx: Context, state: { pendingToolCalls: unknown[] }) => Promise<void>) | undefined,
    previousQueuedMessageSource: unknown,
    maxOutputTokenRetryDebug: MaxOutputTokenRetryDebugLike | undefined,
  ): Promise<{ readonly hasToolCall: boolean; readonly responseMessages: readonly CoreMessageLike[] }> {
    using spanCtxt = createSpan(parentCtx.withName("runStep"));
    const ctx = spanCtxt.ctx;
    const invocationId = getInvocationId(ctx);
      stateHandler.lastStepInvocationId = invocationId;
      spanCtxt.span.setAttribute("invocationId", invocationId);
      logger.info(ctx, "Running step");
      const stepSetupStart = performance.now();
      const isFirstStep = turn.steps.length === 0;
      const isResponseComparisonFirstModelStep = !this.responseComparisonModelStepStarted;
      this.responseComparisonModelStepStarted = true;
      const interactionHandler = new InteractionHandler(
        toUnredactedInteractionListener(this.interactionListener, stateHandler.getPrivacyMode()),
        turn,
        invocationId,
        undefined,
        this.config.thinkingStyle,
        this.config.featureFlags?.nalLoopDetection === true,
        this.createAfterAgentThoughtCallback(invocationId, requestContext),
      );
      const userMessage = await turn.userMessage.get(ctx);
      const mode = resolveCurrentStepMode(stateHandler.mode, userMessage.mode);
      const toolSetHandle = toolsGenerator({
        resourceAccessor: this.resourceAccessor,
        stateHandler,
        agentSessionId: this.config.agentSessionId,
        mcpTools,
        repositoryInfos,
        blobStore: stateHandler.getBlobStore(),
        mode,
        loggingContext: ctx,
        requestContext,
        fileOperationLockManager,
        smartModeClassifierMode: this.config.smartModeClassifierMode,
        smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
        autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
      });
      const initialMessages = fromRedactedCoreMessages(
        rootPromptExecutor.getMessages(),
        PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
      );
      if (isFirstStep) {
        warnIfLongTrailingUserMessageRun(ctx, initialMessages as Parameters<typeof warnIfLongTrailingUserMessageRun>[1], invocationId);
        firstStepSetupDuration.histogram(ctx, performance.now() - stepSetupStart);
      }
      trackPromptTokenUsage({
        ctx,
        mcpTools,
        requestContext,
        messages: initialMessages,
        selectedContext: userMessage.selectedContext,
        userInfoDisplayOptions: this.config.userInfoDisplayOptions,
        agentTokenLimit: this.config.agentTokenLimit,
        readToolName: toolSetHandle.getTool("READ")?.name,
        invocationId,
        modelInfo: this.config.modelInfo,
        featureFlags: this.config.featureFlags,
        stateHandler,
      });
      const userAutoRunInstructions = await this.getUserPermissionsFileAutoRunInstructions(ctx, requestContext);
      const projectAutoRunInstructions = this.getProjectPermissionsFileAutoRunInstructions(requestContext);
      let responseComparisonMessages = this.config.agentResponseComparison === undefined
        ? undefined
        : [...initialMessages];
      let responseComparisonTools = this.config.agentResponseComparison === undefined
        ? undefined
        : Object.freeze(toAgentTools(toolSetHandle.getStaticTools(), toolSetHandle.getDescriptionProps()));
      if (
        isResponseComparisonFirstModelStep &&
        responseComparisonMessages !== undefined &&
        responseComparisonTools !== undefined
      ) {
        await this.preparePendingAgentResponseComparison({
          ctx,
          parentInvocationId: invocationId,
          messages: responseComparisonMessages,
          tools: responseComparisonTools,
          privacyMode: stateHandler.getPrivacyMode(),
        });
      }
      let result: StepStreamResultLike;
      try {
        result = rootPromptExecutor.executeToolStream(
          ctx,
          stateHandler,
          interactionHandler,
          toolSetHandle.getToolExecutionSet(),
          {
            repositoryInfos,
            shouldQueryProd: requestContext.repositoryInfoShouldQueryProd,
            stateHandler,
            strictArgParsing: this.config.strictArgParsing === true,
            enableToolArgPreservation: this.config.enableToolArgPreservation === true,
            enableHookAdditionalContext: this.config.featureFlags?.enableHookAdditionalContext === true,
            enableAgentStoreConflictNoticeCollector: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
            enableAgentStoreConflictNotices: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
            writeBarrierTimeoutMs: this.resolveWriteBarrierTimeoutMs(),
            onWriteBarrier: this.config.recordAgentStoreWriteBarrier,
            workspacePaths: requestContext.env?.workspacePaths,
            userAutoRunInstructions,
            projectAutoRunInstructions,
            cursorRules: getAllRules(requestContext, this.config.nonFileRules, this.config.featureFlags),
            agentSkills: requestContext.agentSkills ?? [],
            contextInjectionSignal: this.conversationActionReceiver.getContextInjectionToolSignal?.(),
          },
          interactionHandler.recordToolCallResult.bind(interactionHandler),
          toolSetHandle.getDescriptionProps(),
          this.config.maxSteps === 1
            ? undefined
            : async (pending: readonly string[] | undefined) => {
              const pendingToolCallStartedAtMs = Date.now();
              const toolExecutionSet = toolSetHandle.getToolExecutionSet();
              const allowedToolNames = toolExecutionSet.modelVisibleTools.map(tool => tool.name);
              const pendingWithContracts = (pending ?? []).map(pendingToolCall => enrichPendingToolCallJson(pendingToolCall, {
                resolveIdentity: input => toolSetHandle.resolveToolCallIdentity(input),
                toolExecutionSet,
                allowedToolNames,
                pendingToolCallStartedAtMs,
              }));
              if (this.config.fireAndForgetCheckpoints) {
                void stateHandler.computeNewStructure(ctx).then(async current => {
                  current.pendingToolCalls = pendingWithContracts.map(pendingToolCall => createRedactedString(
                    pendingToolCall,
                    DataClassification.CODE,
                    "pendingToolCalls",
                    PrivacyMode.UNSPECIFIED,
                  ));
                  if (onStateUpdate) await onStateUpdate(ctx, current);
                }).catch(error => {
                  logger.error(ctx, "Failed to persist checkpoint with pending tool calls", { error });
                });
              } else {
                const current = await stateHandler.computeNewStructure(ctx);
                current.pendingToolCalls = pendingWithContracts.map(pendingToolCall => createRedactedString(
                  pendingToolCall,
                  DataClassification.CODE,
                  "pendingToolCalls",
                  PrivacyMode.UNSPECIFIED,
                ));
                if (onStateUpdate) await onStateUpdate(ctx, current);
              }
            },
        );
      } catch (error) {
        await this.cancelPendingAgentResponseComparison();
        throw error;
      }
      const tokenDetails = stateHandler.tokenDetails;
      const isCloudAgentSingleStep = this.config.maxSteps === 1;
      const shouldSuppressSelfSummaryAfterInputLimitFailure = stateHandler.shouldSuppressSelfSummaryAfterInputLimitFailure(tokenDetails.usedTokens);
      const shouldStartBg = !isCloudAgentSingleStep &&
        !stateHandler.tokenDetailsStaleAfterSummarization &&
        !shouldSuppressSelfSummaryAfterInputLimitFailure &&
        this.orchestrator.shouldStartBackgroundSummarization(
          tokenDetails,
          rootPromptExecutor.getMessages(),
          ctx,
        );
      if (shouldStartBg) {
        logger.info(ctx, "[summarization-trigger] Triggering background summarization since we are below free token threshold", {
          usedTokens: tokenDetails.usedTokens,
          maxTokens: tokenDetails.maxTokens,
          backgroundSummarizationConfig: this.config.backgroundSummarizationProps,
        });
        await this.orchestrator.handleSummarization(
          ctx,
          stateHandler,
          rootPromptExecutor,
          this.interactionListener,
          this.config,
          requestContext,
          {
            backgroundSummarizationMode: BackgroundSummarizationMode.Background,
            triggerReason: "approaching_token_limit",
            currentInvocationId: invocationId,
            resourceAccessor: this.resourceAccessor,
            tools: toolSetHandle.getStaticTools(),
            descriptionProps: toolSetHandle.getDescriptionProps(),
            extraT: {
              repositoryInfos,
              shouldQueryProd: requestContext.repositoryInfoShouldQueryProd,
              stateHandler,
              strictArgParsing: this.config.strictArgParsing === true,
              enableToolArgPreservation: this.config.enableToolArgPreservation === true,
              enableHookAdditionalContext: this.config.featureFlags?.enableHookAdditionalContext === true,
              enableAgentStoreConflictNoticeCollector: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
              enableAgentStoreConflictNotices: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
              writeBarrierTimeoutMs: this.resolveWriteBarrierTimeoutMs(),
              onWriteBarrier: this.config.recordAgentStoreWriteBarrier,
              workspacePaths: requestContext.env?.workspacePaths,
              userAutoRunInstructions,
              projectAutoRunInstructions,
              cursorRules: getAllRules(requestContext, this.config.nonFileRules, this.config.featureFlags),
              agentSkills: requestContext.agentSkills ?? [],
            },
            automationTriggerContext: this.getAutomationTriggerContext(rootPromptExecutor.getMessages()),
          },
        );
      }
      let response: { readonly messages: readonly CoreMessageLike[]; readonly error?: unknown };
      let extendedUsage: Awaited<StepStreamResultLike["extendedUsage"]>;
      let usage: Awaited<StepStreamResultLike["usage"]>;
      let finalInvocationId: string;
      [response, extendedUsage, usage, finalInvocationId] = await Promise.all([
        result.response,
        result.extendedUsage,
        result.usage,
        result.invocationId,
        interactionHandler.consumeStream(
          ctx,
          this.tapAgentResponseComparisonWarmup(ctx, result.fullStream, responseComparisonMessages, responseComparisonTools),
          turn,
        ),
      ]);
      if (finalInvocationId !== invocationId) {
        logger.error(ctx, "Invocation ID mismatch. Bug in executeToolStream", undefined, {
          initialInvocationId: invocationId,
          finalInvocationId,
        });
      }
      logger.info(ctx, "Setting token details for client token ring", {
        usedTokens: usage.totalTokens,
        maxTokens: extendedUsage.maxTokens,
        inputTokens: extendedUsage.inputTokens,
        outputTokens: extendedUsage.outputTokens,
        cacheReadTokens: extendedUsage.cacheReadTokens,
        cacheWriteTokens: extendedUsage.cacheWriteTokens,
      });
      const promptContextDetails = nextRedactedPromptContextDetails(ctx, this.config, stateHandler, {
        messages: initialMessages,
        tools: toolSetHandle.getStaticTools(),
        descriptionProps: toolSetHandle.getDescriptionProps(),
        totalUsedTokens: usage.totalTokens,
        maxTokens: extendedUsage.maxTokens,
      });
      stateHandler.setTokenDetails(createRedactedConversationTokenDetails(stateHandler.getPrivacyMode(), {
        usedTokens: usage.totalTokens,
        maxTokens: extendedUsage.maxTokens,
        breakdown: promptContextDetails!.breakdown,
        promptContextUsageTree: promptContextDetails!.promptContextUsageTree,
      }));
      if (response.error || ctx.signal.aborted) {
        await this.cancelPendingAgentResponseComparison();
        if (this.config.skipErrorStateCheckpoint !== true) {
          turn.appendPromptMessages(toRedactedCoreMessages(response.messages, stateHandler.getPrivacyMode()));
          const currentState = await stateHandler.computeNewStructure(ctx);
          if (onStateUpdate) await onStateUpdate(ctx, currentState);
        }
        throw response.error ?? new ConnectError("User aborted request", Code.Canceled);
      }
      stateHandler.addTurnUsage({
        inputTokens: extendedUsage.inputTokens,
        outputTokens: extendedUsage.outputTokens,
        cacheReadTokens: extendedUsage.cacheReadTokens,
        cacheWriteTokens: extendedUsage.cacheWriteTokens,
        reasoningTokens: extendedUsage.reasoningTokens,
      });
      const hasToolCall = containsToolCall(response.messages);
      if (!hasToolCall && responseComparisonMessages !== undefined && responseComparisonTools !== undefined) {
        try {
          await this.enqueueAgentResponseComparisonIfEligible({
            ctx,
            parentInvocationId: finalInvocationId,
            responseMessages: response.messages,
            messages: responseComparisonMessages,
            tools: responseComparisonTools,
            privacyMode: stateHandler.getPrivacyMode(),
          });
        } finally {
          responseComparisonMessages = undefined;
          responseComparisonTools = undefined;
        }
      }
      if (extendedUsage) {
        let currentToolCallName = "userMessage";
        for (const message of response.messages) {
          if (message.role === "assistant" && Array.isArray(message.content)) {
            for (const part of message.content as AssistantContentPart[]) {
              if (part.type === "tool-call") {
                currentToolCallName = part.toolName ?? "userMessage";
                break;
              }
            }
            if (currentToolCallName !== "userMessage") break;
          }
        }
        const argsTags = { toolCallName: currentToolCallName };
        toolCallArgsOutputTokens.histogram(ctx, extendedUsage.outputTokens, argsTags);
        toolCallArgsCacheWriteTokens.histogram(ctx, extendedUsage.cacheWriteTokens, argsTags);
        let priorToolCallName = "userMessage";
        if (turn.steps.length > 0) {
          const lastStepRef = turn.steps[turn.steps.length - 1]!;
          const lastStep = await lastStepRef.get(ctx);
          if (lastStep.message.case === "toolCall") {
            const toolCase = lastStep.message.value?.tool?.case;
            if (toolCase !== undefined) priorToolCallName = toolCase.replace("ToolCall", "").replace(/_/g, "-");
          }
        }
        const resultTags = { toolCallName: priorToolCallName };
        toolCallResultInputTokens.histogram(ctx, extendedUsage.inputTokens, resultTags);
        toolCallResultCachedReadTokens.histogram(ctx, extendedUsage.cacheReadTokens, resultTags);
      }
      if (!hasToolCall && hasEmptyAssistantText(response.messages)) {
        const executorMessages = rootPromptExecutor.getMessages();
        const taskToolName = toolSetHandle.getTool("TASK")?.name ??
          (this.config.modelInfo !== undefined ? getTaskToolName(this.config.modelInfo) : undefined);
        const unwrappedExecutorMessages = fromRedactedCoreMessages(executorMessages, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
        const isTrailingTaskToolCall = isTrailingTaskToolCallMessage(unwrappedExecutorMessages, taskToolName, toolSetHandle);
        const executorMessageCount = executorMessages.length;
        const lastExecutorMsg = executorMessages.at(-1);
        const lastExecutorMsgRole = lastExecutorMsg?.role ?? "unknown";
        let thinkingChars = 0;
        for (const message of response.messages) {
          if (message.role === "assistant" && Array.isArray(message.content)) {
            for (const part of message.content as AssistantContentPart[]) {
              if (part.type === "reasoning" && typeof part.text === "string") thinkingChars += part.text.length;
            }
          }
        }
        const emptyResponseAttrs = {
          outputTokens: extendedUsage.outputTokens,
          inputTokens: extendedUsage.inputTokens,
          invocationId,
          earlyStopDebug: {
            hasThinkingContent: thinkingChars > 0,
            thinkingChars,
            lastExecutorMsgRole,
            executorMessageCount,
            previousQueuedMessageSource: previousQueuedMessageSource ?? "none",
            actionClass: this.constructor.name,
            maxOutputTokenRetry: maxOutputTokenRetryDebug ?? {
              didAddOutputTokenReminder: false,
              outputTokenLimitRetryCount: 0,
            },
          },
        };
        if (lastExecutorMsgRole === "assistant") logger.warn(ctx, "nal.empty_response.sent_assistant_message", emptyResponseAttrs);
        if (lastExecutorMsgRole === "tool") logger.warn(ctx, "nal.empty_response.sent_tool", emptyResponseAttrs);
        if (thinkingChars > 0) logger.warn(ctx, "nal.empty_response.received_only_thinking", emptyResponseAttrs);
        if (extendedUsage.outputTokens === 0) logger.warn(ctx, "nal.empty_response.received_no_output_tokens", emptyResponseAttrs);
        logger.warn(ctx, "nal.empty_response", emptyResponseAttrs);
        let retryAction: string;
        if (this.constructor.name === "ResumeActionHandler") retryAction = "ok_resume_action";
        else if (this.constructor.name === "BackgroundTaskCompletionActionHandler") retryAction = "ok_background_task_completion_action";
        else if (lastExecutorMsgRole === "tool") retryAction = "retry_tool_result";
        else if (lastExecutorMsgRole === "user") retryAction = "retry_user_msg";
        else if (extendedUsage.outputTokens === 0) retryAction = "retry_no_output_tokens";
        else if (thinkingChars > 0) retryAction = "retry_thinking_only";
        else retryAction = "fallthrough";
        const trailingUserMsg = lastExecutorMsg === undefined
          ? undefined
          : fromRedactedCoreMessages([lastExecutorMsg], PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)[0];
        const isTrailingNotificationUserMsg = retryAction === "retry_user_msg" &&
          trailingUserMsg !== undefined &&
          isNotificationOnlyUserMessage(trailingUserMsg as Parameters<typeof isNotificationOnlyUserMessage>[0]) &&
          !isGoalContinuationNotificationMessage(trailingUserMsg as Parameters<typeof isGoalContinuationNotificationMessage>[0]);
        const hasSendMessageCapability = toolSetHandle.getTool("SEND_MESSAGE") !== undefined;
        const deliveryOwed = hasSendMessageCapability && this.config.featureFlags?.sandSendMessageDeliveryOwed !== false
          ? await isSendMessageDeliveryOwed(ctx, stateHandler)
          : true;
        const hasTrailingToolFailure = trailingToolBatchHasFailure(unwrappedExecutorMessages);
        const deliveryObligationSatisfied = hasSendMessageCapability && !deliveryOwed && !hasTrailingToolFailure;
        const isRetryEnabled = this.config.featureFlags?.enableEmptyResponseRetry === true;
        const isMetaParentAgent = this.config.featureFlags?.glassMetaParentAgent === true;
        const isMultitaskMode = mode === AgentMode.MULTITASK;
        const alreadyRetried = maxOutputTokenRetryDebug?.didRetryAfterEmptyResponse === true;
        const isLastRetryLoopIteration = (maxOutputTokenRetryDebug?.retryLoopIteration ?? 0) >= MAX_RETRY_ITERATIONS - 1;
        const turnBudget = maxOutputTokenRetryDebug?.emptyResponseRetryTurnBudget;
        const turnRetriesUsed = turnBudget?.retriesUsed ?? 0;
        const turnBudgetExhausted = turnBudget !== undefined && turnRetriesUsed >= MAX_EMPTY_RESPONSE_RETRIES_PER_TURN;
        const shouldRetry = isRetryEnabled && !isMetaParentAgent && !isMultitaskMode && !alreadyRetried &&
          !isLastRetryLoopIteration && !turnBudgetExhausted && !isTrailingNotificationUserMsg &&
          !deliveryObligationSatisfied && retryAction !== "ok_resume_action" &&
          retryAction !== "ok_background_task_completion_action" && retryAction !== "fallthrough";
        const needsContinuationMessage = retryAction !== "retry_user_msg" && !isTrailingTaskToolCall;
        const retryInfo = {
          retryAction,
          isRetryEnabled,
          isMetaParentAgent,
          isMultitaskMode,
          isTrailingTaskToolCall,
          isTrailingNotificationUserMsg,
          hasSendMessageCapability,
          deliveryOwed,
          hasTrailingToolFailure,
          deliveryObligationSatisfied,
          alreadyRetried,
          isLastRetryLoopIteration,
          turnRetriesUsed,
          turnBudgetExhausted,
          maxEmptyResponseRetriesPerTurn: MAX_EMPTY_RESPONSE_RETRIES_PER_TURN,
        };
        logger.warn(ctx, "nal.empty_response.retry_dry_run", { ...emptyResponseAttrs, retryInfo, shouldRetry });
        emptyResponseRetryClassification.increment(ctx, 1, {
          retryAction,
          didRetry: shouldRetry ? "true" : "false",
        });
        if (shouldRetry) {
          await this.cancelPendingAgentResponseComparison();
          throw new EmptyResponseRetryError(retryAction, needsContinuationMessage);
        }
        if (turnBudgetExhausted) logger.warn(ctx, "nal.empty_response.turn_budget_exceeded", { ...emptyResponseAttrs, retryInfo });
        logger.warn(ctx, "nal.empty_response.did_not_retry", { ...emptyResponseAttrs, retryInfo });
      }
      return { hasToolCall, responseMessages: response.messages };
  }

  async runWithMaxTokensRetry<T>(
    parentCtx: Context,
    rootPromptExecutor: RetryRootPromptExecutorLike,
    fn: (ctx: Context, debug: MaxOutputTokenRetryDebugLike) => Promise<T>,
    emptyResponseRetryTurnBudget: EmptyResponseRetryTurnBudgetLike | undefined,
  ): Promise<T> {
    using spanContext = createSpan(parentCtx.withName("runWithMaxTokensRetry"));
    const ctx = spanContext.ctx;
    let didAddOutputTokenReminder = false;
    let outputTokenLimitRetryCount = 0;
    let didRetryAfterSingleMessageLoop = false;
    let didRetryAfterEmptyResponse = false;
    const isSingleMessageLoopRetryEnabled = this.config.featureFlags?.nalLoopDetection === true;
    for (let i = 0; i < MAX_RETRY_ITERATIONS; i += 1) {
      try {
        return await fn(ctx, {
          didAddOutputTokenReminder,
          outputTokenLimitRetryCount,
          didRetryAfterEmptyResponse,
          retryLoopIteration: i,
          emptyResponseRetryTurnBudget,
        });
      } catch (error) {
        if (error instanceof OutputTokensLimitExceededError) {
          outputTokenLimitRetryCount += 1;
          if (!didAddOutputTokenReminder) {
            didAddOutputTokenReminder = true;
            rootPromptExecutor.appendMessages(toRedactedCoreMessages([
              {
                role: "user",
                content: "<system_reminder>Your response was cut off because it exceeded the output token limit. Please break your work into smaller pieces. Continue from where you left off.</system_reminder>",
              },
            ], PrivacyMode.UNSPECIFIED));
            logger.info(ctx, "Hit max tokens error, added reminder");
          } else {
            logger.info(ctx, "Hit max tokens error, but already added reminder");
          }
        } else if (error instanceof EmptyResponseRetryError && !didRetryAfterEmptyResponse) {
          didRetryAfterEmptyResponse = true;
          if (emptyResponseRetryTurnBudget !== undefined) {
            emptyResponseRetryTurnBudget.retriesUsed += 1;
          }
          if (error.needsContinuationMessage) {
            rootPromptExecutor.appendMessages(toRedactedCoreMessages([
              { role: "user", content: EMPTY_RESPONSE_CONTINUATION_MESSAGE },
            ], PrivacyMode.UNSPECIFIED));
          }
          logger.info(ctx, "nal.empty_response.retrying", {
            retryAction: error.retryAction,
            needsContinuationMessage: error.needsContinuationMessage,
            turnRetriesUsed: emptyResponseRetryTurnBudget?.retriesUsed,
            maxEmptyResponseRetriesPerTurn: MAX_EMPTY_RESPONSE_RETRIES_PER_TURN,
          });
        } else if (isSingleMessageLoopRetryEnabled && error instanceof AgentLoopError && error.loopType === "singleMessage") {
          if (didRetryAfterSingleMessageLoop) {
            logger.warn(ctx, "Single-message loop detected again after retry", {
              loopKind: error.singleMessageLoopKind,
              repetitions: error.repetitions,
              period: error.period,
            });
            throw error;
          }
          didRetryAfterSingleMessageLoop = true;
          const reminder = createLoopReminderMessage({
            kind: error.singleMessageLoopKind ?? "single_message_multi_line",
          });
          rootPromptExecutor.appendMessages(toRedactedCoreMessages([reminder], PrivacyMode.UNSPECIFIED));
          logger.info(ctx, "Single-message loop detected, added reminder and retrying", {
            loopKind: error.singleMessageLoopKind,
            repetitions: error.repetitions,
            period: error.period,
          });
        } else {
          throw error;
        }
      }
    }
    throw new StepRetriesExhaustedError("step-retries");
  }

  async runWithSummarizationRetry<T>(
    parentCtx: Context,
    stateHandler: RetryStateHandlerLike,
    rootPromptExecutor: RetryRootPromptExecutorLike,
    requestContext: unknown,
    tools: unknown,
    extraT: unknown,
    descriptionProps: unknown,
    fn: (ctx: Context) => Promise<T>,
  ): Promise<T> {
    using spanContext = createSpan(parentCtx.withName("runWithSummarizationRetry"));
    const ctx = spanContext.ctx;
    const automationTriggerContext = this.getAutomationTriggerContext(rootPromptExecutor.getMessages());
    for (let i = 0; i < 5; i += 1) {
      try {
        const evalCompletionMode = EVAL_ENFORCED_WAIT_FOR_SUMMARIZATION_COMPLETION(ctx);
        const forcedSummarizationMode = shouldForceSummarizationForTesting(
          fromRedactedCoreMessages(rootPromptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
          evalCompletionMode,
        );
        if (forcedSummarizationMode !== undefined) {
          logger.info(ctx, "[summarization-trigger] Force summarization triggered", {
            evalCompletionMode,
            mode: forcedSummarizationMode,
          });
          await this.orchestrator.handleSummarization(ctx, stateHandler, rootPromptExecutor, this.interactionListener, this.config, requestContext, {
            backgroundSummarizationMode: forcedSummarizationMode,
            fullSummarization: true,
            triggerReason: "force_dev_testing",
            currentInvocationId: stateHandler.lastStepInvocationId,
            resourceAccessor: this.resourceAccessor,
            tools,
            extraT,
            descriptionProps,
            automationTriggerContext,
          });
        }
        if (
          stateHandler.backgroundSummarizationPromiseInfo !== null &&
          stateHandler.backgroundSummarizationHasCompleted &&
          !stateHandler.shouldSuppressSelfSummaryAfterInputLimitFailure(stateHandler.tokenDetails.usedTokens)
        ) {
          const midLoopTokenDetails = stateHandler.tokenDetails;
          const wouldMeetPersistThreshold = shouldPersistBackgroundSummarization(
            midLoopTokenDetails.usedTokens,
            midLoopTokenDetails.maxTokens,
            this.config.backgroundSummarizationProps,
          );
          const wouldMeetTriggerThreshold = shouldStartBackgroundSummarization(
            midLoopTokenDetails.usedTokens,
            midLoopTokenDetails.maxTokens,
            this.config.backgroundSummarizationProps,
          );
          const requireTriggerThreshold = this.config.backgroundSummarizationProps.requireTriggerThresholdForMidLoopPersist === true;
          const imageCountMidLoop = countImagePartsInMessages(
            fromRedactedCoreMessages(rootPromptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
          );
          const shouldPersistForImageThresholdMidLoop = imageCountMidLoop >= IMAGE_SUMMARIZATION_TRIGGER_COUNT;
          const shouldPersistMidLoop = shouldPersistForImageThresholdMidLoop || !requireTriggerThreshold || wouldMeetTriggerThreshold;
          logger.info(ctx, "[summarization-persist] Mid-loop background summarization persistence: checking persist threshold", {
            usedTokens: midLoopTokenDetails.usedTokens,
            maxTokens: midLoopTokenDetails.maxTokens,
            unusedTokens: midLoopTokenDetails.maxTokens - midLoopTokenDetails.usedTokens,
            wouldMeetPersistThreshold,
            wouldMeetTriggerThreshold,
            requireTriggerThreshold,
            imageCountMidLoop,
            imageThreshold: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
            shouldPersistForImageThresholdMidLoop,
            shouldPersistMidLoop,
            triggerThreshold: getBackgroundSummarizationTriggerThreshold(midLoopTokenDetails.maxTokens, this.config.backgroundSummarizationProps),
            persistConfig: {
              unusedTokensThreshold: this.config.backgroundSummarizationProps.unusedTokensThresholdToPersistBackgroundSummarization,
              unusedPercentTokensThreshold: this.config.backgroundSummarizationProps.unusedPercentTokensThresholdToPersistBackgroundSummarization,
            },
          });
          if (shouldPersistMidLoop) {
            await this.orchestrator.handleSummarization(ctx, stateHandler, rootPromptExecutor, this.interactionListener, this.config, requestContext, {
              backgroundSummarizationMode: BackgroundSummarizationMode.BackgroundAndPersistIfCompleted,
              triggerReason: shouldPersistForImageThresholdMidLoop && !wouldMeetTriggerThreshold ? "approaching_image_limit" : "approaching_token_limit",
              currentInvocationId: stateHandler.lastStepInvocationId,
              resourceAccessor: this.resourceAccessor,
              tools,
              extraT,
              descriptionProps,
              automationTriggerContext,
            });
          }
        }
        if (stateHandler.backgroundSummarizationPromiseInfo !== null && !stateHandler.backgroundSummarizationHasCompleted) {
          const currentTokenDetails = stateHandler.tokenDetails;
          const overageThreshold = Math.min(0.25 * currentTokenDetails.maxTokens, 5e4);
          if (currentTokenDetails.maxTokens > 0 && currentTokenDetails.usedTokens > currentTokenDetails.maxTokens + overageThreshold) {
            logger.info(ctx, "[summarization-persist] Blocking on background summarization because token usage significantly exceeds max tokens", {
              usedTokens: currentTokenDetails.usedTokens,
              maxTokens: currentTokenDetails.maxTokens,
              overageThreshold,
            });
            await this.orchestrator.handleSummarization(ctx, stateHandler, rootPromptExecutor, this.interactionListener, this.config, requestContext, {
              backgroundSummarizationMode: BackgroundSummarizationMode.WaitForCompletion,
              triggerReason: "significantly_over_token_limit",
              currentInvocationId: stateHandler.lastStepInvocationId,
              resourceAccessor: this.resourceAccessor,
              tools,
              extraT,
              descriptionProps,
              automationTriggerContext,
            });
          }
        }
        const messagesBeforeImageCompaction = fromRedactedCoreMessages(rootPromptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
        const imageCount = countImagePartsInMessages(messagesBeforeImageCompaction);
        if (imageCount >= IMAGE_SUMMARIZATION_TRIGGER_COUNT) {
          logger.info(ctx, "Image count reached threshold; starting background summarization", {
            imageCount,
            triggerCount: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
          });
          await this.orchestrator.handleSummarization(ctx, stateHandler, rootPromptExecutor, this.interactionListener, this.config, requestContext, {
            backgroundSummarizationMode: BackgroundSummarizationMode.Background,
            triggerReason: "approaching_image_limit",
            currentInvocationId: stateHandler.lastStepInvocationId,
            resourceAccessor: this.resourceAccessor,
            tools,
            extraT,
            descriptionProps,
            automationTriggerContext,
          });
        }
        if (this.config.maxSteps === 1 && this.config.featureFlags?.cloudAgentProactiveTokenLimitError === true && !stateHandler.tokenDetailsStaleAfterSummarization) {
          const tokenDetails = stateHandler.tokenDetails;
          if (shouldPersistBackgroundSummarization(tokenDetails.usedTokens, tokenDetails.maxTokens, this.config.backgroundSummarizationProps)) {
            const useProactiveSelfSummarization = this.config.featureFlags?.cloudAgentProactiveSelfSummarization === true;
            logger.info(ctx, useProactiveSelfSummarization ? "[cloud-summarization] Token usage hit configured threshold, throwing ProactiveSummarizationThresholdError to trigger compaction" : "[cloud-summarization] Token usage hit configured threshold, throwing InputTokenLimitError to trigger external compaction", {
              usedTokens: tokenDetails.usedTokens,
              maxTokens: tokenDetails.maxTokens,
              useProactiveSelfSummarization,
            });
            throw useProactiveSelfSummarization ? new ProactiveSummarizationThresholdError() : new InputTokenLimitError();
          }
        }
        return await fn(ctx);
      } catch (error) {
        const isProactiveSummarizationThresholdError = error instanceof ProactiveSummarizationThresholdError;
        const isTokenLimitError = SummarizationHandler.isTokenLimitError(error);
        const isImagePartsLimitError = isTooManyImagesOrDocumentsError(error);
        if (isProactiveSummarizationThresholdError || isTokenLimitError || isImagePartsLimitError) {
          const wouldUseSelfSummary = this.orchestrator.canUseSelfSummary({ tools, extraT });
          logger.info(ctx, isImagePartsLimitError ? "[summarization-trigger] Hit image limit error, running blocking summarization in order to compress context" : isProactiveSummarizationThresholdError ? "[summarization-trigger] Hit configured summarization threshold, running blocking summarization in order to compress context" : "[summarization-trigger] Hit token limit error, running blocking summarization in order to compress context");
          const forceExternalModel = isTokenLimitError || isImagePartsLimitError ? true : undefined;
          const summarizationOptions = {
            backgroundSummarizationMode: BackgroundSummarizationMode.WaitForCompletion,
            currentInvocationId: stateHandler.lastStepInvocationId,
            triggerReason: isImagePartsLimitError ? "approaching_image_limit" : isProactiveSummarizationThresholdError ? "approaching_token_limit" : wouldUseSelfSummary ? "fallback_on_limit_error" : "input_token_limit_error",
            resourceAccessor: this.resourceAccessor,
            forceExternalModel,
            tools,
            extraT,
            descriptionProps,
            automationTriggerContext,
          };
          try {
            await this.orchestrator.handleSummarization(ctx, stateHandler, rootPromptExecutor, this.interactionListener, this.config, requestContext, summarizationOptions);
          } catch (summarizationError) {
            const shouldFallbackToExternalSummarization = this.config.featureFlags?.cloudAgentProactiveSelfSummarization === true && forceExternalModel !== true && wouldUseSelfSummary && SummarizationHandler.isTokenLimitError(summarizationError);
            if (!shouldFallbackToExternalSummarization) throw summarizationError;
            logger.info(ctx, "[summarization-trigger] Self-summary hit token limit, falling back to external summarization");
            await this.orchestrator.handleSummarization(ctx, stateHandler, rootPromptExecutor, this.interactionListener, this.config, requestContext, {
              ...summarizationOptions,
              triggerReason: "fallback_on_limit_error",
              forceExternalModel: true,
            });
          }
          continue;
        }
        throw error;
      }
    }
    throw new StepRetriesExhaustedError("summarization-retries");
  }

  async runTurnLoop(
    parentCtx: Context,
    rootPromptExecutor: RetryRootPromptExecutorLike,
    stateHandler: RunStepStateHandlerLike,
    initialTurn: RunStepTurnLike,
    toolsGenerator: AgentToolsGenerator,
    mcpTools: readonly MergedRequestContextToolLike[],
    repositoryInfo: readonly unknown[],
    requestContext: RequestContext,
    onStateUpdate: (ctx: Context, state: { pendingToolCalls: unknown[] }) => Promise<void>,
  ): Promise<void> {
    using spanContext = createSpan(parentCtx.withName("runTurnLoop"));
    const ctx = spanContext.ctx;
    await this.cancelPendingAgentResponseComparison();
    this.responseComparisonPendingUiAttempted = false;
    this.responseComparisonModelStepStarted = false;
    this.responseComparisonWarmupsInTurn = 0;
    this.responseComparisonCandidate = undefined;
    const turnStartTime = performance.now();
    let totalToolCallsInTurn = 0;
    const turnToolCountingState = new ToolCountingStateTracker();
    const turnToolCountingMiddleware = createToolCountingMiddleware(turnToolCountingState);
    const wrappedRootPromptExecutor = turnToolCountingMiddleware(rootPromptExecutor);
    const hadPreviousAssistantMessage = rootPromptExecutor.getMessages().some(message => message.role === "assistant");
    const initialTodos = await Promise.all(stateHandler.todos.map(todoRef => todoRef.get(ctx)));
    const initialTodoCount = initialTodos.length;
    const hadUnfinishedTodosAtStart = initialTodos.some(todo => todo.status === TodoStatus.PENDING || todo.status === TodoStatus.IN_PROGRESS);
    const unfinishedTodosAtStart = initialTodos.filter(todo => todo.status === TodoStatus.PENDING || todo.status === TodoStatus.IN_PROGRESS).length;
    let turn = initialTurn;
    let currentMcpTools = mcpTools;
    let assistantMessagesSinceLastReflectGeneral = 0;
    const cliReflectGeneralReminderInterval = this.config.featureFlags?.cliReflectGeneralConfig?.stepsUntilForcedFollowUp ?? DEFAULT_CLI_REFLECT_GENERAL_REMINDER_INTERVAL;
    const cliReflectGeneralMaxFollowUpsPerTurn = this.config.featureFlags?.cliReflectGeneralConfig?.maxForcedFollowUpsPerTurn ?? DEFAULT_CLI_REFLECT_GENERAL_MAX_FOLLOW_UPS_PER_TURN;
    const cliReflectGeneralReminderText = this.config.featureFlags?.cliReflectGeneralConfig?.forcedFollowUpMessage ?? DEFAULT_CLI_REFLECT_GENERAL_REMINDER_TEXT;
    let cliReflectGeneralFollowUpsSentInTurn = 0;
    const userMessage = await initialTurn.userMessage.get(ctx);
    stateHandler.setMode(resolveCurrentTurnMode(stateHandler.mode, userMessage.mode));
    const maxSteps = this.config.maxSteps;
    if (typeof maxSteps !== "number" || !Number.isFinite(maxSteps) || maxSteps <= 0) {
      throw new Error("Max steps must be a finite number greater than 0");
    }
    const fileOperationLockManager = new FileOperationLockManager();
    let previousStepCount = turn.steps.length;
    let previousMode = stateHandler.mode;
    let previousQueuedMessageSource = "none";
    let finalAssistantMessageCharacterCount: number | undefined;
    let finalAssistantMessageUxStats: FinalAssistantMessageUxStats | undefined;
    const emptyResponseRetryTurnBudget: EmptyResponseRetryTurnBudgetLike = { retriesUsed: 0 };
    let conflictBarrierInjectionsRemaining = 2;
    try {
      for (let step = 0; step < maxSteps && !ctx.signal.aborted; step += 1) {
        try {
          const currentMode = stateHandler.mode;
          if (previousMode !== undefined && currentMode !== undefined && currentMode !== previousMode) {
            const modeReminder = stateHandler.generateModeChangeContent(this.config, requestContext, previousMode);
            logger.info(ctx, "Mode changed, adding nudge", { previousMode, newMode: currentMode });
            if (modeReminder) {
              rootPromptExecutor.appendMessages(toRedactedCoreMessages([{ role: "user", content: modeReminder }], stateHandler.getPrivacyMode()));
            }
            previousMode = currentMode;
          }
          const readPathsBefore = new Set(stateHandler.readPaths);
          const { hasToolCall, responseMessages, toolCallIdentityResolver } = await this.executeStepWithMetrics(
            ctx,
            turn,
            { wrappedPromptExecutor: wrappedRootPromptExecutor, rootPromptExecutor },
            stateHandler,
            toolsGenerator,
            currentMcpTools,
            repositoryInfo,
            requestContext,
            fileOperationLockManager,
            onStateUpdate,
            previousQueuedMessageSource,
            emptyResponseRetryTurnBudget,
          );
          const toolCallsInStep = responseMessages.filter(message => message.role === "tool").length;
          totalToolCallsInTurn += toolCallsInStep;
          const assistantMessagesInStep = countAssistantMessages(responseMessages);
          const hasReflectGeneralCall = hasReflectGeneralToolCall(responseMessages, toolCallIdentityResolver);
          assistantMessagesSinceLastReflectGeneral = hasReflectGeneralCall
            ? 0
            : assistantMessagesSinceLastReflectGeneral + assistantMessagesInStep;
          previousStepCount = turn.steps.length;
          await this.applyPostStepProcessing(ctx, turn, rootPromptExecutor, stateHandler, hasToolCall, [...responseMessages], onStateUpdate, {
            requestContext,
            toolsGenerator,
            repositoryInfo,
            mcpTools: currentMcpTools,
            fileOperationLockManager,
          });
          const isLastIteration = step === maxSteps - 1;
          let updatedTurn = turn;
          let hasQueuedMessages = false;
          let queuedMessageSource = "none";
          let hasQueuedUserTurn = false;
          let updatedMcpTools = currentMcpTools;
          const queuedAction = await this.conversationActionReceiver.peek(ctx);
          if (queuedAction?.action.case === "asyncAskQuestionCompletionAction") {
            logger.info(ctx, "Found queued AsyncAskQuestionCompletionAction - processing immediately", {
              originalToolCallId: queuedAction.action.value.originalToolCallId,
            });
            await this.conversationActionReceiver.pop(ctx);
            const completionAction = queuedAction.action.value;
            const application = await applyAskQuestionCompletion(ctx, {
              action: completionAction,
              stateHandler,
              turn,
              rootPromptExecutor,
              resultFormat: "json-object",
            });
            if (application.outcome === "applied") {
              const syntheticModelCallId = randomUUID();
              await this.interactionListener.sendUpdate(ctx, RedactedUpdates.toolCallStarted(application.recordedToolCallId, application.toolCall, syntheticModelCallId));
              await this.interactionListener.sendUpdate(ctx, RedactedUpdates.toolCallCompleted(application.recordedToolCallId, application.toolCall, syntheticModelCallId));
              logger.info(ctx, "Injected async completion into current turn", {
                originalToolCallId: completionAction.originalToolCallId,
                resultCase: completionAction.result?.result.case,
              });
              totalToolCallsInTurn += 1;
              hasQueuedMessages = true;
              queuedMessageSource = "asyncAskQuestionCompletion";
            } else {
              logger.info(ctx, "Dropped queued async completion", {
                originalToolCallId: completionAction.originalToolCallId,
                outcome: application.outcome,
              });
            }
          }
          if (!isLastIteration) {
            const result = await this.consumeQueuedUserMessagesAndMaybeCreateNewTurns(ctx, stateHandler, turn, currentMcpTools, onStateUpdate);
            updatedTurn = result.turn;
            hasQueuedMessages = hasQueuedMessages || result.hasQueuedMessages;
            if (result.hasQueuedMessages) queuedMessageSource = "consumeQueuedUserMessages";
            hasQueuedUserTurn = result.hasQueuedMessages;
            updatedMcpTools = result.mcpTools;
          }
          const crossedReflectReminderThreshold = !hasReflectGeneralCall && assistantMessagesInStep > 0 &&
            Math.floor((assistantMessagesSinceLastReflectGeneral - assistantMessagesInStep) / cliReflectGeneralReminderInterval) <
            Math.floor(assistantMessagesSinceLastReflectGeneral / cliReflectGeneralReminderInterval);
          const canInjectReflectReminderThisTurn = cliReflectGeneralMaxFollowUpsPerTurn === -1 || cliReflectGeneralFollowUpsSentInTurn < cliReflectGeneralMaxFollowUpsPerTurn;
          if (!isLastIteration && !hasQueuedUserTurn && crossedReflectReminderThreshold && canInjectReflectReminderThisTurn && await this.shouldInjectCliReflectGeneralFollowUp(ctx, stateHandler, turn, toolsGenerator, updatedMcpTools, repositoryInfo, requestContext, fileOperationLockManager)) {
            updatedTurn = await this.createCliReflectGeneralFollowUpTurn(ctx, stateHandler, turn, cliReflectGeneralReminderText, requestContext, onStateUpdate);
            hasQueuedMessages = true;
            queuedMessageSource = "cliReflectGeneralFollowUp";
            cliReflectGeneralFollowUpsSentInTurn += 1;
            logger.info(ctx, "Injected CLI reflect-general follow-up", {
              assistantMessagesSinceLastReflectGeneral,
              cliReflectGeneralFollowUpsSentInTurn,
              cliReflectGeneralMaxFollowUpsPerTurn,
            });
          }
          turn = updatedTurn;
          currentMcpTools = updatedMcpTools;
          const hasEnded = (!hasToolCall && !hasQueuedMessages) || isLastIteration;
          if (!hasToolCall && !hasQueuedMessages && conflictBarrierInjectionsRemaining > 0 && !isLastIteration && this.config.featureFlags?.enableAgentStoreConflictNotices === true && await this.maybeInjectPreFinalConflictBarrier(ctx, rootPromptExecutor, stateHandler.getPrivacyMode())) {
            conflictBarrierInjectionsRemaining -= 1;
            this.responseComparisonCandidate = undefined;
            continue;
          }
          if (!hasEnded) {
            this.responseComparisonCandidate = undefined;
          } else if (hasToolCall || hasQueuedMessages) {
            this.responseComparisonCandidate = undefined;
            await this.finalizePendingAgentResponseComparison(false);
          }
          if (hasEnded) {
            try {
              finalAssistantMessageCharacterCount = getFinalAssistantMessageCharacterCount(responseMessages);
            } catch (error) {
              logger.error(ctx, "Failed to count final assistant message characters", error);
              finalAssistantMessageCharacterCount = undefined;
            }
            if (this.config.featureFlags?.collectModelUxStats !== false) {
              try {
                finalAssistantMessageUxStats = getFinalAssistantMessageUxStats(responseMessages);
              } catch (error) {
                logger.error(ctx, "Failed to analyze final assistant message UX stats", error);
                finalAssistantMessageUxStats = undefined;
              }
            }
          }
          previousQueuedMessageSource = queuedMessageSource;
          if (hasEnded && stateHandler.backgroundSummarizationPromiseInfo !== null) {
            const backgroundSummarizationPromiseInfo = stateHandler.backgroundSummarizationPromiseInfo;
            const tokenDetails = stateHandler.tokenDetails;
            const isSelfSummary = backgroundSummarizationPromiseInfo.summarizerType === "self";
            const shouldPersistForTokenThreshold = shouldPersistBackgroundSummarization(tokenDetails.usedTokens, tokenDetails.maxTokens, this.config.backgroundSummarizationProps);
            const endOfTurnMessages = fromRedactedCoreMessages(rootPromptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
            const imageCountAtTurnEnd = countImagePartsInMessages(endOfTurnMessages);
            const shouldPersistForImageThreshold = imageCountAtTurnEnd >= IMAGE_SUMMARIZATION_TRIGGER_COUNT;
            const shouldPersist = shouldPersistForTokenThreshold || shouldPersistForImageThreshold;
            const completedPersistTriggerReason = shouldPersistForImageThreshold ? "approaching_image_limit" : isSelfSummary ? "self_summary_completed" : "threshold_met";
            if (shouldPersist) {
              if (stateHandler.backgroundSummarizationHasCompleted) {
                if (stateHandler.shouldSuppressSelfSummaryAfterInputLimitFailure(tokenDetails.usedTokens)) {
                  logger.info(ctx, "[summarization-discard] At end of turn, suppressing completed self-summary persistence after input-limit failure", {
                    usedTokens: tokenDetails.usedTokens,
                    selfSummaryInputLimitFailureTokenCount: stateHandler.selfSummaryInputLimitFailureTokenCount,
                    imageCountAtTurnEnd,
                    imageThreshold: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
                    shouldPersistForImageThreshold,
                  });
                } else {
                  logger.info(ctx, "[summarization-persist] At end of turn, background summarization has completed and persistence threshold has been hit. Persisting summarization.", {
                    usedTokens: tokenDetails.usedTokens,
                    maxTokens: tokenDetails.maxTokens,
                    imageCountAtTurnEnd,
                    imageThreshold: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
                    shouldPersistForImageThreshold,
                  });
                  await this.orchestrator.handleSummarization(ctx, stateHandler, rootPromptExecutor, this.interactionListener, this.config, requestContext, {
                    backgroundSummarizationMode: BackgroundSummarizationMode.BackgroundAndPersistIfCompleted,
                    currentInvocationId: stateHandler.lastStepInvocationId,
                    isToolCall: totalToolCallsInTurn > 0,
                    triggerReason: completedPersistTriggerReason,
                    resourceAccessor: this.resourceAccessor,
                  });
                }
              } else {
                const overageThreshold = Math.min(0.25 * tokenDetails.maxTokens, 5e4);
                const shouldBlockForTokenOverage = tokenDetails.maxTokens > 0 && tokenDetails.usedTokens > tokenDetails.maxTokens + overageThreshold;
                const shouldBlockForImageThreshold = shouldPersistForImageThreshold;
                if (shouldBlockForTokenOverage || shouldBlockForImageThreshold) {
                  logger.info(ctx, shouldBlockForImageThreshold ? "[summarization-persist] At end of turn, blocking on background summarization before persistence because image count reached threshold" : "[summarization-persist] At end of turn, blocking on background summarization because token usage significantly exceeds max tokens", {
                    usedTokens: tokenDetails.usedTokens,
                    maxTokens: tokenDetails.maxTokens,
                    overageThreshold,
                    imageCountAtTurnEnd,
                    imageThreshold: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
                    blockedForImageThreshold: shouldBlockForImageThreshold,
                    blockedForTokenOverage: shouldBlockForTokenOverage,
                  });
                  await this.orchestrator.handleSummarization(ctx, stateHandler, rootPromptExecutor, this.interactionListener, this.config, requestContext, {
                    backgroundSummarizationMode: BackgroundSummarizationMode.WaitForCompletion,
                    currentInvocationId: stateHandler.lastStepInvocationId,
                    isToolCall: totalToolCallsInTurn > 0,
                    triggerReason: shouldBlockForImageThreshold ? "approaching_image_limit" : "significantly_over_token_limit",
                    resourceAccessor: this.resourceAccessor,
                  });
                } else {
                  logger.info(ctx, "[summarization-discard] At end of turn, persistence threshold is met, but we are discarding background summarization as it has not completed", {
                    usedTokens: tokenDetails.usedTokens,
                    maxTokens: tokenDetails.maxTokens,
                    imageCountAtTurnEnd,
                    imageThreshold: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
                    shouldPersistForImageThreshold,
                  });
                  backgroundSummarizationDiscarded.increment(ctx, 1, { reason: "not_completed", model: backgroundSummarizationPromiseInfo.modelId });
                }
              }
            } else if (isSelfSummary) {
              logger.info(ctx, "[summarization-discard] At end of turn, discarding self-summary as persistence threshold is not met", {
                usedTokens: tokenDetails.usedTokens,
                maxTokens: tokenDetails.maxTokens,
                imageCountAtTurnEnd,
                imageThreshold: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
                shouldPersistForImageThreshold,
                backgroundSummarizationHasCompleted: stateHandler.backgroundSummarizationHasCompleted,
              });
              backgroundSummarizationDiscarded.increment(ctx, 1, { reason: "self_summary_persist_threshold_not_met", model: backgroundSummarizationPromiseInfo.modelId });
            } else {
              logger.info(ctx, "[summarization-discard] At end of turn, we are discarding background summarization as persistence threshold is not met", {
                usedTokens: tokenDetails.usedTokens,
                maxTokens: tokenDetails.maxTokens,
                imageCountAtTurnEnd,
                imageThreshold: IMAGE_SUMMARIZATION_TRIGGER_COUNT,
                shouldPersistForImageThreshold,
                backgroundSummarizationConfig: this.config.backgroundSummarizationProps,
                backgroundSummarizationHasCompleted: stateHandler.backgroundSummarizationHasCompleted,
              });
              const completed = stateHandler.backgroundSummarizationHasCompleted;
              const triggerThreshold = getBackgroundSummarizationTriggerThreshold(tokenDetails.maxTokens, this.config.backgroundSummarizationProps);
              let reason = completed ? "threshold_not_met_completed" : "threshold_not_met_not_completed";
              if (triggerThreshold !== undefined && tokenDetails.usedTokens < triggerThreshold * 0.6) reason = "incorrectly_triggered_summarization";
              backgroundSummarizationDiscarded.increment(ctx, 1, { reason, model: backgroundSummarizationPromiseInfo.modelId });
            }
          }
          if (hasEnded && stateHandler.backgroundSummarizationPromiseInfo !== null) {
            const backgroundSummarizationPromiseInfo = stateHandler.backgroundSummarizationPromiseInfo;
            if (stateHandler.backgroundSummarizationCancellationToken !== undefined) {
              stateHandler.backgroundSummarizationCancellationToken.cancelled = true;
            }
            backgroundSummarizationPromiseInfo.promise.catch(error => {
              logger.error(ctx, "Background summarization failed", {
                error,
                summarizationMode: "unspecified",
                triggerReason: "unspecified",
                model: backgroundSummarizationPromiseInfo.modelId,
              });
            });
          }
          if (hasEnded && !hasToolCall && !hasQueuedMessages) await this.finalizePendingAgentResponseComparison(true);
          const lastTurn = await stateHandler.turns.at(-1)?.get(ctx);
          if (lastTurn instanceof AgentConversationTurnHandle) {
            const lastStep = await lastTurn.steps.at(-1)?.get(ctx);
            if (isSuccessfulCreatePlanStep(lastStep)) {
              logger.info(ctx, "Plan created, breaking out of turn loop");
              this.responseComparisonCandidate = undefined;
              await this.cancelPendingAgentResponseComparison();
              break;
            }
          }
          if (!hasToolCall && !hasQueuedMessages) break;
          if (!this.config.doNotFailOnMaxSteps && isLastIteration) throw new Error("Reached maximum number of steps before turn ended (possible looping?)");
        } finally {
          agentStepCount.increment(ctx, 1, {});
        }
      }
      try {
        const finalTodos = await Promise.all(stateHandler.todos.map(todoRef => todoRef.get(ctx)));
        const unfinishedTodoCount = finalTodos.filter(todo => todo.status === TodoStatus.PENDING || todo.status === TodoStatus.IN_PROGRESS).length;
        if (unfinishedTodoCount > 0) {
          unfinishedTodosMetric.increment(ctx, unfinishedTodoCount);
          logger.info(ctx, "Turn ended with unfinished todos", { unfinishedTodoCount });
        }
        const eventTracker = getAgentEventTracker(ctx);
        const finalTodoCount = finalTodos.length;
        eventTracker.trackUnfinishedTodos(ctx, { unfinishedTodoCount });
        if (finalTodoCount > initialTodoCount) eventTracker.trackUnfinishedTodosWhenCreatedTodos(ctx, { unfinishedTodoCount, createdTodoCount: finalTodoCount - initialTodoCount });
        if (hadUnfinishedTodosAtStart) eventTracker.trackUnfinishedTodosWhenHadUnfinishedTodosAtStart(ctx, { unfinishedTodosAtEnd: unfinishedTodoCount, unfinishedTodosAtStart });
      } catch (error) {
        logger.error(ctx, "Failed to track unfinished todos metric", error);
      }
      const turnDuration = performance.now() - turnStartTime;
      agentTurnDuration.histogram(ctx, turnDuration);
      const outcomeTags = {
        newConversation: hadPreviousAssistantMessage ? "false" : "true",
        isauto: getIsAutoFromContext(ctx) ? "true" : "false",
        ispremium: getIsPremiumFromContext(ctx) ? "true" : "false",
        isanysphereteam: getIsAnysphereTeamFromContext(ctx) ? "true" : "false",
        isuserapikey: getIsUserApiKeyFromContext(ctx) ? "true" : "false",
        issubagent: getIsSubagentFromContext(ctx) ? "true" : "false",
        autoroutingreason: getAutoRoutingReasonFromContext(ctx),
      };
      agentTurnResult.increment(ctx, 1, { outcome: "success", ...outcomeTags });
      if (finalAssistantMessageCharacterCount !== undefined) {
        try { finalAssistantMessageCharacters.histogram(ctx, finalAssistantMessageCharacterCount); } catch (error) { logger.error(ctx, "Failed to record final assistant message character metric", error); }
      }
      if (finalAssistantMessageUxStats !== undefined) {
        try {
          for (const stat of FINAL_ASSISTANT_MESSAGE_UX_STAT_NAMES) finalAssistantMessageUxStatsMetric.histogram(ctx, finalAssistantMessageUxStats[stat], { stat });
        } catch (error) { logger.error(ctx, "Failed to record final assistant message UX stats", error); }
      }
      await this.interactionListener.sendUpdate(ctx, RedactedUpdates.stepCompleted(stateHandler.getPrivacyMode(), turn.steps.length, Math.round(turnDuration)));
      if (this.config.featureFlags?.enablePromptSuggestion && this.config.modelId !== undefined) {
        try {
          const userMessageForTools = await turn.userMessage.get(ctx);
          const modeForTools = resolveCurrentStepMode(stateHandler.mode, userMessageForTools.mode);
          const toolSetHandleForSuggestion = toolsGenerator({
            resourceAccessor: this.resourceAccessor,
            stateHandler,
            agentSessionId: this.config.agentSessionId,
            mcpTools: currentMcpTools,
            repositoryInfos: repositoryInfo,
            blobStore: stateHandler.getBlobStore(),
            mode: modeForTools,
            loggingContext: ctx,
            requestContext,
            fileOperationLockManager,
            smartModeClassifierMode: this.config.smartModeClassifierMode,
            smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
            autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
          });
          const toolsForSuggestion = toAgentTools(toolSetHandleForSuggestion.getStaticTools(), toolSetHandleForSuggestion.getDescriptionProps());
          const messagesSnapshot = rootPromptExecutor.getMessages();
          const maxInputTokenCost = this.config.featureFlags?.promptSuggestionMaxInputTokenCost;
          const costChecker = this.config.featureFlags?.getModelInputCostForContext;
          this.interactionListener.enqueuePostTurnEndedWork?.(async () => {
            try {
              await requestPromptSuggestion(ctx, getInvocationId(ctx), this.config.modelId!, rootPromptExecutor, toUnredactedInteractionListener(this.interactionListener, stateHandler.getPrivacyMode()), toolsForSuggestion, messagesSnapshot, { maxInputTokenCost, getModelInputCostForContext: costChecker });
            } catch (error) { logger.error(ctx, "Failed to request prompt suggestion", error); }
          });
        } catch (error) { logger.error(ctx, "Failed to setup prompt suggestion", error); }
      }
      const getFeedbackRequestDetails = this.config.featureFlags?.getFeedbackRequestDetails;
      if (getFeedbackRequestDetails !== undefined && !getIsSubagentFromContext(ctx)) {
        const feedbackRequestId = getRequestId(ctx);
        if (feedbackRequestId !== undefined) {
          this.interactionListener.enqueuePostTurnEndedWork?.(async () => {
            try {
              if (!hadPreviousAssistantMessage) return;
              const feedbackRequestDetails = await getFeedbackRequestDetails({ canonicalModelName: this.config.canonicalModelName });
              if (feedbackRequestDetails === undefined) return;
              await this.interactionListener.sendUpdate(ctx, RedactedUpdates.feedbackRequest(feedbackRequestId, this.config.canonicalModelName ?? "", stateHandler.getPrivacyMode(), feedbackRequestDetails.categories, feedbackRequestDetails.categoryGroups ?? [], { title: feedbackRequestDetails.title, negativeTitle: feedbackRequestDetails.negativeTitle, commentPlaceholder: feedbackRequestDetails.commentPlaceholder }));
            } catch (error) { logger.error(ctx, "Failed to emit feedback request", error); }
          });
        }
      }
      agentToolCallsPerTurn.histogram(ctx, totalToolCallsInTurn, { outcome: "success", ...getClientVersionMetricTagsFromContext(ctx), ...getSdkFlavorMetricTagFromContext(ctx), "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false" });
      const modelName = this.config.modelId ?? "unknown";
      unifiedHandlerNumberOfToolCalls.histogram(ctx, totalToolCallsInTurn, { model: modelName, hasFailedToolCalls: turnToolCountingState.hasFailedToolCalls(), hasUnexpectedToolCallErrors: turnToolCountingState.hasUnexpectedToolCallErrors(), success: "true", errorName: "none" });
      const eventTrackerForToolCalls = getAgentEventTracker(ctx);
      eventTrackerForToolCalls.trackNumberOfToolCalls(ctx, { numberOfToolCalls: totalToolCallsInTurn, numberOfFailedToolCalls: turnToolCountingState.getFailedToolCallCount(), numberOfUnexpectedToolCallErrors: turnToolCountingState.getUnexpectedToolCallErrorCount(), success: true });
    } catch (error) {
      await this.cancelPendingAgentResponseComparison();
      const turnDuration = performance.now() - turnStartTime;
      agentTurnDuration.histogram(ctx, turnDuration);
      const outcome = ctx.signal.aborted ? "aborted" : "error";
      agentTurnResult.increment(ctx, 1, { outcome, newConversation: hadPreviousAssistantMessage ? "false" : "true", isauto: getIsAutoFromContext(ctx) ? "true" : "false", ispremium: getIsPremiumFromContext(ctx) ? "true" : "false", isanysphereteam: getIsAnysphereTeamFromContext(ctx) ? "true" : "false", isuserapikey: getIsUserApiKeyFromContext(ctx) ? "true" : "false", issubagent: getIsSubagentFromContext(ctx) ? "true" : "false", autoroutingreason: getAutoRoutingReasonFromContext(ctx) });
      await this.interactionListener.sendUpdate(ctx, RedactedUpdates.stepCompleted(stateHandler.getPrivacyMode(), turn.steps.length, Math.round(turnDuration)));
      agentToolCallsPerTurn.histogram(ctx, totalToolCallsInTurn, { outcome, ...getClientVersionMetricTagsFromContext(ctx), ...getSdkFlavorMetricTagFromContext(ctx), "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false" });
      const modelName = this.config.modelId ?? "unknown";
      const errorName = error instanceof Error ? error.constructor.name : "unknown";
      unifiedHandlerNumberOfToolCalls.histogram(ctx, totalToolCallsInTurn, { model: modelName, hasFailedToolCalls: turnToolCountingState.hasFailedToolCalls(), hasUnexpectedToolCallErrors: turnToolCountingState.hasUnexpectedToolCallErrors(), success: "false", errorName });
      const eventTrackerForToolCalls = getAgentEventTracker(ctx);
      eventTrackerForToolCalls.trackNumberOfToolCalls(ctx, { numberOfToolCalls: totalToolCallsInTurn, numberOfFailedToolCalls: turnToolCountingState.getFailedToolCallCount(), numberOfUnexpectedToolCallErrors: turnToolCountingState.getUnexpectedToolCallErrorCount(), success: false });
      throw error;
    }
  }

  async createCliReflectGeneralFollowUpTurn(
    ctx: Context,
    stateHandler: RunStepStateHandlerLike,
    _turn: RunStepTurnLike,
    reminderText: string,
    requestContext: RequestContext,
    onStateUpdate: (ctx: Context, state: { pendingToolCalls: unknown[] }) => Promise<void>,
  ): Promise<RunStepTurnLike> {
    const syntheticUserMessage = new UserMessage({
      text: reminderText,
      messageId: randomUUID(),
      isSimulatedMsg: true,
    });
    await this.interactionListener.sendUpdate(ctx, toRedactedInteractionUpdate(Updates.userMessageAppended(syntheticUserMessage), stateHandler.getPrivacyMode()));
    const newTurn = await stateHandler.createAgentTurn(ctx, syntheticUserMessage, requestContext, this.config, this.resourceAccessor);
    if (this.config.immediatelyUpdateStateOnNewTurn) {
      if (this.config.fireAndForgetCheckpoints) {
        void stateHandler.computeNewStructure(ctx).then(async newState => { await onStateUpdate(ctx, newState); }).catch(error => { logger.error(ctx, "Failed to persist checkpoint after creating CLI reflect-general follow-up turn", { error }); });
      } else {
        const newState = await stateHandler.computeNewStructure(ctx);
        await onStateUpdate(ctx, newState);
      }
    }
    return newTurn;
  }

  async consumeQueuedUserMessagesAndMaybeCreateNewTurns(
    ctx: Context,
    stateHandler: RunStepStateHandlerLike,
    currentTurn: RunStepTurnLike,
    currentMcpTools: readonly MergedRequestContextToolLike[],
    onStateUpdate: (ctx: Context, state: { pendingToolCalls: unknown[] }) => Promise<void>,
  ): Promise<{ readonly turn: RunStepTurnLike; readonly hasQueuedMessages: boolean; readonly mcpTools: MergedRequestContextToolLike[] }> {
    let turn = currentTurn;
    let hasQueuedMessages = false;
    let mcpTools = [...currentMcpTools];
    while (true) {
      const queuedAction = await this.conversationActionReceiver.peek(ctx);
      if (queuedAction?.action.case === "asyncAskQuestionCompletionAction") {
        logger.warn(ctx, "Found AsyncAskQuestionCompletionAction in queue handler - should have been handled by inline handler", { originalToolCallId: queuedAction.action.value.originalToolCallId });
        break;
      }
      if (queuedAction?.action.case !== "userMessageAction") break;
      const { userMessage: queuedMsg, requestContext: queuedReqContext } = queuedAction.action.value;
      if (queuedMsg === undefined) throw new Error("User message is required");
      let consumedClaimedInjection = false;
      if (this.conversationActionReceiver.peekIsClaimedInjection?.() === true) {
        await this.conversationActionReceiver.pop(ctx);
        consumedClaimedInjection = true;
      }
      const turnMsg = await turn.userMessage.get(ctx);
      const shouldCreateNewTurn = turnMsg.messageId !== queuedMsg.messageId;
      if (!shouldCreateNewTurn || queuedReqContext === undefined) {
        logger.info(ctx, "Queued user message consumption decision", { queuedMessageId: queuedMsg.messageId, currentTurnMessageId: turnMsg.messageId, decision: shouldCreateNewTurn ? "new_turn_created" : "already_has_turn", missingQueuedRequestContext: queuedReqContext === undefined, immediatelyUpdateStateOnNewTurn: this.config.immediatelyUpdateStateOnNewTurn, fireAndForgetCheckpoints: this.config.fireAndForgetCheckpoints });
      }
      if (shouldCreateNewTurn) {
        try {
          await this.interactionListener.sendUpdate(ctx, RedactedUpdates.userMessageAppended(queuedMsg));
          turn = await stateHandler.createAgentTurn(ctx, fromRedactedUserMessage(queuedMsg, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined), queuedReqContext === undefined ? new RequestContext() : fromRedactedRequestContext(queuedReqContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined), this.config, this.resourceAccessor);
        } catch (error) {
          if (consumedClaimedInjection) this.conversationActionReceiver.failConsumedInjectionDelivery?.();
          throw error;
        }
        hasQueuedMessages = true;
        if (this.config.immediatelyUpdateStateOnNewTurn) {
          if (this.config.fireAndForgetCheckpoints) {
            void stateHandler.computeNewStructure(ctx).then(async newState => { await onStateUpdate(ctx, newState); }).catch(error => { logger.error(ctx, "Failed to persist checkpoint after creating queued turn", { error }); });
          } else {
            const newState = await stateHandler.computeNewStructure(ctx);
            await onStateUpdate(ctx, newState);
          }
        }
      }
      if (!consumedClaimedInjection) await this.conversationActionReceiver.pop(ctx);
      const unredactedTools = queuedReqContext?.tools?.map(tool => fromRedactedMcpToolDefinition(tool, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)) ?? [];
      mcpTools = this.mergeRequestContextTools(currentMcpTools, unredactedTools);
    }
    return { turn, hasQueuedMessages, mcpTools };
  }

  async shouldInjectCliReflectGeneralFollowUp(
    ctx: Context,
    stateHandler: SummarizationStateHandler,
    turn: SetupStepTurnLike,
    toolsGenerator: AgentToolsGenerator,
    mcpTools: readonly unknown[],
    repositoryInfo: readonly unknown[],
    requestContext: RequestContext,
    fileOperationLockManager: FileOperationLockManager,
  ): Promise<boolean> {
    if (this.config.featureFlags?.enableCliReflectGeneralTool !== true) {
      return false;
    }
    const userMessage = await turn.userMessage.get(ctx);
    const mode = resolveCurrentStepMode(stateHandler.mode, userMessage.mode);
    return toolsGenerator({
      resourceAccessor: this.resourceAccessor,
      stateHandler,
      agentSessionId: this.config.agentSessionId,
      mcpTools,
      repositoryInfos: repositoryInfo,
      blobStore: stateHandler.getBlobStore(),
      mode,
      loggingContext: ctx,
      requestContext,
      fileOperationLockManager,
      smartModeClassifierMode: this.config.smartModeClassifierMode,
      smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
      autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
    }).hasTool("REFLECT_GENERAL");
  }

  async maybeInjectPreFinalConflictBarrier(
    ctx: Context,
    rootPromptExecutor: RetryRootPromptExecutorLike,
    privacyMode: PrivacyMode,
  ): Promise<boolean> {
    let executor: Parameters<typeof conflictNoticeSyncAndPeek>[0] | undefined;
    try {
      executor = (this.resourceAccessor as {
        get(resource: typeof agentStoreConflictNoticeExecutorResource): Parameters<typeof conflictNoticeSyncAndPeek>[0] | undefined;
      }).get(agentStoreConflictNoticeExecutorResource);
    } catch {
      executor = undefined;
    }
    if (executor === undefined) {
      return false;
    }
    const isAbortSignalAborted = () => ctx.signal?.aborted === true;
    if (isAbortSignalAborted()) {
      return false;
    }
    const releaseConflictNoticeEvents = async (eventIds: readonly string[]) => {
      if (eventIds.length === 0) {
        return;
      }
      try {
        await conflictNoticeRelease(executor, ctx, eventIds, this.config.conversationId !== undefined ? { conversationId: this.config.conversationId } : undefined);
      } catch (releaseError) {
        logger.warn(ctx, "Conflict barrier release failed", { error: releaseError });
      }
    };
    try {
      const result = await conflictNoticeSyncAndPeek(executor, ctx, {
        ...(this.config.conversationId !== undefined ? { conversationId: this.config.conversationId } : {}),
      }) as ConflictNoticeSyncAndPeekResultLike;
      const timedOut = result.kind === "timed-out" ? "true" : "false";
      if (result.kind === "mount-passive") {
        agentStoreConflictBarrier.increment(ctx, 1, { outcome: "mount_passive", timed_out: timedOut });
        return false;
      }
      const reminder = result.kind === "completed" || result.kind === "timed-out" ? result.reminder : undefined;
      const eventIds = result.kind === "completed" || result.kind === "timed-out" ? result.events.map(event => event.eventId) : [];
      if (isAbortSignalAborted()) {
        await releaseConflictNoticeEvents(eventIds);
        return false;
      }
      if (reminder === undefined || reminder.length === 0) {
        agentStoreConflictBarrier.increment(ctx, 1, { outcome: "checked", timed_out: timedOut });
        return false;
      }
      const sanitizedReminder = sanitizeSystemReminderContent(reminder);
      try {
        rootPromptExecutor.appendMessages(toRedactedCoreMessages([
          {
            role: "user",
            content: `<system_reminder>\n${sanitizedReminder}\n</system_reminder>`,
          },
        ], privacyMode));
      } catch (error) {
        await releaseConflictNoticeEvents(eventIds);
        throw error;
      }
      try {
        await conflictNoticeAck(executor, ctx, eventIds, this.config.conversationId !== undefined ? { conversationId: this.config.conversationId } : undefined);
      } catch (error) {
        logger.warn(ctx, "Conflict barrier ack failed", { error });
        await releaseConflictNoticeEvents(eventIds);
      }
      agentStoreConflictBarrier.increment(ctx, 1, { outcome: "rescued", timed_out: timedOut });
      logger.info(ctx, "Local-sync conflict turn-end barrier injected", {
        eventCount: eventIds.length,
        timedOut: result.kind === "timed-out",
      });
      return true;
    } catch (error) {
      agentStoreConflictBarrier.increment(ctx, 1, { outcome: "error", timed_out: "false" });
      logger.warn(ctx, "Conflict turn-end barrier failed", { error });
      return false;
    }
  }

  mergeRequestContextTools(
    existingTools: readonly MergedRequestContextToolLike[],
    requestContextTools: readonly RequestContextToolInputLike[],
  ): MergedRequestContextToolLike[] {
    const mergedTools = [...existingTools];
    for (const maybeRedTool of requestContextTools) {
      const tool = "_privacyMode" in maybeRedTool
        ? fromRedactedMcpToolDefinition(maybeRedTool, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)
        : maybeRedTool;
      const exists = mergedTools.some((t) => t.name === tool.name);
      if (!exists) {
        mergedTools.push({
          name: tool.name,
          providerIdentifier: tool.providerIdentifier,
          toolName: tool.toolName,
          description: tool.description,
          inputSchema: mcpInputSchemaToJson(tool),
          clientKey: tool.providerIdentifier,
        });
      }
    }
    return mergedTools;
  }

  async executeStepWithMetrics(
    ctx: Context,
    turn: SetupStepTurnLike,
    executors: StepExecutorsLike,
    stateHandler: SummarizationStateHandler & RetryStateHandlerLike,
    toolsGenerator: AgentToolsGenerator,
    mcpTools: readonly unknown[],
    repositoryInfo: readonly unknown[],
    requestContext: RequestContext,
    fileOperationLockManager: FileOperationLockManager,
    onStateUpdate: ((ctx: Context, state: { pendingToolCalls: unknown[] }) => Promise<void>) | undefined,
    previousQueuedMessageSource?: unknown,
    emptyResponseRetryTurnBudget?: EmptyResponseRetryTurnBudgetLike,
  ): Promise<StepResultLike & {
    readonly stepToolCountingState: ToolCountingStateTracker;
    readonly toolCallIdentityResolver: ToolSetHandle;
  }> {
    const { result, stepToolCountingState, toolCallIdentityResolver } = await this.executeStepWithCommonMetrics(
      ctx,
      turn,
      executors,
      stateHandler,
      toolsGenerator,
      mcpTools,
      repositoryInfo,
      requestContext,
      fileOperationLockManager,
      (innerCtx, wrappedPromptExecutor, maxOutputTokenRetryDebug) => this.runStep(
        innerCtx,
        turn as RunStepTurnLike,
        wrappedPromptExecutor,
        stateHandler as unknown as RunStepStateHandlerLike,
        toolsGenerator,
        mcpTools as PromptTokenTrackingParamsLike["mcpTools"],
        repositoryInfo,
        requestContext,
        fileOperationLockManager,
        onStateUpdate,
        previousQueuedMessageSource,
        maxOutputTokenRetryDebug,
      ),
      emptyResponseRetryTurnBudget,
    );
    return {
      ...result,
      stepToolCountingState,
      toolCallIdentityResolver,
    };
  }

  async buildStepSummarizationContext(
    ctx: Context,
    turn: SetupStepTurnLike,
    stateHandler: SummarizationStateHandler,
    toolsGenerator: AgentToolsGenerator,
    mcpTools: readonly unknown[],
    repositoryInfo: readonly unknown[],
    requestContext: RequestContext,
    fileOperationLockManager: FileOperationLockManager,
  ): Promise<{
    readonly tools: ReturnType<ToolSetHandle["getStaticTools"]>;
    readonly extraT: UnknownRecord;
    readonly descriptionProps: ReturnType<ToolSetHandle["getDescriptionProps"]>;
    readonly toolCallIdentityResolver: ToolSetHandle;
  }> {
    const userMessage = await turn.userMessage.get(ctx);
    const mode = resolveCurrentStepMode(stateHandler.mode, userMessage.mode);
    const toolSetHandle = toolsGenerator({
      resourceAccessor: this.resourceAccessor,
      stateHandler,
      agentSessionId: this.config.agentSessionId,
      mcpTools,
      repositoryInfos: repositoryInfo,
      blobStore: stateHandler.getBlobStore(),
      mode,
      loggingContext: ctx,
      requestContext,
      fileOperationLockManager,
      smartModeClassifierMode: this.config.smartModeClassifierMode,
      smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
      autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
    });
    const tools = toolSetHandle.getStaticTools();
    const userAutoRunInstructions = await this.getUserPermissionsFileAutoRunInstructions(ctx, requestContext);
    const projectAutoRunInstructions = this.getProjectPermissionsFileAutoRunInstructions(requestContext);
    const extraT = {
      repositoryInfos: repositoryInfo,
      shouldQueryProd: requestContext.repositoryInfoShouldQueryProd,
      stateHandler,
      enableToolArgPreservation: this.config.enableToolArgPreservation === true,
      enableHookAdditionalContext: this.config.featureFlags?.enableHookAdditionalContext === true,
      enableAgentStoreConflictNoticeCollector: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
      enableAgentStoreConflictNotices: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
      writeBarrierTimeoutMs: this.resolveWriteBarrierTimeoutMs(),
      onWriteBarrier: this.config.recordAgentStoreWriteBarrier,
      workspacePaths: requestContext.env?.workspacePaths,
      userAutoRunInstructions,
      projectAutoRunInstructions,
      cursorRules: getAllRules(requestContext, this.config.nonFileRules, this.config.featureFlags),
      agentSkills: requestContext.agentSkills ?? [],
      contextInjectionSignal: this.conversationActionReceiver.getContextInjectionToolSignal?.(),
    };
    return {
      tools,
      extraT,
      descriptionProps: toolSetHandle.getDescriptionProps(),
      toolCallIdentityResolver: toolSetHandle,
    };
  }

  recordStepToolCallMetrics(ctx: Context, stepToolCountingState: StepToolCountingStateLike): void {
    const baseParallelToolCallTags = {
      hasFailedToolCalls: stepToolCountingState.hasFailedToolCalls(),
      hasUnexpectedToolCallErrors: stepToolCountingState.hasUnexpectedToolCallErrors(),
      success: "true",
      errorName: "none",
    };
    numberOfParallelToolCalls.histogram(ctx, stepToolCountingState.toolCallCount, baseParallelToolCallTags);
    if (stepToolCountingState.toolCallCount > 0) {
      numberOfParallelToolCallsWithAtLeastOneCall.histogram(ctx, stepToolCountingState.toolCallCount, {
        ...baseParallelToolCallTags,
        ...getClientVersionMetricTagsFromContext(ctx),
        "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
      });
    }
  }

  async executeStepWithCommonMetrics<T>(
    ctx: Context,
    turn: SetupStepTurnLike,
    executors: StepExecutorsLike,
    stateHandler: SummarizationStateHandler & RetryStateHandlerLike,
    toolsGenerator: AgentToolsGenerator,
    mcpTools: readonly unknown[],
    repositoryInfo: readonly unknown[],
    requestContext: RequestContext,
    fileOperationLockManager: FileOperationLockManager,
    runStep: (
      ctx: Context,
      wrappedPromptExecutor: RetryRootPromptExecutorLike,
      maxOutputTokenRetryDebug: MaxOutputTokenRetryDebugLike,
    ) => Promise<T>,
    emptyResponseRetryTurnBudget: EmptyResponseRetryTurnBudgetLike | undefined,
  ): Promise<{
    readonly result: T;
    readonly stepToolCountingState: ToolCountingStateTracker;
    readonly tools: ReturnType<ToolSetHandle["getStaticTools"]>;
    readonly toolCallIdentityResolver: ToolSetHandle;
  }> {
    const stepToolCountingState = new ToolCountingStateTracker();
    const stepToolCountingMiddleware = createToolCountingMiddleware(stepToolCountingState);
    const stepWrappedExecutor = stepToolCountingMiddleware(executors.wrappedPromptExecutor);
    const { tools, extraT, descriptionProps, toolCallIdentityResolver } = await this.buildStepSummarizationContext(
      ctx,
      turn,
      stateHandler,
      toolsGenerator,
      mcpTools,
      repositoryInfo,
      requestContext,
      fileOperationLockManager,
    );
    const result = await this.runWithSummarizationRetry(
      ctx,
      stateHandler,
      executors.rootPromptExecutor,
      requestContext,
      tools,
      extraT,
      descriptionProps,
        innerCtx => this.runWithMaxTokensRetry(
          innerCtx,
          executors.rootPromptExecutor,
          (retryCtx, maxOutputTokenRetryDebug) => runStep(
            retryCtx,
            stepWrappedExecutor as unknown as RetryRootPromptExecutorLike,
            maxOutputTokenRetryDebug,
          ),
          emptyResponseRetryTurnBudget,
        ),
    );
    this.recordStepToolCallMetrics(ctx, stepToolCountingState);
    return {
      result,
      stepToolCountingState,
      tools,
      toolCallIdentityResolver,
    };
  }

  async applyPostStepProcessing(
    ctx: Context,
    turn: PostStepTurnLike,
    rootPromptExecutor: RetryRootPromptExecutorLike,
    stateHandler: RunStepStateHandlerLike,
    hasToolCall: boolean,
    responseMessages: CoreMessageLike[],
    onStateUpdate: (ctx: Context, state: { pendingToolCalls: unknown[] }) => Promise<void>,
    grindRebuildParams: {
      readonly requestContext: RequestContext;
      readonly toolsGenerator: AgentToolsGenerator;
      readonly repositoryInfo: readonly unknown[];
      readonly mcpTools: readonly unknown[];
      readonly fileOperationLockManager: FileOperationLockManager;
    },
  ): Promise<void> {
    if (hasToolCall && this.config.reminders && this.config.reminders.length > 0) {
      const currentTodos = await Promise.all(stateHandler.todos.map((todo) => todo.get(ctx)));
      stateHandler.assertRootPromptBlobsLoadedForFullPromptRead();
      const conversationMessages = fromRedactedCoreMessages(rootPromptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
      await applyRemindersToToolResults(
        responseMessages,
        this.config.reminders,
        currentTodos.map((todo) => fromRedactedTodoItem(todo, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)),
        conversationMessages,
      );
    }
    if (shouldTagToolCallIdsForCurrentContext(ctx)) {
      appendToolCallIdTagsToToolResults(responseMessages);
    }
    turn.appendPromptMessages(toRedactedCoreMessages(responseMessages, stateHandler.getPrivacyMode()));
    if (this.config.messageHistoryModifier) {
      stateHandler.assertRootPromptBlobsLoadedForFullPromptRead();
      const currentMessages = fromRedactedCoreMessages(rootPromptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
      const modifiedHistory = this.config.messageHistoryModifier(currentMessages);
      if (modifiedHistory) {
        stateHandler.invalidateRootPromptPrefix();
        rootPromptExecutor.clearMessages();
        rootPromptExecutor.appendMessages(toRedactedCoreMessages(modifiedHistory, stateHandler.getPrivacyMode()));
      }
    }
    const grindPhaseOverride = getGrindPhaseOverrideFromResponse(responseMessages);
    if (grindPhaseOverride !== undefined && grindRebuildParams) {
      const { requestContext, toolsGenerator, repositoryInfo, mcpTools, fileOperationLockManager } = grindRebuildParams;
      const userMessage = await turn.userMessage.get(ctx);
      const mode = resolveCurrentStepMode(stateHandler.mode, userMessage.mode);
      const toolSetHandle = toolsGenerator({
        resourceAccessor: this.resourceAccessor,
        stateHandler,
        agentSessionId: this.config.agentSessionId,
        mcpTools,
        repositoryInfos: repositoryInfo,
        blobStore: stateHandler.getBlobStore(),
        mode,
        loggingContext: ctx,
        requestContext,
        fileOperationLockManager,
        smartModeClassifierMode: this.config.smartModeClassifierMode,
        smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
        autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
        grindMode: { phase: grindPhaseOverride },
      } as Parameters<AgentToolsGenerator>[0]);
      stateHandler.assertRootPromptBlobsLoadedForFullPromptRead();
      const messagesWithoutSystemPrompt = rootPromptExecutor.getMessages().filter((message) => message.role !== "system");
      stateHandler.invalidateRootPromptPrefix();
      rootPromptExecutor.clearMessages();
      rootPromptExecutor.appendMessages(toRedactedCoreMessages([
        {
          role: "system",
          content: this.config.systemPromptGenerator({
            requestContext,
            cursorRules: getAllRules(requestContext, this.config.nonFileRules, this.config.featureFlags),
            env: requestContext.env,
            browserTools: getBrowserToolNames(mcpTools as Parameters<typeof getBrowserToolNames>[0]),
            cloudRule: requestContext.cloudRule,
            mode,
            grindMode: { phase: grindPhaseOverride },
          }, toolSetHandle),
        },
      ], stateHandler.getPrivacyMode()));
      rootPromptExecutor.appendMessages(messagesWithoutSystemPrompt);
    }
    if (this.config.fireAndForgetCheckpoints) {
      void stateHandler.computeNewStructure(ctx).then(async (currentState) => {
        await onStateUpdate(ctx, currentState);
      }).catch((error) => {
        logger.error(ctx, "Failed to persist checkpoint after step", { error });
      });
    } else {
      const currentState = await stateHandler.computeNewStructure(ctx);
      await onStateUpdate(ctx, currentState);
    }
  }

  async setupStep(
    ctx: Context,
    stateHandler: SetupStepStateHandlerLike,
    turn: SetupStepTurnLike,
  ): Promise<{ readonly fileOperationLockManager: FileOperationLockManager }> {
    const userMessage = await turn.userMessage.get(ctx);
    if (stateHandler.mode === void 0) {
      stateHandler.setMode(resolveCurrentTurnMode(stateHandler.mode, userMessage.mode));
    }
    const fileOperationLockManager = new FileOperationLockManager();
    return { fileOperationLockManager };
  }

  async runSingleStep(
    parentCtx: Context,
    rootPromptExecutor: RetryRootPromptExecutorLike,
    stateHandler: RunStepStateHandlerLike,
    turn: RunStepTurnLike,
    toolsGenerator: AgentToolsGenerator,
    mcpTools: PromptTokenTrackingParamsLike["mcpTools"],
    repositoryInfo: readonly unknown[],
    requestContext: RequestContext,
    onStateUpdate: (ctx: Context, state: { pendingToolCalls: unknown[] }) => Promise<void>,
  ): Promise<{ readonly hasToolCall: boolean }> {
    using span = createSpan(parentCtx.withName("runSingleStep"));
    const ctx = span.ctx;
    const { fileOperationLockManager } = await this.setupStep(ctx, stateHandler as unknown as SetupStepStateHandlerLike, turn);
    try {
      const { hasToolCall, responseMessages } = await this.executeStepWithMetrics(
        ctx,
        turn,
        {
          wrappedPromptExecutor: rootPromptExecutor as unknown as ToolCountingExecutorLike,
          rootPromptExecutor,
        },
        stateHandler as unknown as SummarizationStateHandler & RetryStateHandlerLike,
        toolsGenerator,
        mcpTools,
        repositoryInfo,
        requestContext,
        fileOperationLockManager,
        onStateUpdate,
      );
      await this.applyPostStepProcessing(ctx, turn, rootPromptExecutor, stateHandler, hasToolCall, responseMessages as CoreMessageLike[], onStateUpdate, {
        requestContext,
        toolsGenerator,
        repositoryInfo,
        mcpTools,
        fileOperationLockManager,
      });
      return { hasToolCall };
    } finally {
      agentStepCount.increment(ctx, 1, {});
    }
  }

  async buildToolExecutionContext(
    ctx: Context,
    stateHandler: SplitStepStateMutationTarget,
    toolCallRecorder: SplitStepToolCallRecorderLike,
    mcpTools: readonly unknown[],
    repositoryInfo: readonly unknown[],
    requestContext: RequestContext,
    fileOperationLockManager: FileOperationLockManager,
    allowedToolNames: ReadonlySet<string> | undefined,
    admittedEffectiveToolName: string | undefined,
  ): Promise<ToolExecutionContextLike> {
    const invocationId = getInvocationId(ctx);
    if (stateHandler.mode === undefined) {
      throw new Error("stateHandler.mode must be set before building tool execution context");
    }
    const mode = stateHandler.mode;
    const toolSetHandle = this.config.toolsGenerator({
      resourceAccessor: this.resourceAccessor,
      stateHandler,
      agentSessionId: this.config.agentSessionId,
      mcpTools,
      repositoryInfos: repositoryInfo,
      blobStore: stateHandler.getBlobStore(),
      mode,
      loggingContext: ctx,
      requestContext,
      fileOperationLockManager,
      smartModeClassifierMode: this.config.smartModeClassifierMode,
      smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
      autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
    });
    const modelVisibleTools = toolSetHandle.getStaticTools();
    const scopedModelVisibleTools = allowedToolNames === undefined
      ? modelVisibleTools
      : modelVisibleTools.filter(tool => allowedToolNames.has(tool.name) || tool.name === admittedEffectiveToolName);
    const toolExecutionSet = toolSetHandle.getToolExecutionSet(scopedModelVisibleTools);
    const executableTools = getExecutableTools(toolExecutionSet);
    const directDynamicToolNames = getDirectDynamicToolNames(toolExecutionSet);
    const toolMap: Record<string, DeferredExecutableToolLike> = {};
    for (const tool of executableTools) {
      if (!isDeferredExecutableTool(tool)) {
        throw new Error("Executable tool is missing name or toolIdentifier");
      }
      toolMap[tool.name] = tool;
    }
    const renderProps = {
      allTools: extractToolMetadataMap(executableTools),
    };
    const userAutoRunInstructions = await this.getUserPermissionsFileAutoRunInstructions(ctx, requestContext);
    const projectAutoRunInstructions = this.getProjectPermissionsFileAutoRunInstructions(requestContext);
    const extraT: UnknownRecord = {
      repositoryInfos: repositoryInfo,
      shouldQueryProd: requestContext.repositoryInfoShouldQueryProd,
      stateHandler,
      strictArgParsing: this.config.strictArgParsing === true,
      enableToolArgPreservation: this.config.enableToolArgPreservation === true,
      enableHookAdditionalContext: this.config.featureFlags?.enableHookAdditionalContext === true,
      enableAgentStoreConflictNoticeCollector: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
      enableAgentStoreConflictNotices: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
      writeBarrierTimeoutMs: this.resolveWriteBarrierTimeoutMs(),
      onWriteBarrier: this.config.recordAgentStoreWriteBarrier,
      workspacePaths: requestContext.env?.workspacePaths,
      userAutoRunInstructions,
      projectAutoRunInstructions,
      cursorRules: getAllRules(requestContext, this.config.nonFileRules, this.config.featureFlags),
      agentSkills: requestContext.agentSkills ?? [],
      contextInjectionSignal: this.conversationActionReceiver.getContextInjectionToolSignal?.(),
    };
    const interactionHandler = new InteractionHandler(
      toUnredactedInteractionListener(this.interactionListener, stateHandler.getPrivacyMode()),
      toolCallRecorder,
      invocationId,
      undefined,
      this.config.thinkingStyle,
      this.config.featureFlags?.nalLoopDetection === true,
      this.createAfterAgentThoughtCallback(invocationId, requestContext),
    );
    return {
      toolMap,
      interactionHandler,
      extraT,
      renderProps,
      directDynamicToolNames,
      recordToolCallResult: interactionHandler.recordToolCallResult.bind(interactionHandler),
    };
  }

  async buildDeferredToolExecutionContext(
    ctx: Context,
    descriptor: NativeToolCallDescriptor,
    stateHandler: SplitStepStateMutationTarget,
    mcpTools: readonly MergedRequestContextToolLike[],
    splitStepData: DeferredSplitStepDataLike,
    requestContext: RequestContext,
    fileOperationLockManager: FileOperationLockManager,
    logMessage: string,
  ): Promise<ToolExecutionContextLike & { readonly stateOps: readonly SplitStepStateOp[] }> {
    const lastTurnRef = stateHandler.turns.at(-1);
    if (lastTurnRef === undefined) {
      throw new Error("No turns in conversation state");
    }
    const turn = await lastTurnRef.get(ctx);
    if (!(turn instanceof AgentConversationTurnHandle)) {
      throw new Error("Expected last turn to be an agent turn");
    }
    const { stateHandler: splitStateHandler, toolCallRecorder, stateOps } = createSplitStepStateHandler(stateHandler, turn);
    const allowedToolNames = splitStepData.allowedToolNames === undefined
      ? undefined
      : new Set(splitStepData.allowedToolNames);
    const admittedEffectiveToolName = getAdmittedEffectiveToolName(descriptor, allowedToolNames);
    const mergedMcpTools = this.mergeRequestContextTools(mcpTools, requestContext.tools);
    const executionContext = await this.buildToolExecutionContext(
      ctx,
      splitStateHandler,
      toolCallRecorder,
      mergedMcpTools,
      requestContext.repositoryInfo,
      requestContext,
      fileOperationLockManager,
      allowedToolNames,
      admittedEffectiveToolName,
    );
    if (
      allowedToolNames !== undefined &&
      !allowedToolNames.has(descriptor.toolName) &&
      !executionContext.directDynamicToolNames.has(getEffectiveToolCallName(descriptor))
    ) {
      logger.warn(ctx, logMessage, {
        toolCallId: descriptor.toolCallId,
        toolName: descriptor.toolName,
        allowedToolCount: allowedToolNames.size,
      });
    }
    splitStepData.stepReadPathDedup ??= new Set();
    executionContext.extraT.stepReadPathDedup = splitStepData.stepReadPathDedup;
    return {
      stateOps,
      ...executionContext,
    };
  }

  async runModelStep(
    parentCtx: Context,
    rootPromptExecutor: RetryRootPromptExecutorLike,
    stateHandler: RunStepStateHandlerLike,
    turn: RunStepTurnLike,
    toolsGenerator: AgentToolsGenerator,
    mcpTools: PromptTokenTrackingParamsLike["mcpTools"],
    repositoryInfo: readonly unknown[],
    requestContext: RequestContext,
    onStateUpdate: ((ctx: Context, state: { pendingToolCalls: unknown[] }) => Promise<void>) | undefined,
  ): Promise<{
    readonly toolCallDescriptors: readonly unknown[];
    readonly splitStepData: {
      readonly modelResponseMessages: readonly CoreMessageLike[];
      readonly requestContext: RequestContext;
      readonly allowedToolNames: readonly string[];
    };
  }> {
    using span = createSpan(parentCtx.withName("runModelStep"));
    const ctx = span.ctx;
    const { fileOperationLockManager } = await this.setupStep(ctx, stateHandler as unknown as SetupStepStateHandlerLike, turn);
    const { toolCallDescriptors, responseMessages, availableToolNames } = await this.executeModelStepWithMetrics(
      ctx,
      turn,
      {
        wrappedPromptExecutor: rootPromptExecutor as unknown as ToolCountingExecutorLike,
        rootPromptExecutor,
      },
      stateHandler as unknown as SummarizationStateHandler & RetryStateHandlerLike,
      toolsGenerator,
      mcpTools,
      repositoryInfo,
      requestContext,
      fileOperationLockManager,
      onStateUpdate,
    );
    return {
      toolCallDescriptors,
      splitStepData: {
        modelResponseMessages: responseMessages,
        requestContext,
        allowedToolNames: availableToolNames,
      },
    };
  }

  async executeToolCall(
    ctx: Context,
    descriptor: NativeToolCallDescriptor,
    stateHandler: SplitStepStateMutationTarget,
    mcpTools: readonly MergedRequestContextToolLike[],
    splitStepData: DeferredSplitStepDataLike,
    requestContext: RequestContext,
    fileOperationLockManager: FileOperationLockManager,
  ): Promise<{
    readonly toolCallId: string;
    readonly resultMessage: Record<string, unknown>;
    readonly stateOps: readonly SplitStepStateOp[];
  }> {
    const {
      stateOps,
      toolMap,
      interactionHandler,
      extraT,
      recordToolCallResult,
      renderProps,
      directDynamicToolNames,
    } = await this.buildDeferredToolExecutionContext(
      ctx,
      descriptor,
      stateHandler,
      mcpTools,
      splitStepData,
      requestContext,
      fileOperationLockManager,
      "Rejected deferred split-step tool call outside model-visible tool allowlist",
    );
    const rawResultMessage = await executeDeferredToolCall(
      ctx,
      descriptor,
      toolMap,
      interactionHandler,
      extraT,
      recordToolCallResult,
      renderProps,
      undefined,
      undefined,
      directDynamicToolNames,
    );
    if (!isCoreMessageLike(rawResultMessage)) {
      throw new Error("Deferred tool executor returned an invalid tool result message");
    }
    return {
      toolCallId: descriptor.toolCallId,
      resultMessage: rawResultMessage,
      stateOps,
    };
  }

  async prepareSubagent(
    ctx: Context,
    descriptor: NativeToolCallDescriptor,
    stateHandler: SplitStepStateMutationTarget,
    mcpTools: readonly MergedRequestContextToolLike[],
    splitStepData: DeferredSplitStepDataLike,
    requestContext: RequestContext,
    fileOperationLockManager: FileOperationLockManager,
  ): Promise<unknown> {
    const { toolMap, extraT } = await this.buildDeferredToolExecutionContext(
      ctx,
      descriptor,
      stateHandler,
      mcpTools,
      splitStepData,
      requestContext,
      fileOperationLockManager,
      "Rejected deferred split-step subagent preparation outside model-visible tool allowlist",
    );
    const effectiveToolName = getEffectiveToolCallName(descriptor);
    const tool = toolMap[effectiveToolName];
    if (tool === undefined) {
      throw new Error(`Tool not found: ${effectiveToolName}`);
    }
    if (tool.prepareSubagent === undefined) {
      throw new Error(`Tool does not support subagent preparation: ${effectiveToolName}`);
    }
    return await tool.prepareSubagent(ctx, getEffectiveToolCallArgs(descriptor), {
      toolCallId: descriptor.toolCallId,
      ...extraT,
    });
  }

  async finalizeStep(
    parentCtx: Context,
    splitStepData: { readonly modelResponseMessages: readonly CoreMessageLike[] },
    toolCallResults: readonly DeferredToolCallResultLike[],
    rootPromptExecutor: RetryRootPromptExecutorLike,
    stateHandler: RunStepStateHandlerLike & SplitStepStateMutationTarget,
    mcpTools: readonly MergedRequestContextToolLike[],
    requestContext: RequestContext,
    onStateUpdate: (ctx: Context, state: { pendingToolCalls: unknown[] }) => Promise<void>,
  ): Promise<{ readonly state: { pendingToolCalls: unknown[] }; readonly hasToolCall: boolean }> {
    using span = createSpan(parentCtx.withName("finalizeStep"));
    const ctx = span.ctx;
    const lastTurnRef = stateHandler.turns[stateHandler.turns.length - 1];
    if (lastTurnRef === undefined) {
      return {
        state: await stateHandler.computeNewStructure(ctx),
        hasToolCall: false,
      };
    }
    const turn = await lastTurnRef.get(ctx);
    if (!(turn instanceof AgentConversationTurnHandle)) {
      throw new Error("Expected last turn to be an agent turn");
    }
    const fileOperationLockManager = new FileOperationLockManager();
    const responseMessages: CoreMessageLike[] = [
      ...splitStepData.modelResponseMessages,
      ...toolCallResults.map(result => result.resultMessage),
    ];
    const hasToolCall = toolCallResults.length > 0;
    for (const stateOp of toolCallResults.flatMap(result => result.stateOps ?? [])) {
      await applyConversationStateOp(ctx, stateHandler, turn, stateOp);
    }
    const mergedMcpTools = this.mergeRequestContextTools(mcpTools, requestContext.tools);
    try {
      await this.applyPostStepProcessing(
        ctx,
        turn,
        rootPromptExecutor,
        stateHandler,
        hasToolCall,
        responseMessages,
        onStateUpdate,
        {
          requestContext,
          toolsGenerator: this.config.toolsGenerator,
          repositoryInfo: requestContext.repositoryInfo,
          mcpTools: mergedMcpTools,
          fileOperationLockManager,
        },
      );
      const state = await stateHandler.computeNewStructure(ctx);
      return { state, hasToolCall };
    } finally {
      agentStepCount.increment(ctx, 1, {});
    }
  }

  async executeModelStepWithMetrics(
    ctx: Context,
    turn: RunStepTurnLike,
    executors: StepExecutorsLike,
    stateHandler: SummarizationStateHandler & RetryStateHandlerLike,
    toolsGenerator: AgentToolsGenerator,
    mcpTools: readonly unknown[],
    repositoryInfo: readonly unknown[],
    requestContext: RequestContext,
    fileOperationLockManager: FileOperationLockManager,
    onStateUpdate: ((ctx: Context, state: { pendingToolCalls: unknown[] }) => Promise<void>) | undefined,
  ): Promise<ModelOnlyStepResultLike & { readonly availableToolNames: readonly string[] }> {
    const { result, tools } = await this.executeStepWithCommonMetrics(
      ctx,
      turn,
      executors,
      stateHandler,
      toolsGenerator,
      mcpTools,
      repositoryInfo,
      requestContext,
      fileOperationLockManager,
      (innerCtx, wrappedPromptExecutor) => this.runModelOnlyStep(
        innerCtx,
        turn,
        wrappedPromptExecutor,
        stateHandler as unknown as RunStepStateHandlerLike,
        toolsGenerator,
        mcpTools as PromptTokenTrackingParamsLike["mcpTools"],
        repositoryInfo,
        requestContext,
        fileOperationLockManager,
        onStateUpdate,
      ),
      undefined,
    );
    return {
      ...result,
      availableToolNames: tools.map(tool => tool.name),
    };
  }

  async runModelOnlyStep(
    parentCtx: Context,
    turn: RunStepTurnLike,
    rootPromptExecutor: RetryRootPromptExecutorLike,
    stateHandler: RunStepStateHandlerLike,
    toolsGenerator: AgentToolsGenerator,
    mcpTools: PromptTokenTrackingParamsLike["mcpTools"],
    repositoryInfos: readonly unknown[],
    requestContext: RequestContext,
    fileOperationLockManager: FileOperationLockManager,
    onStateUpdate: ((ctx: Context, state: { pendingToolCalls: unknown[] }) => Promise<void>) | undefined,
  ): Promise<ModelOnlyStepResultLike> {
    using spanCtxt = createSpan(parentCtx.withName("runModelOnlyStep"));
    const ctx = spanCtxt.ctx;
    const invocationId = getInvocationId(ctx);
    stateHandler.lastStepInvocationId = invocationId;
    spanCtxt.span.setAttribute("invocationId", invocationId);
    logger.info(ctx, "Running model-only step");
    const stepSetupStart = performance.now();
    const isFirstStep = turn.steps.length === 0;
    const isResponseComparisonFirstModelStep = !this.responseComparisonModelStepStarted;
    this.responseComparisonModelStepStarted = true;
    const interactionHandler = new InteractionHandler(
      toUnredactedInteractionListener(this.interactionListener, stateHandler.getPrivacyMode()),
      turn,
      invocationId,
      undefined,
      this.config.thinkingStyle,
      this.config.featureFlags?.nalLoopDetection === true,
      this.createAfterAgentThoughtCallback(invocationId, requestContext),
    );
    const userMessage = await turn.userMessage.get(ctx);
    const mode = resolveCurrentStepMode(stateHandler.mode, userMessage.mode);
    const toolSetHandle = toolsGenerator({
      resourceAccessor: this.resourceAccessor,
      stateHandler,
      agentSessionId: this.config.agentSessionId,
      mcpTools,
      repositoryInfos,
      blobStore: stateHandler.getBlobStore(),
      mode,
      loggingContext: ctx,
      requestContext,
      fileOperationLockManager,
      smartModeClassifierMode: this.config.smartModeClassifierMode,
      smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
      autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
    });
    const initialMessages = fromRedactedCoreMessages(rootPromptExecutor.getMessages(), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    if (isFirstStep) {
      warnIfLongTrailingUserMessageRun(ctx, initialMessages as Parameters<typeof warnIfLongTrailingUserMessageRun>[1], invocationId);
      firstStepSetupDuration.histogram(ctx, performance.now() - stepSetupStart);
    }
    trackPromptTokenUsage({
      ctx,
      mcpTools,
      requestContext,
      messages: initialMessages,
      selectedContext: userMessage.selectedContext,
      userInfoDisplayOptions: this.config.userInfoDisplayOptions,
      agentTokenLimit: this.config.agentTokenLimit,
      readToolName: toolSetHandle.getTool("READ")?.name,
      invocationId,
      modelInfo: this.config.modelInfo,
      featureFlags: this.config.featureFlags,
      stateHandler,
    });
    let responseComparisonMessages = this.config.agentResponseComparison === undefined ? undefined : [...initialMessages];
    let responseComparisonTools = this.config.agentResponseComparison === undefined
      ? undefined
      : Object.freeze(toAgentTools(toolSetHandle.getStaticTools(), toolSetHandle.getDescriptionProps()));
    if (isResponseComparisonFirstModelStep && responseComparisonMessages !== undefined && responseComparisonTools !== undefined) {
      await this.preparePendingAgentResponseComparison({
        ctx,
        parentInvocationId: invocationId,
        messages: responseComparisonMessages,
        tools: responseComparisonTools,
        privacyMode: stateHandler.getPrivacyMode(),
      });
    }
    let result: ModelOnlyStreamResultLike;
    try {
      result = rootPromptExecutor.executeModelStreamOnly(
        ctx,
        stateHandler,
        interactionHandler,
        toolSetHandle.getToolExecutionSet(),
        toolSetHandle.getDescriptionProps(),
        undefined,
      );
    } catch (error) {
      await this.cancelPendingAgentResponseComparison();
      throw error;
    }
    const isCloudAgentSingleStep = this.config.maxSteps === 1;
    const tokenDetails = stateHandler.tokenDetails;
    const shouldSuppressSelfSummaryAfterInputLimitFailure = stateHandler.shouldSuppressSelfSummaryAfterInputLimitFailure(tokenDetails.usedTokens);
    const shouldStartBg = !isCloudAgentSingleStep && !stateHandler.tokenDetailsStaleAfterSummarization && !shouldSuppressSelfSummaryAfterInputLimitFailure && this.orchestrator.shouldStartBackgroundSummarization(tokenDetails, rootPromptExecutor.getMessages(), ctx);
    if (shouldStartBg) {
      const wouldMeetPersistThreshold = shouldPersistBackgroundSummarization(tokenDetails.usedTokens, tokenDetails.maxTokens, this.config.backgroundSummarizationProps);
      logger.info(ctx, "Mid-loop background summarization trigger (model-stream-only): checking persist threshold", {
        usedTokens: tokenDetails.usedTokens,
        maxTokens: tokenDetails.maxTokens,
        unusedTokens: tokenDetails.maxTokens - tokenDetails.usedTokens,
        wouldMeetPersistThreshold,
        triggerThreshold: getBackgroundSummarizationTriggerThreshold(tokenDetails.maxTokens, this.config.backgroundSummarizationProps),
        backgroundSummarizationConfig: this.config.backgroundSummarizationProps,
        persistConfig: {
          unusedTokensThreshold: this.config.backgroundSummarizationProps.unusedTokensThresholdToPersistBackgroundSummarization,
          unusedPercentTokensThreshold: this.config.backgroundSummarizationProps.unusedPercentTokensThresholdToPersistBackgroundSummarization,
        },
      });
      await this.orchestrator.handleSummarization(ctx, stateHandler, rootPromptExecutor, this.interactionListener, this.config, requestContext, {
        backgroundSummarizationMode: BackgroundSummarizationMode.Background,
        triggerReason: "approaching_token_limit",
        currentInvocationId: invocationId,
        resourceAccessor: this.resourceAccessor,
        tools: toolSetHandle.getStaticTools(),
        descriptionProps: toolSetHandle.getDescriptionProps(),
        extraT: {
          repositoryInfos,
          shouldQueryProd: requestContext.repositoryInfoShouldQueryProd,
          stateHandler,
          enableToolArgPreservation: this.config.enableToolArgPreservation === true,
          enableHookAdditionalContext: this.config.featureFlags?.enableHookAdditionalContext === true,
          enableAgentStoreConflictNoticeCollector: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
          enableAgentStoreConflictNotices: this.config.featureFlags?.enableAgentStoreConflictNotices === true,
          writeBarrierTimeoutMs: this.resolveWriteBarrierTimeoutMs(),
          onWriteBarrier: this.config.recordAgentStoreWriteBarrier,
          workspacePaths: requestContext.env?.workspacePaths,
          userAutoRunInstructions: await this.getUserPermissionsFileAutoRunInstructions(ctx, requestContext),
          projectAutoRunInstructions: this.getProjectPermissionsFileAutoRunInstructions(requestContext),
          cursorRules: getAllRules(requestContext, this.config.nonFileRules, this.config.featureFlags),
          agentSkills: requestContext.agentSkills ?? [],
        },
        automationTriggerContext: this.getAutomationTriggerContext(rootPromptExecutor.getMessages()),
      });
    }
    let response: Awaited<ModelOnlyStreamResultLike["response"]>;
    let extendedUsage: Awaited<ModelOnlyStreamResultLike["extendedUsage"]>;
    let usage: Awaited<ModelOnlyStreamResultLike["usage"]>;
    let toolCallDescriptors: readonly unknown[];
    let finalInvocationId: string;
    try {
      [response, extendedUsage, usage, toolCallDescriptors, finalInvocationId] = await Promise.all([
        result.response,
        result.extendedUsage,
        result.usage,
        result.toolCallDescriptors,
        result.invocationId,
        interactionHandler.consumeStream(ctx, this.tapAgentResponseComparisonWarmup(ctx, result.fullStream, responseComparisonMessages, responseComparisonTools), turn),
      ]);
    } catch (error) {
      await this.cancelPendingAgentResponseComparison();
      throw error;
    }
    if (finalInvocationId !== invocationId) {
      logger.error(ctx, "Invocation ID mismatch. Bug in executeModelStreamOnly", undefined, {
        initialInvocationId: invocationId,
        finalInvocationId,
      });
    }
    logger.info(ctx, "Setting token details for client token ring (model-stream-only)", {
      usedTokens: usage.totalTokens,
      maxTokens: extendedUsage.maxTokens,
      inputTokens: extendedUsage.inputTokens,
      outputTokens: extendedUsage.outputTokens,
      cacheReadTokens: extendedUsage.cacheReadTokens,
      cacheWriteTokens: extendedUsage.cacheWriteTokens,
    });
    const promptContextDetails = nextRedactedPromptContextDetails(ctx, this.config, stateHandler, {
      messages: initialMessages,
      tools: toolSetHandle.getStaticTools(),
      descriptionProps: toolSetHandle.getDescriptionProps(),
      totalUsedTokens: usage.totalTokens,
      maxTokens: extendedUsage.maxTokens,
    });
    stateHandler.setTokenDetails(createRedactedConversationTokenDetails(stateHandler.getPrivacyMode(), {
      usedTokens: usage.totalTokens,
      maxTokens: extendedUsage.maxTokens,
      breakdown: promptContextDetails!.breakdown,
      promptContextUsageTree: promptContextDetails!.promptContextUsageTree,
    }));
    if (response.error || ctx.signal.aborted) {
      await this.cancelPendingAgentResponseComparison();
      if (this.config.skipErrorStateCheckpoint !== true) {
        turn.appendPromptMessages(toRedactedCoreMessages(response.messages, stateHandler.getPrivacyMode()));
        const currentState = await stateHandler.computeNewStructure(ctx);
        if (onStateUpdate) {
          await onStateUpdate(ctx, currentState);
        }
      }
      throw response.error ?? new ConnectError("User aborted request", Code.Canceled);
    }
    stateHandler.addTurnUsage({
      inputTokens: extendedUsage.inputTokens,
      outputTokens: extendedUsage.outputTokens,
      cacheReadTokens: extendedUsage.cacheReadTokens,
      cacheWriteTokens: extendedUsage.cacheWriteTokens,
      reasoningTokens: extendedUsage.reasoningTokens,
    });
    if (toolCallDescriptors.length === 0 && responseComparisonMessages !== undefined && responseComparisonTools !== undefined) {
      try {
        await this.enqueueAgentResponseComparisonIfEligible({
          ctx,
          parentInvocationId: finalInvocationId,
          responseMessages: response.messages,
          messages: responseComparisonMessages,
          tools: responseComparisonTools,
          privacyMode: stateHandler.getPrivacyMode(),
        });
      } finally {
        responseComparisonMessages = undefined;
        responseComparisonTools = undefined;
      }
    }
    if (toolCallDescriptors.length === 0) {
      await this.finalizePendingAgentResponseComparison(true);
    }
    return {
      toolCallDescriptors,
      responseMessages: response.messages,
    };
  }
}
