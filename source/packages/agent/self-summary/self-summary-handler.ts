import {
  appendDurableBlocks,
  prependDurableBlocks,
  renderDurableBlocks,
  type DurableBlockEnrichments,
} from "../../agent-summarization/durable-blocks.js";
import {
  getRetryDirective,
  NoSummaryResponseError,
} from "../../agent-summarization/error-handling.js";
import {
  runSummarizationPipeline,
  type SummarizationEnrichments,
  type SummarizationPipelineOptions,
} from "../../agent-summarization/pipeline.js";
import { prepareMessagesForCompaction } from "../../agent-summarization/prepare-messages.js";
import { collectAllSkillBlocks } from "../../agent-summarization/skill-persistence.js";
import {
  SHORTER_OUTPUT_RETRY_PROMPT,
  SUMMARIZATION_CURSOR_PROVIDER_OPTIONS,
} from "../../agent-summarization/summarization-handler.js";
import { toUnredactedInteractionListener } from "../../agent-core/redacted-interaction-listener.js";
import type { Context } from "../../context/core.js";
import { createLogger, createSpan } from "../../context/index.js";
import { createCounter, createHistogram } from "../../metrics/index.js";
import { DataClassification, PrivacyCapability } from "../../redaction/classification.js";
import { fromRedactedCoreMessage, toRedactedCoreMessage, type CoreMessageLike } from "../../redaction/core-message.js";
import { createRedactedString, safeString } from "../../redaction/factory.js";
import type { PrivacyMode } from "../../redaction/privacy-mode.js";
import { InteractionHandler } from "../interaction-handler.js";
import { buildDescriptionGeneratorProps } from "../tools/core.js";
import { getInvocationId } from "../utils/invocation-id.js";
import {
  getMaxModeFromContext,
  getMembershipTypeMetricTagsFromContext,
} from "../utils/request-id.js";
import { MAX_SELF_SUMMARY_RETRIES, SELF_SUMMARIZATION_PROMPT } from "./constants.js";
import { extractTextContent } from "./token-estimate.js";
import { findLastUserMessageIndex, type SelfSummaryMessage } from "./self-summary.js";

type RedactedCoreMessage = Parameters<typeof fromRedactedCoreMessage>[0];
type RedactedInteractionListener = Parameters<typeof toUnredactedInteractionListener<Context>>[0];

export interface SelfSummaryExtendedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
}

export interface SelfSummaryResponse {
  readonly messages: readonly CoreMessageLike[];
  readonly error?: unknown;
}

export interface SelfSummaryStreamResult {
  readonly fullStream: AsyncIterable<unknown>;
  readonly extendedUsage: Promise<SelfSummaryExtendedUsage>;
  readonly usage: Promise<unknown>;
  readonly providerMetadata: Promise<unknown>;
  readonly invocationId: Promise<unknown>;
  readonly response: Promise<SelfSummaryResponse>;
}

export interface SelfSummaryToolStreamExecutor {
  appendMessages(messages: readonly CoreMessageLike[]): unknown;
  executeToolStream(
    ctx: Context,
    stateHandler: SelfSummaryStateHandler,
    interactionHandler: InteractionHandler,
    tools: SelfSummaryTool[],
    extra: unknown,
    onToolCall: () => Promise<void>,
    descriptionProps: Record<string, unknown>,
  ): SelfSummaryStreamResult;
}

export interface SelfSummaryPromptSession {
  getExecutor(): SelfSummaryToolStreamExecutor;
}

export interface SelfSummaryTool {
  readonly name: string;
  readonly toolIdentifier: string;
  readonly parameters: unknown;
  readonly [key: string]: unknown;
}

export interface SelfSummaryStateHandler {
  readonly selfSummaryCount: number;
  getPrivacyMode(): PrivacyMode;
  addTurnUsage(usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number | undefined;
    readonly cacheWriteTokens?: number | undefined;
    readonly reasoningTokens?: number | undefined;
  }): void;
  incrementSelfSummaryCount(): void;
}

export interface SelfSummaryRetryOptions {
  readonly descriptionProps?: Record<string, unknown> | undefined;
  readonly enableRetryNoSummaryResponse?: boolean | undefined;
  readonly enableReduceInputsRetry?: boolean | undefined;
  readonly enableRetryUncategorizedErrors?: boolean | undefined;
}

interface SelfSummaryPartition {
  readonly systemMessage: RedactedCoreMessage | undefined;
  readonly userInfoMessage: RedactedCoreMessage | undefined;
  readonly messagesToSummarize: readonly RedactedCoreMessage[];
  readonly preservedTailMessages: readonly RedactedCoreMessage[];
  readonly skillBlocks: readonly string[];
}

interface SelfSummaryRawResult {
  readonly text: string;
}

const logger = createLogger("@anysphere/agent");
const TRANSIENT_SELF_SUMMARY_RETRY_DELAY_MS = 2_000;
const TOOL_MESSAGE_DROP_THRESHOLD = 0.25;
const selfSummaryInputTokens = createHistogram("self_summary.input_token", {
  description: "Input tokens consumed during self-summarization",
  labelNames: ["membershiptype"],
});
const selfSummaryOutputTokens = createHistogram("self_summary.output_token", {
  description: "Output tokens generated during self-summarization",
  labelNames: ["membershiptype"],
});
const selfSummaryTimeTakenMs = createHistogram("self_summary.time_taken_ms", {
  description: "Time taken for self-summarization in milliseconds",
  labelNames: ["membershiptype"],
});
const selfSummaryStatus = createCounter("self_summary.status", {
  description: "Count of self-summary attempts and their outcomes",
  labelNames: ["outcome", "errorKind", "membershiptype", "maxmode"],
});
const selfSummaryTryAttempts = createCounter("self_summary.try.attempts", {
  description: "Per-try self-summary attempts within the retry loop",
  labelNames: ["membershiptype"],
});
const selfSummaryTrySuccess = createCounter("self_summary.try.success", {
  description: "Per-try successful self-summary attempts",
  labelNames: ["membershiptype"],
});
const selfSummaryTryFailures = createCounter("self_summary.try.failures", {
  description: "Per-try failed self-summary attempts",
  labelNames: ["errorKind", "membershiptype"],
});
const selfSummaryRetries = createCounter("self_summary.retries", {
  description: "Total retries (attempts beyond the first) that actually executed",
  labelNames: ["errorKind", "membershiptype"],
});
const selfSummaryUnexpectedToolCalls = createCounter("self_summary.unexpected_tool_calls", {
  description: "Count of unexpected tool calls detected in self-summary response",
  labelNames: ["membershiptype"],
});

async function executeSelfSummaryStream(
  parentCtx: Context,
  executor: SelfSummaryToolStreamExecutor,
  stateHandler: SelfSummaryStateHandler,
  interactionListener: RedactedInteractionListener,
  tools: SelfSummaryTool[],
  extra: unknown,
  descriptionProps: Record<string, unknown> | undefined,
): Promise<{
  assistantMessage: CoreMessageLike;
  textContent: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | undefined;
  cacheWriteTokens: number | undefined;
}> {
  using spanContext = createSpan(parentCtx.withName("executeSelfSummaryStream"));
  const ctx = spanContext.ctx;
  const invocationId = getInvocationId(ctx);
  const noOpToolCallRecorder = { recordToolCall: () => {} };
  const noOpInteractionHandler = new InteractionHandler(
    toUnredactedInteractionListener(interactionListener, stateHandler.getPrivacyMode()),
    noOpToolCallRecorder,
    invocationId,
  );
  const result = executor.executeToolStream(
    ctx,
    stateHandler,
    noOpInteractionHandler,
    tools,
    extra,
    async () => {},
    descriptionProps ?? buildDescriptionGeneratorProps(tools),
  );
  result.extendedUsage.catch(error => {
    logger.error(ctx, "[self-summary] Error getting extended usage", error, { summarization: { invocationId } });
  });
  result.usage.catch(error => {
    logger.error(ctx, "[self-summary] Error getting usage", error, { summarization: { invocationId } });
  });
  result.providerMetadata.catch(error => {
    logger.error(ctx, "[self-summary] Error getting provider metadata", error, { summarization: { invocationId } });
  });
  result.invocationId.catch(error => {
    logger.error(ctx, "[self-summary] Error getting invocation id", error, { summarization: { invocationId } });
  });
  result.response.catch(error => {
    logger.error(ctx, "[self-summary] Error getting response", error, { summarization: { invocationId } });
  });
  for await (const _chunk of result.fullStream) {}
  const response = await result.response;
  const extendedUsage = await result.extendedUsage;
  const membershipTags = getMembershipTypeMetricTagsFromContext(ctx);
  selfSummaryInputTokens.histogram(ctx, extendedUsage.inputTokens, membershipTags);
  selfSummaryOutputTokens.histogram(ctx, extendedUsage.outputTokens, membershipTags);
  if (response.error) throw response.error;
  stateHandler.addTurnUsage({
    inputTokens: extendedUsage.inputTokens,
    outputTokens: extendedUsage.outputTokens,
    cacheReadTokens: extendedUsage.cacheReadTokens,
    cacheWriteTokens: extendedUsage.cacheWriteTokens,
    reasoningTokens: extendedUsage.reasoningTokens,
  });
  let hasAnyToolCalls = false;
  for (const message of response.messages) {
    const hasToolCalls = message.role === "assistant" && Array.isArray(message.content) &&
      message.content.some(part => (part as { type?: unknown }).type === "tool-call");
    if (hasToolCalls) {
      hasAnyToolCalls = true;
      selfSummaryUnexpectedToolCalls.increment(ctx, 1, membershipTags);
    }
  }
  if (hasAnyToolCalls) {
    logger.error(ctx, "[self-summary] unexpected tool calls detected in summarization response", {
      summarization: { invocationId },
    });
  }
  if (response.messages.length > 1) {
    logger.info(ctx, "[self-summary] self summary response stream contained more than one message", {
      summarization: { messageCount: response.messages.length, invocationId },
    });
  }
  const assistantMessage = response.messages.at(-1);
  if (assistantMessage?.role !== "assistant") throw new NoSummaryResponseError();
  const textContent = extractTextContent(
    toRedactedCoreMessage(assistantMessage, stateHandler.getPrivacyMode()) as SelfSummaryMessage,
  ).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
  return {
    assistantMessage,
    textContent,
    inputTokens: extendedUsage.inputTokens,
    outputTokens: extendedUsage.outputTokens,
    cacheReadTokens: extendedUsage.cacheReadTokens,
    cacheWriteTokens: extendedUsage.cacheWriteTokens,
  };
}

function appendShorterOutputRetryInstruction(inputMessages: readonly CoreMessageLike[]): readonly CoreMessageLike[] {
  const nextMessages = inputMessages.slice();
  const promptMessage = nextMessages.at(-1);
  if (promptMessage === undefined || promptMessage.role === "tool" || typeof promptMessage.content !== "string") {
    return inputMessages;
  }
  nextMessages[nextMessages.length - 1] = {
    ...promptMessage,
    content: `${promptMessage.content}${SHORTER_OUTPUT_RETRY_PROMPT}`,
  };
  return nextMessages;
}

function reduceSelfSummaryInputMessages(
  inputMessages: readonly CoreMessageLike[],
  preservedPrefixMessageCount: number,
): readonly CoreMessageLike[] {
  if (inputMessages.length <= preservedPrefixMessageCount + 1) return inputMessages;
  const prefixMessages = inputMessages.slice(0, preservedPrefixMessageCount);
  const promptMessage = inputMessages.at(-1);
  const middleMessages = inputMessages.slice(preservedPrefixMessageCount, -1);
  const isAssistantToolCallMessage = (message: CoreMessageLike) =>
    message.role === "assistant" && Array.isArray(message.content) &&
    message.content.some(part => (part as { type?: unknown }).type === "tool-call");
  if (promptMessage === undefined || middleMessages.length === 0) return inputMessages;
  const toolMessageCount = middleMessages.filter(message => message.role === "tool").length;
  if (toolMessageCount > 0 && toolMessageCount / middleMessages.length >= TOOL_MESSAGE_DROP_THRESHOLD) {
    const keptMiddleMessages = middleMessages.filter(
      message => message.role !== "tool" && !isAssistantToolCallMessage(message),
    );
    return [...prefixMessages, ...keptMiddleMessages, promptMessage];
  }
  if (middleMessages.length === 1) {
    const onlyMessage = middleMessages[0]!;
    if (onlyMessage.role === "tool" || typeof onlyMessage.content !== "string" || onlyMessage.content.length < 2) {
      return inputMessages;
    }
    const nextContent = onlyMessage.content.slice(Math.floor(onlyMessage.content.length / 2));
    return [...prefixMessages, { ...onlyMessage, content: nextContent }, promptMessage];
  }
  let keptMiddleMessageStartIndex = Math.floor(middleMessages.length / 2);
  while (
    keptMiddleMessageStartIndex < middleMessages.length &&
    middleMessages[keptMiddleMessageStartIndex]?.role === "tool"
  ) {
    keptMiddleMessageStartIndex++;
  }
  const keptMiddleMessages = middleMessages.slice(keptMiddleMessageStartIndex);
  return [...prefixMessages, ...keptMiddleMessages, promptMessage];
}

export async function executeSelfSummaryWithRetry(
  parentCtx: Context,
  summarizationPromptSession: SelfSummaryPromptSession,
  stateHandler: SelfSummaryStateHandler,
  interactionListener: RedactedInteractionListener,
  summarizationInputMessages: readonly CoreMessageLike[],
  tools: SelfSummaryTool[],
  extra: unknown,
  options: SelfSummaryRetryOptions & { readonly preservedPrefixMessageCount: number },
): Promise<Awaited<ReturnType<typeof executeSelfSummaryStream>>> {
  using spanContext = createSpan(parentCtx.withName("executeSelfSummaryWithRetry"));
  const ctx = spanContext.ctx;
  const membershipTags = getMembershipTypeMetricTagsFromContext(ctx);
  const maxmode = getMaxModeFromContext(ctx) ? "true" : "false";
  let currentInputMessages = summarizationInputMessages;
  let requestShorterOutput = false;
  let lastErrorKind: string | undefined;
  for (let attempt = 1; attempt <= MAX_SELF_SUMMARY_RETRIES; attempt++) {
    logger.info(ctx, "[self-summary] attempt started", {
      summarization: {
        attempt,
        maxRetries: MAX_SELF_SUMMARY_RETRIES,
        inputMessageCount: currentInputMessages.length,
        requestShorterOutput,
      },
    });
    selfSummaryTryAttempts.increment(ctx, 1, membershipTags);
    try {
      const executor = summarizationPromptSession.getExecutor();
      executor.appendMessages(currentInputMessages);
      const result = await executeSelfSummaryStream(
        ctx,
        executor,
        stateHandler,
        interactionListener,
        tools,
        extra,
        options.descriptionProps,
      );
      const hasContent = result.textContent.trim().length > 0;
      if (hasContent) {
        logger.info(ctx, "[self-summary] attempt succeeded", {
          summarization: { attempt, contentLength: result.textContent.length },
        });
        selfSummaryTrySuccess.increment(ctx, 1, membershipTags);
        selfSummaryStatus.increment(ctx, 1, {
          outcome: "success",
          errorKind: "Ok",
          ...membershipTags,
          maxmode,
        });
        return result;
      }
      const willRetry = attempt < MAX_SELF_SUMMARY_RETRIES;
      lastErrorKind = "EmptyContent";
      selfSummaryTryFailures.increment(ctx, 1, { errorKind: "EmptyContent", ...membershipTags });
      logger.warn(ctx, "[self-summary] empty content received", {
        summarization: { attempt, maxRetries: MAX_SELF_SUMMARY_RETRIES, willRetry },
      });
      if (!willRetry) break;
      selfSummaryRetries.increment(ctx, 1, { errorKind: "EmptyContent", ...membershipTags });
    } catch (error) {
      const enableRetryNoSummaryResponse = options.enableRetryNoSummaryResponse ?? false;
      const enableReduceInputsRetry = options.enableReduceInputsRetry ?? true;
      const enableRetryUncategorizedErrors = options.enableRetryUncategorizedErrors ?? true;
      const retryDirective = getRetryDirective(error, {
        transientRetryDelayMs: TRANSIENT_SELF_SUMMARY_RETRY_DELAY_MS,
        enableRetryNoSummaryResponse,
        enableReduceInputsRetry,
        enableRetryUncategorizedErrors,
      });
      const willRetry = retryDirective.shouldRetry && attempt < MAX_SELF_SUMMARY_RETRIES;
      lastErrorKind = retryDirective.errorType;
      selfSummaryTryFailures.increment(ctx, 1, { errorKind: retryDirective.errorType, ...membershipTags });
      logger.error(ctx, "[self-summary] attempt failed with error", error, {
        summarization: {
          attempt,
          maxRetries: MAX_SELF_SUMMARY_RETRIES,
          errorType: retryDirective.errorType,
          willRetry,
          retryDelayMs: retryDirective.retryDelayMs,
          requestShorterOutput: retryDirective.requestShorterOutput,
          reduceInputs: retryDirective.reduceInputs,
          options: {
            enableReduceInputsRetry,
            enableRetryNoSummaryResponse,
            enableRetryUncategorizedErrors,
          },
        },
      });
      if (!willRetry) {
        selfSummaryStatus.increment(ctx, 1, {
          outcome: "failed",
          errorKind: retryDirective.errorType,
          ...membershipTags,
          maxmode,
        });
        throw error;
      }
      selfSummaryRetries.increment(ctx, 1, { errorKind: retryDirective.errorType, ...membershipTags });
      if (retryDirective.requestShorterOutput && !requestShorterOutput) {
        currentInputMessages = appendShorterOutputRetryInstruction(currentInputMessages);
        requestShorterOutput = true;
        logger.info(ctx, "[self-summary] retrying with shorter-output instruction", {
          summarization: { attempt, nextAttempt: attempt + 1 },
        });
      }
      if (retryDirective.reduceInputs) {
        const nextInputMessages = reduceSelfSummaryInputMessages(
          currentInputMessages,
          options.preservedPrefixMessageCount,
        );
        logger.info(ctx, "[self-summary] retrying with reduced inputs", {
          summarization: {
            attempt,
            previousInputMessageCount: currentInputMessages.length,
            nextInputMessageCount: nextInputMessages.length,
          },
        });
        currentInputMessages = nextInputMessages;
      }
      if (retryDirective.retryDelayMs > 0) {
        logger.info(ctx, "[self-summary] retrying after delay", {
          summarization: { attempt, retryDelayMs: retryDirective.retryDelayMs },
        });
        await new Promise(resolve => setTimeout(resolve, retryDirective.retryDelayMs));
      }
    }
  }
  logger.error(ctx, "[self-summary] all retries exhausted", {
    summarization: { maxRetries: MAX_SELF_SUMMARY_RETRIES },
  });
  selfSummaryStatus.increment(ctx, 1, {
    outcome: "failed",
    errorKind: lastErrorKind ?? "EmptyContent",
    ...membershipTags,
    maxmode,
  });
  throw new Error("[self-summary] all retries exhausted without valid content");
}

export class SelfSummarizer {
  declare readonly promptSession: SelfSummaryPromptSession;
  declare readonly stateHandler: SelfSummaryStateHandler;
  declare readonly interactionListener: RedactedInteractionListener;
  declare readonly tools: SelfSummaryTool[];
  declare readonly extraT: unknown;
  declare readonly modelId: string;
  declare readonly retryOptions: SelfSummaryRetryOptions;
  declare readonly enableTranscriptEnrichment: boolean;

  constructor(
    promptSession: SelfSummaryPromptSession,
    stateHandler: SelfSummaryStateHandler,
    interactionListener: RedactedInteractionListener,
    tools: SelfSummaryTool[],
    extraT: unknown,
    modelId: string,
    retryOptions?: SelfSummaryRetryOptions,
    enableTranscriptEnrichment?: boolean,
  ) {
    this.promptSession = promptSession;
    this.stateHandler = stateHandler;
    this.interactionListener = interactionListener;
    this.tools = tools;
    this.extraT = extraT;
    this.modelId = modelId;
    this.retryOptions = retryOptions ?? {};
    this.enableTranscriptEnrichment = enableTranscriptEnrichment ?? false;
  }

  getModelId(): string { return this.modelId; }
  getMetricsModelLabel(): string { return this.modelId; }

  partitionMessages(messages: readonly RedactedCoreMessage[], _options: SummarizationPipelineOptions): SelfSummaryPartition {
    if (messages.length < 3) {
      throw new Error(`Self-summary requires at least 3 messages, got ${messages.length}`);
    }
    const { systemMessage, userInfoMessage, messagesForSummarization } = prepareMessagesForCompaction(messages);
    if (!systemMessage || systemMessage.role !== "system") {
      throw new Error("Expected system message in conversation");
    }
    const lastUserIndex = findLastUserMessageIndex(messages as SelfSummaryMessage[]);
    const lastUserQuery = messages[lastUserIndex];
    const skillBlocks = collectAllSkillBlocks(messagesForSummarization);
    return {
      systemMessage,
      userInfoMessage,
      messagesToSummarize: messagesForSummarization,
      preservedTailMessages: lastUserQuery ? [lastUserQuery] : [],
      skillBlocks,
    };
  }

  async generateSummary(
    ctx: Context,
    partitioned: SelfSummaryPartition,
    _options: SummarizationPipelineOptions,
  ): Promise<SelfSummaryRawResult> {
    if (!partitioned.systemMessage) throw new Error("Expected system message in conversation");
    const privacySource = partitioned.preservedTailMessages[0] ?? partitioned.userInfoMessage ?? partitioned.systemMessage;
    const summarizationInputMessages: RedactedCoreMessage[] = [
      partitioned.systemMessage,
      ...(partitioned.userInfoMessage ? [partitioned.userInfoMessage] : []),
      ...partitioned.messagesToSummarize,
      {
        _privacyMode: privacySource._privacyMode,
        role: "user",
        content: safeString(SELF_SUMMARIZATION_PROMPT),
        providerOptions: SUMMARIZATION_CURSOR_PROVIDER_OPTIONS,
      },
    ];
    const unredact = (message: RedactedCoreMessage) =>
      fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    const { assistantMessage } = await executeSelfSummaryWithRetry(
      ctx,
      this.promptSession,
      this.stateHandler,
      this.interactionListener,
      summarizationInputMessages.map(unredact),
      this.tools,
      this.extraT,
      {
        preservedPrefixMessageCount: 1 + (partitioned.userInfoMessage !== undefined ? 1 : 0),
        ...this.retryOptions,
      },
    );
    const summaryText = extractTextContent(
      toRedactedCoreMessage(assistantMessage, this.stateHandler.getPrivacyMode()) as SelfSummaryMessage,
    ).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    return { text: summaryText };
  }

  buildSummaryMessage(
    rawSummary: SelfSummaryRawResult,
    partitioned: SelfSummaryPartition,
    enrichments: SummarizationEnrichments,
  ): { message: RedactedCoreMessage; summaryTextLength: number } {
    const totalSummariesAfter = this.stateHandler.selfSummaryCount + 1;
    const durableBlocks = renderDurableBlocks("self-summary", enrichments as DurableBlockEnrichments, {
      includeTranscript: this.enableTranscriptEnrichment,
    });
    const wrappedContent = `${prependDurableBlocks("self-summary", durableBlocks)}

Your conversation was summarized due to context constraints. Here is the summary of the conversation so far:

<summary_content>
${rawSummary.text}
</summary_content>${appendDurableBlocks("self-summary", durableBlocks)}

Total summaries generated so far for this user query: ${totalSummariesAfter}

If the task is complete, respond to the user. Otherwise, continue working on the task.`;
    const lastUserQuery = partitioned.preservedTailMessages[0];
    const privacySource = lastUserQuery ?? partitioned.userInfoMessage ?? partitioned.systemMessage;
    const summaryPrivacyMode = privacySource!._privacyMode ?? this.stateHandler.getPrivacyMode();
    return {
      message: toRedactedCoreMessage({
        role: "user",
        content: wrappedContent,
        providerOptions: { cursor: { isSummary: true } },
      }, summaryPrivacyMode),
      summaryTextLength: wrappedContent.length,
    };
  }

  assembleFinalMessages(
    partitioned: SelfSummaryPartition,
    summaryMessage: RedactedCoreMessage,
  ): readonly RedactedCoreMessage[] {
    if (!partitioned.systemMessage) throw new Error("Expected system message in conversation");
    return [
      partitioned.systemMessage,
      ...(partitioned.userInfoMessage ? [partitioned.userInfoMessage] : []),
      ...partitioned.preservedTailMessages,
      summaryMessage,
    ];
  }

  async summarize(
    ctx: Context,
    messages: readonly RedactedCoreMessage[],
    options: SummarizationPipelineOptions,
  ): Promise<Record<string, unknown>> {
    using spanContext = createSpan(ctx.withName("SelfSummarizer.summarize"));
    const innerCtx = spanContext.ctx;
    const startTime = performance.now();
    logger.info(innerCtx, "[self-summary] SelfSummarizer.summarize starting", {
      summarization: { messageCount: messages.length, modelId: this.modelId },
    });
    try {
      const pipelineResult = await runSummarizationPipeline(this, innerCtx, messages, options);
      const summaryCodeString = createRedactedString(
        pipelineResult.rawSummary.text,
        DataClassification.CODE,
        "summary",
        this.stateHandler.getPrivacyMode(),
      );
      logger.info(innerCtx, "[self-summary] SelfSummarizer.summarize completed", {
        summarization: {
          summaryTextLength: pipelineResult.rawSummary.text.length,
          fullReplacementMessagesCount: pipelineResult.fullReplacementMessages.length,
          messagesActuallySummarizedCount: pipelineResult.messagesActuallySummarized.length,
        },
      });
      return {
        ...pipelineResult,
        summary: { summary: summaryCodeString },
        onPersisted: () => { this.stateHandler.incrementSelfSummaryCount(); },
      };
    } finally {
      selfSummaryTimeTakenMs.histogram(
        innerCtx,
        performance.now() - startTime,
        getMembershipTypeMetricTagsFromContext(innerCtx),
      );
    }
  }
}
