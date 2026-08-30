import { getBlobId } from "../agent-kv/blob-store.js";
import {
  BackgroundSummarizationMode,
  shouldStartBackgroundSummarization,
  type BackgroundSummarizationProps,
} from "../agent-summarization/background-summarization.js";
import { getRetryDirective } from "../agent-summarization/error-handling.js";
import { prepareMessagesForCompaction } from "../agent-summarization/prepare-messages.js";
import type { RedactedCoreMessage } from "../agent-summarization/summarization-handler.js";
import { RedactedUpdates } from "../agent-core/redacted-interaction-updates.js";
import { Updates } from "../agent-core/interaction-updates.js";
import { hookExecutorResource } from "../agent-exec/hook-executor.js";
import { createLogger, createSpan, type Context } from "../context/index.js";
import { isProjectSendMessageEnabled } from "../constants/project-send-message.js";
import { createCounter, createHistogram } from "../metrics/index.js";
import {
  AgentMode,
  PreCompactRequestQuery,
} from "../proto/generated/agent/v1/agent_pb.js";
import {
  ExecuteHookArgs,
  ExecuteHookRequest,
  type ExecuteHookResult,
} from "../proto/generated/agent/v1/exec_pb.js";
import { PrivacyCapability } from "../redaction/classification.js";
import {
  fromRedactedCoreMessage,
  fromRedactedCoreMessages,
  type CoreMessageLike,
} from "../redaction/core-message.js";
import { PrivacyMode } from "../redaction/privacy-mode.js";
import type { RedactedString } from "../redaction/types.js";
import {
  createRedactedConversationSummaryArchive,
  toRedactedInteractionUpdate,
} from "../redacted-protos/generated/agent/v1/agent_redacted.js";
import {
  coreMessageSerde,
  createRedactedCoreMessageSerde,
} from "./serde.js";
import { processModeSystemReminder, type ModeProcessingConfig, type ModeProcessingRequestContext } from "./mode-processing.js";
import { formatProjectCompactionPrompt } from "./prompts/project-prompt.js";
import { refreshNamedAgentSelfDocumentInMessages } from "./prompts/cloud-meta-agent/self-document.js";
import { SELF_SUMMARY_CONTEXT_WINDOW_FRACTION } from "./self-summary/constants.js";
import { shouldPerformSelfSummary } from "./self-summary/self-summary.js";
import { estimateTokenCount } from "./self-summary/token-estimate.js";
import { collectLiveAskQuestionOriginalIds } from "./tools/core/ask-question/replay-horizon.js";
import { formatTodosForSummarization } from "./tools/core/todo/common.js";
import { AgentType } from "./utils/agent-config.js";
import { getContextUsageInfo, isHookStepConfigured } from "./utils/common.js";
import { getAgentEventTracker } from "./utils/event-tracking.js";
import {
  EVAL_ENFORCED_MAX_TOKENS_BEFORE_SUMMARIZATION,
  EVAL_ENFORCED_SELF_SUMMARY_TOKEN_LIMIT,
} from "./utils/overridable-config.js";
import { resolveProjectConversationContext } from "./utils/project-conversation.js";
import {
  getClientVersionMetricTagsFromContext,
  getConversationId,
  getRequestId,
} from "./utils/request-id.js";

type ProjectConversationState = Parameters<typeof resolveProjectConversationContext>[1];
type ProjectRootPromptOptions = NonNullable<Parameters<typeof formatProjectCompactionPrompt>[0]>;
type RedactedTodoItem = Parameters<typeof formatTodosForSummarization>[0][number];
type SummaryArchive = ReturnType<typeof createRedactedConversationSummaryArchive>;
type SummaryCompletedHookMessage = Parameters<typeof Updates.summaryCompleted>[0];

export interface SummarizationTokenDetails {
  readonly usedTokens: number;
  readonly maxTokens: number;
}

export interface SummarizationResult {
  readonly messagesActuallySummarized: readonly RedactedCoreMessage[];
  readonly newSummaryMessage: RedactedCoreMessage;
  readonly preservedOriginalTailMessages: readonly RedactedCoreMessage[];
  readonly rawSummary: { readonly text: string };
  readonly summary: { readonly summary: RedactedString };
  readonly fullReplacementMessages: readonly RedactedCoreMessage[];
  readonly hadError?: boolean | undefined;
  readonly errorKind?: string | undefined;
  readonly onPersisted?: (() => void) | undefined;
}

export interface Summarizer {
  getMetricsModelLabel(): string;
  summarize(
    ctx: Context,
    messages: readonly RedactedCoreMessage[],
    options: SummarizerRunOptions,
  ): Promise<SummarizationResult>;
}

export interface SummarizerRunOptions {
  readonly fullSummarization: boolean | undefined;
  readonly currentPlan: unknown;
  readonly modePrompt: string;
  readonly projectRootPrompt: string | undefined;
  readonly agentTranscriptsFolder: string | undefined;
  readonly conversationId: string | undefined;
  readonly automationTriggerContext: unknown;
  readonly todoContent: string | undefined;
  readonly backgroundSummarizationMode: BackgroundSummarizationMode;
  readonly triggerReason: string;
  readonly enableRetryOutputTokenLimit: true | undefined;
  readonly cancellationToken: { cancelled: boolean };
  readonly contextWindowTokens: number;
}

export interface BackgroundSummarizationPromiseInfo {
  readonly promise: Promise<SummarizationResult>;
  readonly modelId: string;
  readonly summarizerType: "external" | "self";
  readonly startInvocationId: string;
  readonly startUsedTokens: number;
  readonly startMaxTokens: number;
}

export interface SummarizationStateHandler extends ProjectConversationState {
  mode?: AgentMode | undefined;
  isRootProjectConversation?: boolean;
  readonly todos: readonly { get(ctx: Context): Promise<RedactedTodoItem> }[];
  readonly tokenDetails: SummarizationTokenDetails;
  readonly summaryArchives: readonly unknown[];
  readonly selfSummaryCount: number;
  backgroundSummarizationPromiseInfo: BackgroundSummarizationPromiseInfo | null;
  messagesUndergoingSummarization: readonly RedactedCoreMessage[] | null;
  readonly backgroundSummarizationHasCompleted: boolean;
  readonly backgroundSummarizationGenerationDurationMs: number | null;
  tokenDetailsStaleAfterSummarization: boolean;
  setBackgroundSummarizationState(
    info: BackgroundSummarizationPromiseInfo,
    messages: readonly RedactedCoreMessage[],
    cancellationToken: { cancelled: boolean },
  ): void;
  setBackgroundSummarizationHasCompleted(generationDurationMs: number): void;
  clearBackgroundSummarizationState(): void;
  setSelfSummaryInputLimitFailureTokenCount(tokenCount: number): void;
  clearSelfSummaryInputLimitFailureTokenCount(): void;
  pushSummaryArchive(archive: SummaryArchive): void;
  getPrivacyMode(): PrivacyMode;
  getBlobStore(): {
    setBlob(ctx: Context, blobId: Uint8Array, data: Uint8Array): Promise<void>;
  };
  retainCompletedAskQuestionReceipts(ids: Set<string>): void;
}

export interface SummarizationPromptExecutor {
  getMessages(): readonly RedactedCoreMessage[];
  clearMessages(): void;
  appendMessages(messages: readonly RedactedCoreMessage[]): void;
}

export interface SummarizationInteractionListener {
  sendUpdate(ctx: Context, update: unknown): Promise<void>;
}

export interface SummarizationResourceAccessor {
  get(resource: typeof hookExecutorResource): {
    execute(ctx: Context, args: InstanceType<typeof ExecuteHookArgs>): Promise<ExecuteHookResult>;
  } | undefined;
}

export interface SummarizationRequestContext extends ModeProcessingRequestContext {
  readonly env?: { readonly agentTranscriptsFolder?: string | undefined } | undefined;
  readonly hooksConfig?: { readonly configuredSteps?: readonly string[] | undefined } | undefined;
}

export interface SummarizationOrchestratorConfig extends ModeProcessingConfig {
  readonly onExternalSummarizationStart?: (() => void) | undefined;
  readonly projectPromptTextGenerator?: (() => ProjectRootPromptOptions["promptText"]) | undefined;
  readonly featureFlags?: (ModeProcessingConfig["featureFlags"] & {
    readonly cloudCoordinatorToolsEnabled?: boolean | undefined;
  }) | undefined;
  readonly enableTranscriptInSummary?: boolean | undefined;
  readonly conversationId?: string | undefined;
  readonly agentType: AgentType;
  readonly enableExecuteHookExec?: boolean | undefined;
  readonly modelId: string;
  readonly getNamedAgentSelfDocument?: (() => Promise<string | null | undefined>) | undefined;
}

export interface HandleSummarizationOptions {
  readonly forceExternalModel?: boolean | undefined;
  readonly tools?: unknown[] | undefined;
  readonly extraT?: unknown;
  readonly descriptionProps?: Record<string, unknown> | undefined;
  readonly backgroundSummarizationMode: BackgroundSummarizationMode;
  readonly triggerReason: string;
  readonly fullSummarization?: boolean | undefined;
  readonly currentPlan?: unknown;
  readonly automationTriggerContext?: unknown;
  readonly currentInvocationId: string;
  readonly isToolCall?: boolean | undefined;
  readonly resourceAccessor: SummarizationResourceAccessor;
}

export type SelfSummarizerFactory = (
  stateHandler: SummarizationStateHandler,
  interactionListener: SummarizationInteractionListener,
  tools: unknown[],
  extraT: unknown,
  descriptionProps: Record<string, unknown> | undefined,
) => Summarizer;

const logger = createLogger("@anysphere/agent");

function countMessageKinds(messages: readonly {
  readonly role: string;
  readonly content: unknown;
}[]): {
  userMessages: number;
  systemMessages: number;
  assistantMessages: number;
  toolMessages: number;
  toolCalls: number;
} {
  let userMessages = 0;
  let systemMessages = 0;
  let assistantMessages = 0;
  let toolMessages = 0;
  let toolCalls = 0;
  for (const message of messages) {
    switch (message.role) {
      case "user": userMessages++; break;
      case "system": systemMessages++; break;
      case "assistant":
        assistantMessages++;
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === "tool-call") toolCalls++;
          }
        }
        break;
      case "tool": toolMessages++; break;
      default: throw new Error(`Unknown message role: ${String(message)}`);
    }
  }
  return { userMessages, systemMessages, assistantMessages, toolMessages, toolCalls };
}

function messagesEqualByValue(
  redactedMessage: RedactedCoreMessage,
  plainMessage: CoreMessageLike | undefined,
): boolean {
  if (plainMessage === undefined || redactedMessage.role !== plainMessage.role) return false;
  const unwrappedMessage = fromRedactedCoreMessage(
    redactedMessage,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
  );
  const aBytes = coreMessageSerde.serialize(unwrappedMessage);
  const bBytes = coreMessageSerde.serialize(plainMessage);
  if (aBytes.length !== bBytes.length) return false;
  for (let i = 0; i < aBytes.length; i++) {
    if (aBytes[i] !== bBytes[i]) return false;
  }
  return true;
}

const summarizationTime = createHistogram("agenticComposer.summarizationTime", {
  description: "Time taken for summarization in milliseconds",
  labelNames: ["strategy", "triggerReason", "model", "summarizerType", "isClientAtLeast1Point731"],
});
const summarizationGenerationTime = createHistogram("agenticComposer.summarizationGenerationTime", {
  description: "Time spent generating a summary in milliseconds",
  labelNames: ["strategy", "triggerReason", "model", "summarizerType", "outcome", "isClientAtLeast1Point731"],
});
const summarizationCounter = createCounter("agenticComposer.summarization", {
  description: "Number of summarizations performed",
  labelNames: ["strategy", "requestedStrategy", "triggerReason", "isToolCall", "model", "summarizerType", "isClientAtLeast1Point731", "clientversion", "clienttype"],
});
const backgroundSummarizationStarted = createCounter("agent.background_summarization.started", {
  description: "Background summarizations started",
  labelNames: ["model"],
});
const backgroundSummarizationDiscarded = createCounter("agent.background_summarization.discarded", {
  description: "Background summarizations discarded at end of turn",
  labelNames: ["reason", "model"],
});
const backgroundSummarizationPersisted = createCounter("agent.background_summarization.persisted", {
  description: "Background summarizations persisted",
  labelNames: ["hadError", "errorKind", "model"],
});
const backgroundSummarizationTimeSavedMs = createHistogram("agent.background_summarization.time_saved_ms", {
  description: "Milliseconds saved by running summarization in the background (generation duration minus persist wait)",
  labelNames: ["model"],
});
const backgroundSummarizationPersistedEstimatedTokens = createHistogram("agent.background_summarization.persisted_estimated_tokens", {
  description: "Estimated token count of all messages after background summarization is persisted (replacement + unsummarized)",
  labelNames: ["model"],
});
const backgroundSummarizationPersistedAdditionalMessages = createHistogram("agent.background_summarization.persisted_additional_messages", {
  description: "Number of additional messages (arrived after background summarization started) that are appended when a background summarization is persisted, bucketed by message kind",
  labelNames: ["model", "kind"],
});

export class SummarizationOrchestrator {
  constructor(
    readonly externalSummarizer: Summarizer,
    readonly selfSummarizerFactory?: SelfSummarizerFactory,
    readonly backgroundSummarizationProps?: BackgroundSummarizationProps,
    readonly selfSummaryTokenLimit?: number,
    readonly canUseSelfSummaryNow?: () => boolean,
  ) {}

  resolveSummaryTokenLimit(maxTokens: number, evalOverrideLimit: number | undefined): number | undefined {
    if (evalOverrideLimit !== undefined) return evalOverrideLimit;
    if (this.selfSummaryTokenLimit !== undefined) return this.selfSummaryTokenLimit;
    if (maxTokens > 0) return Math.floor(maxTokens * SELF_SUMMARY_CONTEXT_WINDOW_FRACTION);
    return undefined;
  }

  shouldStartBackgroundSummarization(
    tokenDetails: SummarizationTokenDetails,
    messages: readonly RedactedCoreMessage[],
    ctx?: Context,
  ): boolean {
    const evalMaxTokensBeforeSummarization = ctx !== undefined
      ? EVAL_ENFORCED_MAX_TOKENS_BEFORE_SUMMARIZATION(ctx)
      : undefined;
    if (
      ctx !== undefined &&
      evalMaxTokensBeforeSummarization !== undefined &&
      tokenDetails.usedTokens >= evalMaxTokensBeforeSummarization
    ) {
      logger.info(ctx, "[summarization] using eval override for max tokens before summarization", {
        evalMaxTokensBeforeSummarization,
        usedTokens: tokenDetails.usedTokens,
        maxTokens: tokenDetails.maxTokens,
      });
      return true;
    }
    const evalOverrideLimit = ctx !== undefined
      ? EVAL_ENFORCED_SELF_SUMMARY_TOKEN_LIMIT(ctx)
      : undefined;
    const bgResult = this.backgroundSummarizationProps && shouldStartBackgroundSummarization(
      tokenDetails.usedTokens,
      tokenDetails.maxTokens,
      this.backgroundSummarizationProps,
    );
    const selfResult = this.selfSummarizerFactory &&
      (this.canUseSelfSummaryNow?.() ?? true) &&
      shouldPerformSelfSummary(
        messages as Parameters<typeof shouldPerformSelfSummary>[0],
        tokenDetails,
        ctx,
        this.resolveSummaryTokenLimit(tokenDetails.maxTokens, evalOverrideLimit),
      );
    return Boolean(bgResult || selfResult);
  }

  canUseSelfSummary(options: HandleSummarizationOptions): boolean {
    return this.selfSummarizerFactory !== undefined &&
      (this.canUseSelfSummaryNow?.() ?? true) &&
      options.tools !== undefined &&
      options.extraT !== undefined;
  }

  getSummarizer(
    stateHandler: SummarizationStateHandler,
    interactionListener: SummarizationInteractionListener,
    config: SummarizationOrchestratorConfig,
    options: HandleSummarizationOptions,
  ): Summarizer {
    if (options.forceExternalModel) {
      config.onExternalSummarizationStart?.();
      return this.externalSummarizer;
    }
    if (this.canUseSelfSummary(options)) {
      return this.selfSummarizerFactory!(
        stateHandler,
        interactionListener,
        options.tools!,
        options.extraT,
        options.descriptionProps,
      );
    }
    config.onExternalSummarizationStart?.();
    return this.externalSummarizer;
  }

  async handleSummarization(
    parentCtx: Context,
    stateHandler: SummarizationStateHandler,
    rootPromptExecutor: SummarizationPromptExecutor,
    interactionListener: SummarizationInteractionListener,
    config: SummarizationOrchestratorConfig,
    requestContext: SummarizationRequestContext,
    options: HandleSummarizationOptions,
  ): Promise<RedactedString | undefined> {
    using spanContext = createSpan(parentCtx.withName("handleSummarization"));
    const ctx = spanContext.ctx;
    const { lastMode, isRootProject } = await resolveProjectConversationContext(ctx, stateHandler);
    if (isRootProject) stateHandler.isRootProjectConversation = true;
    const modePrompt = processModeSystemReminder(
      lastMode ?? stateHandler.mode ?? AgentMode.AGENT,
      config,
      requestContext,
      undefined,
      { isUserTurn: false },
    );
    const projectRootPrompt = stateHandler.isRootProjectConversation
      ? `<system_reminder>\n${formatProjectCompactionPrompt({
          promptText: config.projectPromptTextGenerator?.()!,
          sendMessageEnabled: isProjectSendMessageEnabled(stateHandler),
          coordinatorToolsEnabled: config.featureFlags?.cloudCoordinatorToolsEnabled === true,
        })}\n</system_reminder>`
      : undefined;
    const allMessages = rootPromptExecutor.getMessages();
    const unredAllMessages = fromRedactedCoreMessages(
      allMessages,
      PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    );
    if (!allMessages.find(message => message.role === "system")) {
      logger.warn(ctx, "Compaction skipped due to missing system message", {
        summarization: { allMessagesCount: allMessages.length },
      });
      throw new Error("No system prompt found");
    }
    const { messagesForSummarization } = prepareMessagesForCompaction(allMessages);
    const summarizer = this.getSummarizer(stateHandler, interactionListener, config, options);
    let summarizerModelId = summarizer.getMetricsModelLabel();
    let summarizationLogFields = {
      summarizationMode: options.backgroundSummarizationMode,
      triggerReason: options.triggerReason,
      model: summarizerModelId,
    };
    const strategy = options.fullSummarization ? "v5NalFull" : "v5NalPartial";
    const triggerReason = options.triggerReason;
    const isClientAtLeast1Point731 = "true";
    let summarizerType: "external" | "self" = options.forceExternalModel === true ||
        !this.canUseSelfSummary(options)
      ? "external"
      : "self";
    let useInProgressBackgroundSummarization = false;
    if (
      stateHandler.backgroundSummarizationPromiseInfo !== null &&
      stateHandler.messagesUndergoingSummarization !== null
    ) {
      const storedMessages = stateHandler.messagesUndergoingSummarization;
      const prefixValid = storedMessages.every((message, index) =>
        messagesEqualByValue(message, unredAllMessages[index])
      );
      if (prefixValid) {
        summarizerModelId = stateHandler.backgroundSummarizationPromiseInfo.modelId;
        summarizerType = stateHandler.backgroundSummarizationPromiseInfo.summarizerType;
        summarizationLogFields = { ...summarizationLogFields, model: summarizerModelId };
        logger.info(ctx, "Summarization with valid prefix is already underway.", {
          summarization: {
            ...summarizationLogFields,
            messagesInCurrentSummarizeRequestCount: messagesForSummarization.length,
            messagesAlreadyUndergoingSummarizationCount: storedMessages.length,
          },
        });
        useInProgressBackgroundSummarization = true;
      } else {
        logger.info(ctx, "Summarization prefix invalid. Clearing in-progress state.", {
          summarization: {
            ...summarizationLogFields,
            messagesInCurrentSummarizeRequestCount: messagesForSummarization.length,
            messagesAlreadyUndergoingSummarizationCount: storedMessages.length,
          },
        });
        if (
          options.backgroundSummarizationMode ===
            BackgroundSummarizationMode.BackgroundAndPersistIfCompleted
        ) {
          logger.warn(ctx, "Clearing state in mode BackgroundAndPersistIfCompleted", {
            summarization: {
              ...summarizationLogFields,
              messagesInCurrentSummarizeRequestCount: messagesForSummarization.length,
              messagesAlreadyUndergoingSummarizationCount: storedMessages.length,
            },
          });
        }
        backgroundSummarizationDiscarded.increment(ctx, 1, {
          reason: "prefix_invalid",
          model: stateHandler.backgroundSummarizationPromiseInfo.modelId,
        });
        stateHandler.clearBackgroundSummarizationState();
      }
    }
    if (!useInProgressBackgroundSummarization) {
      if (
        options.backgroundSummarizationMode ===
          BackgroundSummarizationMode.WaitForCompletionIfStarted
      ) {
        logger.info(
          ctx,
          "No in-flight background summarization in WaitForCompletionIfStarted mode. Returning without starting one.",
          { summarization: { ...summarizationLogFields, messagesInCurrentSummarizeRequestCount: messagesForSummarization.length } },
        );
        return undefined;
      }
      if (
        options.backgroundSummarizationMode ===
          BackgroundSummarizationMode.BackgroundAndPersistIfCompleted
      ) {
        logger.warn(
          ctx,
          "Starting summarization in BackgroundAndPersistIfCompleted mode which should only be called for a completed summarization",
          { summarization: { ...summarizationLogFields, messagesInCurrentSummarizeRequestCount: messagesForSummarization.length } },
        );
      }
      const cancellationToken = { cancelled: false };
      const summarizationPromise = (async (): Promise<SummarizationResult> => {
        const generationStart = performance.now();
        try {
          logger.info(ctx, "Starting new background summarization", {
            summarization: {
              ...summarizationLogFields,
              messagesToSummarizeCount: messagesForSummarization.length,
              summarizerModel: summarizerModelId,
              summarizationMode: options.backgroundSummarizationMode,
              triggerReason: options.triggerReason,
            },
          });
          backgroundSummarizationStarted.increment(ctx, 1, { model: summarizerModelId });
          const todoItems = await Promise.all(stateHandler.todos.map(todoRef => todoRef.get(ctx)));
          const todoContent = formatTodosForSummarization(todoItems);
          const includeTranscriptInSummary = config.enableTranscriptInSummary === true &&
            requestContext.env?.agentTranscriptsFolder !== undefined &&
            config.agentType !== AgentType.BACKGROUND;
          const result = await summarizer.summarize(ctx, allMessages, {
            fullSummarization: options.fullSummarization,
            currentPlan: options.currentPlan,
            modePrompt,
            projectRootPrompt,
            agentTranscriptsFolder: includeTranscriptInSummary
              ? requestContext.env?.agentTranscriptsFolder
              : undefined,
            conversationId: config.conversationId,
            automationTriggerContext: options.automationTriggerContext,
            todoContent,
            backgroundSummarizationMode: options.backgroundSummarizationMode,
            triggerReason: options.triggerReason,
            enableRetryOutputTokenLimit:
              options.backgroundSummarizationMode === BackgroundSummarizationMode.WaitForCompletion
                ? true
                : undefined,
            cancellationToken,
            contextWindowTokens: stateHandler.tokenDetails.maxTokens,
          });
          const generationDuration = performance.now() - generationStart;
          summarizationGenerationTime.histogram(ctx, generationDuration, {
            strategy,
            triggerReason,
            model: summarizerModelId,
            summarizerType,
            outcome: "success",
            isClientAtLeast1Point731,
          });
          stateHandler.setBackgroundSummarizationHasCompleted(generationDuration);
          logger.info(ctx, "Background summarization completed", {
            summarization: { ...summarizationLogFields, messagesToSummarizeCount: messagesForSummarization.length },
          });
          return result;
        } catch (error) {
          const generationDuration = performance.now() - generationStart;
          const errorKind = getRetryDirective(error, { transientRetryDelayMs: 0 }).errorType;
          summarizationGenerationTime.histogram(ctx, generationDuration, {
            strategy,
            triggerReason,
            model: summarizerModelId,
            summarizerType,
            outcome: "error",
            isClientAtLeast1Point731,
          });
          logger.error(ctx, "Background summarization failed, clearing state", error, {
            summarization: summarizationLogFields,
          });
          if (
            summarizerType === "self" &&
            (errorKind === "InputTokenLimitError" || errorKind === "InputTooLargeError")
          ) {
            stateHandler.setSelfSummaryInputLimitFailureTokenCount(stateHandler.tokenDetails.usedTokens);
          }
          stateHandler.clearBackgroundSummarizationState();
          throw error;
        }
      })();
      stateHandler.setBackgroundSummarizationState({
        promise: summarizationPromise,
        modelId: summarizerModelId,
        summarizerType,
        startInvocationId: options.currentInvocationId,
        startUsedTokens: stateHandler.tokenDetails.usedTokens,
        startMaxTokens: stateHandler.tokenDetails.maxTokens,
      }, allMessages, cancellationToken);
    }

    switch (options.backgroundSummarizationMode) {
      case BackgroundSummarizationMode.Background:
        logger.info(ctx, "Background summarization in progress in Background mode. Returning without awaiting completion.", {
          summarization: summarizationLogFields,
        });
        return undefined;
      case BackgroundSummarizationMode.BackgroundAndPersistIfCompleted:
        if (!stateHandler.backgroundSummarizationHasCompleted) {
          logger.info(ctx, "Background summarization is not completed yet in BackgroundAndPersistIfCompleted mode. REturning without awaiting completion.", { summarization: summarizationLogFields });
          return undefined;
        }
        logger.info(ctx, "Background summarization has completed in BackgroundAndPersistIfCompleted mode. Going to persist summary.", { summarization: summarizationLogFields });
        break;
      case BackgroundSummarizationMode.WaitForCompletion:
        logger.info(ctx, stateHandler.backgroundSummarizationHasCompleted
          ? "Background summarization has completed in WaitForCompletion mode. Going to persist summary."
          : "Background summarization is not completed in WaitForCompletion mode. Going to wait for completion and then persist summary.", { summarization: summarizationLogFields });
        break;
      case BackgroundSummarizationMode.WaitForCompletionIfStarted:
        logger.info(ctx, stateHandler.backgroundSummarizationHasCompleted
          ? "In-flight background summarization has completed in WaitForCompletionIfStarted mode. Going to persist summary."
          : "In-flight background summarization is not completed in WaitForCompletionIfStarted mode. Going to wait for completion and then persist summary.", { summarization: summarizationLogFields });
        break;
      default: throw new Error(`Unknown background summarization mode: ${String(options.backgroundSummarizationMode)}`);
    }

    const { contextWindowSize, contextTokens, contextUsagePercent } = getContextUsageInfo(
      stateHandler.tokenDetails,
    );
    const isFirstCompaction = stateHandler.summaryArchives.length === 0 &&
      stateHandler.selfSummaryCount === 0;
    const hookTrigger = options.triggerReason === "force_option" ||
        options.triggerReason === "force_dev_testing"
      ? "manual"
      : "auto";
    let hookMessage: string | undefined;
    if (
      config.enableExecuteHookExec &&
      isHookStepConfigured(requestContext.hooksConfig?.configuredSteps, "preCompact")
    ) {
      try {
        using span = createSpan(ctx.withName("agent.lifecycleHook.preCompact"));
        const hookCtx = span.ctx;
        const remoteHookExecutor = options.resourceAccessor.get(hookExecutorResource);
        if (remoteHookExecutor) {
          const hookArgs = new ExecuteHookArgs({
            request: new ExecuteHookRequest({
              request: {
                case: "preCompact",
                value: new PreCompactRequestQuery({
                  trigger: hookTrigger,
                  contextUsagePercent,
                  contextTokens: BigInt(contextTokens),
                  contextWindowSize: BigInt(contextWindowSize),
                  messageCount: allMessages.length,
                  messagesToCompact: messagesForSummarization.length,
                  isFirstCompaction,
                  conversationId: getConversationId(ctx)!,
                  generationId: getRequestId(ctx)!,
                  model: summarizerModelId,
                }),
              },
            }),
          });
          const result = await remoteHookExecutor.execute(hookCtx, hookArgs);
          if (result.response?.response.case === "preCompact") {
            const userMessage = result.response.response.value.userMessage;
            if (userMessage) {
              hookMessage = userMessage;
              logger.info(hookCtx, "[summarization] preCompact hook message", {
                summarization: { userMessage: hookMessage },
              });
            }
          }
        }
      } catch (error) {
        logger.warn(ctx, "[summarization] preCompact hook execution failed", {
          summarization: { error },
        });
      }
    }

    try {
      await interactionListener.sendUpdate(
        ctx,
        RedactedUpdates.summaryStarted(PrivacyMode.UNSPECIFIED),
      );
      const beforeSummarize = performance.now();
      const messagesSummarized = stateHandler.messagesUndergoingSummarization!;
      const backgroundInfo = stateHandler.backgroundSummarizationPromiseInfo!;
      const backgroundSummarizationModelId = backgroundInfo.modelId;
      const result = await backgroundInfo.promise;
      const {
        messagesActuallySummarized,
        newSummaryMessage,
        preservedOriginalTailMessages,
        rawSummary,
        summary,
        fullReplacementMessages,
        onPersisted,
      } = result;
      const summarizationDuration = performance.now() - beforeSummarize;
      const hadAbortError = result.errorKind?.toLowerCase()?.includes("abort") === true;
      if (
        this.backgroundSummarizationProps?.discardOnError !== false &&
        result.hadError &&
        (
          options.backgroundSummarizationMode !== BackgroundSummarizationMode.WaitForCompletion &&
            options.backgroundSummarizationMode !== BackgroundSummarizationMode.WaitForCompletionIfStarted ||
          hadAbortError
        )
      ) {
        stateHandler.clearBackgroundSummarizationState();
        backgroundSummarizationDiscarded.increment(ctx, 1, {
          reason: hadAbortError ? "abort_error" : "summarization_error",
          model: backgroundSummarizationModelId,
        });
        logger.warn(ctx, "Discarding background summarization due to generation error", {
          summarization: { ...summarizationLogFields, errorKind: result.errorKind ?? "unknown" },
        });
        return undefined;
      }
      const redactedCoreMessageSerde = createRedactedCoreMessageSerde(stateHandler.getPrivacyMode());
      const rawWindowTail = messagesForSummarization.length - messagesActuallySummarized.length;
      if (rawWindowTail < 0) {
        logger.warn(ctx, "Clamping negative windowTail during compaction", {
          summarization: {
            messagesForSummarizationCount: messagesForSummarization.length,
            messagesActuallySummarizedCount: messagesActuallySummarized.length,
            rawWindowTail,
          },
        });
      }
      const summarizedMessages = await Promise.all(
        messagesActuallySummarized
          .filter(message => !(message.providerOptions as {
            readonly cursor?: { readonly isSummary?: unknown } | undefined;
          } | undefined)?.cursor?.isSummary)
          .map(async message => {
            const serializedMessage = redactedCoreMessageSerde.serialize(message);
            const blobId = await getBlobId(serializedMessage);
            await stateHandler.getBlobStore().setBlob(ctx, blobId, serializedMessage);
            return blobId;
          }),
      );
      const serializedSummaryMessage = redactedCoreMessageSerde.serialize(newSummaryMessage);
      const summaryMessageBlobId = await getBlobId(serializedSummaryMessage);
      await stateHandler.getBlobStore().setBlob(ctx, summaryMessageBlobId, serializedSummaryMessage);
      stateHandler.pushSummaryArchive(createRedactedConversationSummaryArchive(
        stateHandler.getPrivacyMode(),
        {
          summarizedMessages,
          summary: summary.summary,
          summaryMessage: summaryMessageBlobId,
          windowTail: Math.max(0, rawWindowTail),
        },
      ));
      const generationDurationMsBeforeClear =
        stateHandler.backgroundSummarizationGenerationDurationMs;
      stateHandler.clearBackgroundSummarizationState();
      stateHandler.tokenDetailsStaleAfterSummarization = true;
      const replacementMessages = config.getNamedAgentSelfDocument !== undefined
        ? await refreshNamedAgentSelfDocumentInMessages(
            ctx,
            fullReplacementMessages,
            config.getNamedAgentSelfDocument,
            stateHandler.getPrivacyMode(),
          )
        : fullReplacementMessages;
      rootPromptExecutor.clearMessages();
      rootPromptExecutor.appendMessages(replacementMessages);
      const messagesNotSummarized = allMessages.slice(messagesSummarized.length);
      rootPromptExecutor.appendMessages(messagesNotSummarized);
      stateHandler.retainCompletedAskQuestionReceipts(
        collectLiveAskQuestionOriginalIds(rootPromptExecutor.getMessages()),
      );
      const persistedEstimatedTokens = estimateTokenCount(replacementMessages) +
        estimateTokenCount(messagesNotSummarized);
      const model = summarizerModelId;
      const additionalMessagesStats = countMessageKinds(messagesNotSummarized);
      logger.info(ctx, "Persisted completed summarization", {
        summarization: {
          ...summarizationLogFields,
          messagesSummarizedCount: messagesSummarized.length,
          messagesNotSummarizedCount: messagesNotSummarized.length,
          additionalMessagesUserCount: additionalMessagesStats.userMessages,
          additionalMessagesSystemCount: additionalMessagesStats.systemMessages,
          additionalMessagesAssistantCount: additionalMessagesStats.assistantMessages,
          additionalMessagesToolMessageCount: additionalMessagesStats.toolMessages,
          additionalMessagesToolCallCount: additionalMessagesStats.toolCalls,
          persistedEstimatedTokens,
          hadError: result.hadError === true,
          errorKind: result.hadError === true ? result.errorKind ?? "unknown" : "none",
          model,
        },
      });
      backgroundSummarizationPersisted.increment(ctx, 1, {
        hadError: result.hadError === true ? "true" : "false",
        errorKind: result.hadError === true ? result.errorKind ?? "unknown" : "none",
        model: backgroundSummarizationModelId,
      });
      backgroundSummarizationPersistedEstimatedTokens.histogram(ctx, persistedEstimatedTokens, {
        model: backgroundSummarizationModelId,
      });
      const additionalMetricRows = [
        [additionalMessagesStats.userMessages, "user_message"],
        [additionalMessagesStats.systemMessages, "system_message"],
        [additionalMessagesStats.assistantMessages, "assistant_message"],
        [additionalMessagesStats.toolMessages, "tool_message"],
        [additionalMessagesStats.toolCalls, "tool_call"],
      ] as const;
      for (const [value, kind] of additionalMetricRows) {
        backgroundSummarizationPersistedAdditionalMessages.histogram(ctx, value, {
          model: backgroundSummarizationModelId,
          kind,
        });
      }
      stateHandler.clearSelfSummaryInputLimitFailureTokenCount();
      onPersisted?.();
      summarizationTime.histogram(ctx, summarizationDuration, {
        strategy,
        triggerReason,
        model,
        summarizerType,
        isClientAtLeast1Point731,
      });
      if (generationDurationMsBeforeClear !== null) {
        backgroundSummarizationTimeSavedMs.histogram(
          ctx,
          Math.max(0, generationDurationMsBeforeClear - summarizationDuration),
          { model: backgroundSummarizationModelId },
        );
      }
      summarizationCounter.increment(ctx, 1, {
        strategy,
        requestedStrategy: strategy,
        triggerReason,
        isToolCall: options.isToolCall === true ? "true" : "false",
        model,
        summarizerType,
        isClientAtLeast1Point731,
        ...getClientVersionMetricTagsFromContext(ctx),
      });
      const summarizedStats = countMessageKinds(messagesActuallySummarized);
      const eventTracker = getAgentEventTracker(ctx);
      eventTracker.trackSummarizationTriggered(ctx, {
        userMessageCountBeforeSummarization: summarizedStats.userMessages,
        toolCallCountBeforeSummarization: summarizedStats.toolCalls,
        summaryLengthInChars: summary.summary.length,
        summarizationModelId: backgroundSummarizationModelId,
        mainModelId: config.modelId,
        summarizerType,
        summarizationStartInvocationId: backgroundInfo.startInvocationId,
        summarizationPersistInvocationId: options.currentInvocationId,
        triggerTokensUsed: backgroundInfo.startUsedTokens,
        triggerTokensMax: backgroundInfo.startMaxTokens,
        additionalMessagesCount: messagesNotSummarized.length,
        additionalUserMessageCount: additionalMessagesStats.userMessages,
        additionalSystemMessageCount: additionalMessagesStats.systemMessages,
        additionalAssistantMessageCount: additionalMessagesStats.assistantMessages,
        additionalToolMessageCount: additionalMessagesStats.toolMessages,
        additionalToolCallCount: additionalMessagesStats.toolCalls,
      });
      const gradingTailMessages = [...preservedOriginalTailMessages, ...messagesNotSummarized];
      const preservedTailMessageSet = new Set(preservedOriginalTailMessages);
      const preservedTailIndices = new Set(
        fullReplacementMessages.flatMap((message, index) =>
          preservedTailMessageSet.has(message) ? [index] : []
        ),
      );
      const effectiveContextMessages = [
        ...replacementMessages.filter((message, index) =>
          message === newSummaryMessage ||
          (message.providerOptions as {
            readonly cursor?: { readonly isSummary?: unknown } | undefined;
          } | undefined)?.cursor?.isSummary === true ||
          preservedTailIndices.has(index)
        ),
        ...messagesNotSummarized,
      ];
      eventTracker.trackSummarizationPersistedForQualityGrading?.(ctx, {
        preSummarizationMessages: messagesActuallySummarized,
        modelSummaryText: summary.summary.safeTransform(() => rawSummary.text),
        persistedSummaryMessage: newSummaryMessage,
        effectiveContextMessages,
        preservedTailMessages: gradingTailMessages,
        summarizerType,
        summarizationHadError: result.hadError === true,
        summarizationErrorKind: result.hadError === true ? result.errorKind ?? "unknown" : undefined,
        summarizationModelId: backgroundSummarizationModelId,
        mainModelId: config.modelId,
        summarizationStartInvocationId: backgroundInfo.startInvocationId,
        summarizationPersistInvocationId: options.currentInvocationId,
      });
      if (
        config.enableTranscriptInSummary === true &&
        requestContext.env?.agentTranscriptsFolder !== undefined &&
        config.agentType !== AgentType.BACKGROUND
      ) {
        logger.info(ctx, "Summary includes transcript pointer", {
          summarization: { conversationId: config.conversationId },
        });
      }
      return summary.summary;
    } finally {
      await interactionListener.sendUpdate(
        ctx,
        toRedactedInteractionUpdate(
          Updates.summaryCompleted(hookMessage as SummaryCompletedHookMessage),
          PrivacyMode.UNSPECIFIED,
        ),
      );
    }
  }
}
