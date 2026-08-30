import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { InputTokenLimitError } from "../chat-inference/prompt-executor.js";
import type { Context } from "../context/core.js";
import { createLogger } from "../context/logger.js";
import { createCounter, createHistogram } from "../metrics/index.js";
import { DataClassification, PrivacyCapability } from "../redaction/classification.js";
import {
  fromRedactedCoreMessage,
  toRedactedCoreMessage,
  type CoreMessageLike,
} from "../redaction/core-message.js";
import { createRedactedString } from "../redaction/factory.js";
import { PrivacyMode } from "../redaction/privacy-mode.js";
import { isRedactedString, type RedactedString } from "../redaction/types.js";
import { BackgroundSummarizationMode } from "./background-summarization.js";
import {
  buildDeterministicSummaryText,
  computeDeterministicFallbackMaxChars,
  DEFAULT_DETERMINISTIC_FALLBACK_WINDOW_RATIO,
} from "./deterministic-summary-builder.js";
import {
  appendDurableBlocks,
  renderDurableBlocks,
  type DurableBlockEnrichments,
} from "./durable-blocks.js";
import { CannotTruncatePromptError, getRetryDirective } from "./error-handling.js";
import {
  findLatestImagePart,
  toUserMessageImagePart,
  type SummarizationImageMessage,
} from "./latest-image.js";
import {
  runSummarizationPipeline,
  type SummarizationEnrichments,
  type SummarizationPipelineOptions,
} from "./pipeline.js";
import { prepareMessagesForCompaction } from "./prepare-messages.js";
import {
  formatOmittedMessagesPreamble,
  MAX_SUMMARIZATION_PROMPT_CHARS,
  truncatePromptFairly,
} from "./prompt-truncation.js";
import { collectAllSkillBlocks } from "./skill-persistence.js";

export type RedactedCoreMessage = ReturnType<typeof toRedactedCoreMessage>;

interface PromptResponseMessage {
  readonly role: string;
  readonly content: string | { readonly type: string; readonly text?: string | undefined }[];
}

interface SummarizationStreamResult {
  readonly fullStream: AsyncIterable<unknown>;
  readonly extendedUsage: Promise<{ readonly inputTokens?: number | undefined; readonly outputTokens?: number | undefined }>;
  readonly usage: Promise<unknown>;
  readonly providerMetadata: Promise<unknown>;
  readonly invocationId: Promise<unknown>;
  readonly response: Promise<{ readonly messages: readonly PromptResponseMessage[] }>;
}

interface SummarizationPromptExecutor {
  stream(
    context: Context,
    request?: unknown,
    tools?: unknown,
    options?: { readonly maxTokens?: number | undefined },
  ): SummarizationStreamResult;
}

export interface SummarizationPromptSession {
  getExecutor(messages: readonly CoreMessageLike[]): SummarizationPromptExecutor;
  getModelId(): string;
}

export interface SummarizationCancellationToken {
  readonly cancelled: boolean;
}

export interface SummarizationHandlerOptions {
  readonly enableReduceInputsRetry?: boolean | undefined;
  readonly enableRetryUncategorizedErrors?: boolean | undefined;
  readonly throwOnRetryExhaustion?: boolean | undefined;
  readonly maxPromptChars?: number | undefined;
  readonly useRelaxedSplitIndexGuard?: boolean | undefined;
  readonly preserveLastUserMessage?: boolean | undefined;
  readonly alwaysRetryOutputTokenLimit?: boolean | undefined;
  readonly preserveLatestImage?: boolean | undefined;
  readonly promptSuffix?: string | undefined;
  readonly metricsModelLabel?: string | undefined;
  readonly enableDeterministicFallback?: boolean | undefined;
  readonly deterministicFallbackWindowRatio?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
}

export interface SummarizationRunOptions extends SummarizationPipelineOptions {
  readonly backgroundSummarizationMode: BackgroundSummarizationMode;
  readonly triggerReason: string;
  readonly contextWindowTokens?: number | undefined;
  readonly enableRetryOutputTokenLimit?: boolean | undefined;
  readonly cancellationToken?: SummarizationCancellationToken | undefined;
}

export interface SummarizationRawResult {
  readonly text: string;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly hadError: boolean;
  readonly errorKind?: string | undefined;
}

interface PartitionedMessages {
  readonly systemMessage: RedactedCoreMessage | undefined;
  readonly userInfoMessage: RedactedCoreMessage | undefined;
  readonly messagesToSummarize: readonly RedactedCoreMessage[];
  readonly preservedTailMessages: readonly RedactedCoreMessage[];
  readonly skillBlocks: readonly string[];
}

const logger = createLogger("summarization-handler");
const MAX_TOOL_CONTENT_PART_CHARS = 100_000;
const MAX_SUMMARIZATION_PROMPT_BYTES = 9 * 1024 * 1024;
const MAX_PROMPT_BYTES = MAX_SUMMARIZATION_PROMPT_BYTES;
const MAX_SUMMARIZATION_RETRIES = 3;
const TRANSIENT_SUMMARIZATION_RETRY_DELAY_MS = 2_000;
const MIN_SUMMARIZATION_PROMPT_CHARS = 50_000;
const INPUT_TOKENS_WARN_THRESHOLD = 900_000;
const OUT_TOKENS_WARN_THRESHOLD = 18_000;
export const SHORTER_OUTPUT_RETRY_PROMPT = `

Additional instruction: Write a shorter summary that focuses on the highest-signal context. Avoid long code snippets and avoid unnecessarily exhaustive detail. Prioritize the most recent user intent, recent implementation work, and unresolved blockers.
IMPORTANT: When listing user messages, you do not need to repeat each message verbatim. Concisely capture user intent.`;
export const SUMMARIZATION_CURSOR_PROVIDER_OPTIONS = {
  cursor: {
    inferenceReason: "agent-summarization",
    featureType: "agenticComposerSummary",
  },
};

async function executeSummarizationStream(
  context: Context,
  promptSession: SummarizationPromptSession,
  summaryPrompt: string,
  maxOutputTokens: number | undefined,
): Promise<{ text: string; inputTokens: number | undefined; outputTokens: number | undefined }> {
  const executor = promptSession.getExecutor([
    { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
    {
      role: "user",
      content: summaryPrompt,
      providerOptions: SUMMARIZATION_CURSOR_PROVIDER_OPTIONS,
    },
  ]);
  const streamOptions = maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {};
  const result = executor.stream(context, undefined, undefined, streamOptions);
  const streamLogFields = { promptLength: summaryPrompt.length, maxOutputTokens };
  result.extendedUsage.catch(error => {
    logger.error(context, "[summarization-handler] Error getting extended usage", error, {
      summarization: streamLogFields,
    });
  });
  result.usage.catch(error => {
    logger.error(context, "[summarization-handler] Error getting usage", error, {
      summarization: streamLogFields,
    });
  });
  result.providerMetadata.catch(error => {
    logger.error(context, "[summarization-handler] Error getting provider metadata", error, {
      summarization: streamLogFields,
    });
  });
  result.invocationId.catch(error => {
    logger.error(context, "[summarization-handler] Error getting invocation id", error, {
      summarization: streamLogFields,
    });
  });
  result.response.catch(error => {
    logger.error(context, "[summarization-handler] Error getting response", error, {
      summarization: streamLogFields,
    });
  });
  for await (const _chunk of result.fullStream) {
    // The stream must be consumed before its response promises settle.
  }
  const response = await result.response;
  const assistantMessages = response.messages.filter(message => message.role === "assistant");
  if (assistantMessages.length > 1) {
    logger.warn(
      context,
      "[summarization-handler] Summarization response contained more than one assistant message; using only the last to avoid duplicated summaries",
      {
        summarization: {
          ...streamLogFields,
          assistantMessageCount: assistantMessages.length,
        },
      },
    );
  }
  const lastAssistantMessage = assistantMessages.at(-1);
  const text = lastAssistantMessage === undefined
    ? ""
    : Array.isArray(lastAssistantMessage.content)
      ? lastAssistantMessage.content.map(content => content.type === "text" ? content.text : "").join("")
      : lastAssistantMessage.content;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  try {
    const extendedUsage = await result.extendedUsage;
    inputTokens = extendedUsage.inputTokens;
    outputTokens = extendedUsage.outputTokens;
  } catch {
    // Usage is optional and has already been logged above.
  }
  if (text.trim().length === 0) throw new Error("Summarization returned empty text");
  return { text, inputTokens, outputTokens };
}

function formatGuardedToolPart(prefix: string, serializedValue: string): string {
  if (serializedValue.length > MAX_TOOL_CONTENT_PART_CHARS) {
    const truncated = serializedValue.slice(0, MAX_TOOL_CONTENT_PART_CHARS);
    return `${prefix} ${truncated}\n[... truncated, ${serializedValue.length} total chars]`;
  }
  return `${prefix} ${serializedValue}`;
}

export function turnMessageToString(
  redactedMessage: RedactedCoreMessage,
  enablePromptSizeGuards: boolean,
): string {
  const message = fromRedactedCoreMessage(
    redactedMessage,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
  );
  const content = message.content;
  if (!Array.isArray(content)) return content as string;
  return content.map(part => {
    if (part.type === "text") return part.text as string;
    if (part.type === "image") return "[Image]";
    if (part.type === "file") return "[File]";
    if (part.type === "reasoning") return `[Thinking] ${part.text as string}`;
    if (part.type === "redacted-reasoning") return "[Thinking]";
    if (part.type === "tool-call") {
      const argsString = JSON.stringify(part.args) ?? "null";
      return enablePromptSizeGuards
        ? formatGuardedToolPart(`[Tool call] ${part.toolName as string}`, argsString)
        : `[Tool call] ${part.toolName as string} ${argsString}`;
    }
    if (part.type === "tool-result") {
      const resultString = JSON.stringify(part.result) ?? "null";
      return enablePromptSizeGuards
        ? formatGuardedToolPart(`[Tool result] ${part.toolName as string}`, resultString)
        : `[Tool result] ${part.toolName as string} ${resultString}`;
    }
    return "";
  }).join("\n\n");
}

interface BuildPromptOptions {
  readonly requestShorterOutput?: boolean | undefined;
  readonly promptSuffix?: string | undefined;
  readonly maxPromptChars?: number | undefined;
}

function buildSummarizationPrompt(
  context: Context,
  messages: readonly RedactedCoreMessage[],
  options?: BuildPromptOptions,
): { prompt: string; didTruncate: boolean } {
  const suffix = `\n<summarization_request>${MORE_PROMPT}${options?.requestShorterOutput ? SHORTER_OUTPUT_RETRY_PROMPT : ""}${options?.promptSuffix ?? ""}</summarization_request>`;
  const serialized = messages.map(message => `${message.role}: ${turnMessageToString(message, true)}`);
  const fullPrompt = serialized.join("\n\n") + suffix;
  let promptBudget = options?.maxPromptChars ?? MAX_SUMMARIZATION_PROMPT_CHARS;
  const fullPromptBytes = Buffer.byteLength(fullPrompt, "utf-8");
  let didByteAdjust = false;
  let oldPromptBudget = -1;
  if (fullPromptBytes > MAX_PROMPT_BYTES) {
    const anticipatedBytesPerChar = fullPromptBytes / fullPrompt.length;
    const currentBytesPerChar = MAX_PROMPT_BYTES / promptBudget;
    if (anticipatedBytesPerChar > currentBytesPerChar * 0.95) {
      const newPromptBudget = Math.floor(MAX_PROMPT_BYTES / anticipatedBytesPerChar * 0.8);
      logger.info(context, "[summarization-handler] Reducing prompt budget due to byte limit", {
        summarization: {
          byteAdjustment: {
            anticipatedBytesPerChar,
            currentBytesPerChar,
            oldPromptBudget: promptBudget,
            newPromptBudget,
          },
        },
      });
      oldPromptBudget = promptBudget;
      promptBudget = newPromptBudget;
      didByteAdjust = true;
    }
  }
  if (fullPrompt.length > promptBudget) {
    logger.info(context, "[summarization-handler] Would truncate summarization prompt", {
      summarization: {
        promptTruncation: {
          totalMessages: messages.length,
          fullPromptLength: fullPrompt.length,
          lastSerializedMessageLength: serialized.at(-1)?.length ?? 0,
          didByteAdjust,
          promptBudget,
        },
      },
    });
  }
  const shouldTruncatePrompt = options?.maxPromptChars !== undefined;
  if (!shouldTruncatePrompt || fullPrompt.length <= promptBudget) {
    return { prompt: fullPrompt, didTruncate: false };
  }
  const roles = messages.map(message => message.role);
  const result = truncatePromptFairly({
    ctx: context,
    serialized,
    roles,
    suffix,
    charBudget: promptBudget,
  });
  if (result === null) {
    logger.warn(context, "[summarization-handler] failed to build summarization prompt", {
      summarization: {
        totalMessages: messages.length,
        originalChars: fullPrompt.length,
        promptBudget,
      },
    });
    throw new CannotTruncatePromptError(
      "Cannot fit any summarization message within prompt char budget",
      { totalMessages: messages.length, originalChars: fullPrompt.length, budgetChars: promptBudget },
    );
  }
  const { resultParts, droppedCount, truncatedCount, fullCount } = result;
  const separator = "\n\n";
  const preamble = droppedCount > 0 ? formatOmittedMessagesPreamble(droppedCount) : "";
  const joinedResult = resultParts.join(separator);
  const finalPrompt = preamble + joinedResult + suffix;
  if (joinedResult.length < 500) {
    logger.warn(context, "[summarization-handler] Suspiciously short joined result length for summarization", {
      summarization: { joinedResultLength: joinedResult.length },
    });
  }
  const finalPromptBytes = Buffer.byteLength(finalPrompt, "utf-8");
  if (finalPromptBytes > MAX_PROMPT_BYTES) {
    logger.warn(context, "[summarization-handler] Final prompt exceeded byte budget", {
      summarization: {
        adjustmentInfo: {
          promptBudget,
          originalPromptBytes: fullPromptBytes,
          originalPromptLength: fullPrompt.length,
          finalPromptLength: finalPrompt.length,
          finalPromptBytes,
          maxPromptBytes: MAX_PROMPT_BYTES,
          didByteAdjust,
          oldPromptBudget,
        },
      },
    });
  }
  logger.info(context, "[summarization-handler] Summarization prompt exceeded char budget; truncated", {
    summarization: {
      promptTruncation: {
        totalMessages: messages.length,
        fullyDroppedMessages: droppedCount,
        truncatedMessages: truncatedCount,
        originalMessagesCount: fullCount,
        originalPromptLength: fullPrompt.length,
        originalPromptBytes: fullPromptBytes,
        originalLastMessageLength: serialized.at(-1)?.length ?? 0,
        finalPromptBytes,
        finalPromptLength: finalPrompt.length,
        promptBudget,
        didByteAdjust,
      },
    },
  });
  return { prompt: finalPrompt, didTruncate: true };
}

function stripNonPrintableCharacters(input: string): string {
  return input.replace(/[^\P{Cc}\n\r\t]/gu, "");
}

function reducePromptBudget(options: {
  readonly current: number;
  readonly attempt: number;
  readonly originalPromptLength?: number | undefined;
}): number {
  const divisor = options.attempt >= 2 ? 3 : 2;
  let next = Math.floor(options.current / divisor);
  if (options.originalPromptLength !== undefined) {
    next = Math.min(next, Math.floor(options.originalPromptLength * 0.75));
  }
  return Math.max(MIN_SUMMARIZATION_PROMPT_CHARS, next);
}

interface RetryExecutionOptions {
  readonly metricsModelLabel?: string | undefined;
  readonly backgroundSummarizationMode: BackgroundSummarizationMode;
  readonly triggerReason: string;
  readonly maxPromptChars?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly promptSuffix?: string | undefined;
  readonly cancellationToken?: SummarizationCancellationToken | undefined;
  readonly isFallbackToMainModel: boolean;
  readonly enableReduceInputsRetry?: boolean | undefined;
  readonly enableRetryUncategorizedErrors?: boolean | undefined;
  readonly enableRetryOutputTokenLimit?: boolean | undefined;
  readonly throwOnRetryExhaustion?: boolean | undefined;
}

async function executeSummarizationWithRetry(
  context: Context,
  promptSession: SummarizationPromptSession,
  messages: readonly RedactedCoreMessage[],
  options: RetryExecutionOptions,
): Promise<SummarizationRawResult> {
  const metricsModel = options.metricsModelLabel ?? promptSession.getModelId();
  const orchestrationLogFields = {
    summarizationMode: options.backgroundSummarizationMode,
    triggerReason: options.triggerReason,
    model: metricsModel,
  };
  let promptBudget = options.maxPromptChars ?? MAX_SUMMARIZATION_PROMPT_CHARS;
  let requestShorterOutput = false;
  let lastErrorKind: string | undefined;
  const errorKinds: string[] = [];
  let attemptsPerformed = 0;
  let lastFailedPromptLength: number | undefined;
  let expectTruncationFromInputReduction = false;

  for (let attempt = 1; attempt <= MAX_SUMMARIZATION_RETRIES; attempt++) {
    if (options.cancellationToken?.cancelled) break;
    attemptsPerformed++;
    try {
      logger.info(context, "[summarization-handler] Attempt started", {
        summarization: {
          ...orchestrationLogFields,
          attempt,
          maxRetries: MAX_SUMMARIZATION_RETRIES,
          promptBudget,
          requestShorterOutput,
        },
      });
      summarizationTryAttempts.increment(context);
      const buildPromptOptions: BuildPromptOptions = {
        requestShorterOutput,
        promptSuffix: options.promptSuffix,
        maxPromptChars: Math.min(promptBudget, MAX_SUMMARIZATION_PROMPT_CHARS),
      };
      let { prompt: summaryPrompt, didTruncate } = buildSummarizationPrompt(
        context,
        messages,
        buildPromptOptions,
      );
      if (expectTruncationFromInputReduction && attempt === MAX_SUMMARIZATION_RETRIES) {
        const originalLength = summaryPrompt.length;
        summaryPrompt = stripNonPrintableCharacters(summaryPrompt);
        const strippedChars = originalLength - summaryPrompt.length;
        if (strippedChars > 0) {
          logger.info(
            context,
            "[summarization-handler] Stripped non-printable characters from prompt on final input-limit retry",
            {
              summarization: {
                attempt,
                originalLength,
                strippedLength: summaryPrompt.length,
                strippedChars,
              },
            },
          );
        }
      }
      if (expectTruncationFromInputReduction && !didTruncate) {
        logger.warn(
          context,
          "[summarization-handler] Expected prompt truncation after input limit reduction but prompt fit within reduced budget",
          { summarization: { attempt, promptBudget, promptLength: summaryPrompt.length, lastFailedPromptLength } },
        );
      }
      expectTruncationFromInputReduction = false;
      lastFailedPromptLength = summaryPrompt.length;
      const result = await executeSummarizationStream(
        context,
        promptSession,
        summaryPrompt,
        options.maxOutputTokens,
      );
      logger.info(context, "[summarization-handler] Attempt succeeded", {
        summarization: {
          ...orchestrationLogFields,
          attempt,
          contentLength: result.text.length,
          fullPromptLength: summaryPrompt.length,
          promptBudget,
          didTruncate,
        },
      });
      summarizationTrySuccess.increment(context);
      summarizationAttempts.increment(context, 1, {
        invocation: options.backgroundSummarizationMode,
        triggerReason: options.triggerReason,
      });
      summarizationSuccess.increment(context, 1, {
        invocation: options.backgroundSummarizationMode,
        triggerReason: options.triggerReason,
      });
      if (options.isFallbackToMainModel) summarizationFallbackAttempts.increment(context);
      return { ...result, hadError: false };
    } catch (error) {
      const enableReduceInputsRetry = options.enableReduceInputsRetry ?? false;
      const enableRetryUncategorizedErrors = options.enableRetryUncategorizedErrors ?? true;
      const enableRetryOutputTokenLimit = options.enableRetryOutputTokenLimit ?? true;
      const retryDirective = getRetryDirective(error, {
        transientRetryDelayMs: TRANSIENT_SUMMARIZATION_RETRY_DELAY_MS,
        enableReduceInputsRetry,
        enableRetryUncategorizedErrors,
        enableRetryOutputTokenLimit,
      });
      if (retryDirective.reduceInputs) {
        logger.info(context, "[summarization-handler] prompt guard did not reduce inputs enough", {
          summarization: {
            attempt,
            promptBudget,
            lastFailedPromptLength,
            summarizationMode: options.backgroundSummarizationMode,
            triggerReason: options.triggerReason,
          },
        });
      }
      lastErrorKind = retryDirective.errorType;
      errorKinds.push(retryDirective.errorType);
      const willRetry = retryDirective.shouldRetry && attempt < MAX_SUMMARIZATION_RETRIES;
      summarizationTryFailures.increment(context, 1, {
        errorKind: retryDirective.errorType,
        invocation: options.backgroundSummarizationMode,
        triggerReason: options.triggerReason,
      });
      logger.error(context, "[summarization-handler] Error summarizing messages", error, {
        summarization: {
          ...orchestrationLogFields,
          attempt,
          maxRetries: MAX_SUMMARIZATION_RETRIES,
          errorType: retryDirective.errorType,
          willRetry,
          retryDelayMs: retryDirective.retryDelayMs,
          requestShorterOutput: retryDirective.requestShorterOutput,
          reduceInputs: retryDirective.reduceInputs,
          options: {
            enableReduceInputsRetry,
            enableRetryUncategorizedErrors,
            enableRetryOutputTokenLimit,
          },
        },
      });
      if (!willRetry) break;
      summarizationRetries.increment(context, 1, { errorKind: retryDirective.errorType });
      if (retryDirective.requestShorterOutput) {
        requestShorterOutput = true;
        logger.info(context, "[summarization-handler] Retrying with shorter-output instruction", {
          summarization: { ...orchestrationLogFields, attempt },
        });
      }
      if (retryDirective.reduceInputs) {
        const nextPromptBudget = reducePromptBudget({
          current: promptBudget,
          attempt,
          originalPromptLength: lastFailedPromptLength,
        });
        logger.info(context, "[summarization-handler] Retrying with reduced input budget", {
          summarization: {
            ...orchestrationLogFields,
            attempt,
            previousPromptBudget: promptBudget,
            nextPromptBudget,
            lastFailedPromptLength,
          },
        });
        promptBudget = nextPromptBudget;
        expectTruncationFromInputReduction = true;
      }
      if (retryDirective.retryDelayMs > 0) {
        logger.info(context, "[summarization-handler] Retrying after delay", {
          summarization: { ...orchestrationLogFields, attempt, retryDelayMs: retryDirective.retryDelayMs },
        });
        await new Promise(resolve => setTimeout(resolve, retryDirective.retryDelayMs));
        if (options.cancellationToken?.cancelled) break;
      }
    }
  }

  const wasCancelled = options.cancellationToken?.cancelled === true;
  const errorKind = wasCancelled ? "Cancelled" : (lastErrorKind ?? "UnknownError");
  if (wasCancelled) {
    logger.info(context, "[summarization-handler] Summarization retries cancelled", {
      summarization: {
        ...orchestrationLogFields,
        attempts: attemptsPerformed,
        maxRetries: MAX_SUMMARIZATION_RETRIES,
        errorKind,
        errorKinds,
      },
    });
  } else {
    logger.warn(context, "[summarization-handler] All retries exhausted", {
      summarization: {
        ...orchestrationLogFields,
        attempts: attemptsPerformed,
        maxRetries: MAX_SUMMARIZATION_RETRIES,
        errorKind,
        errorKinds,
      },
    });
  }
  summarizationAttempts.increment(context, 1, {
    invocation: options.backgroundSummarizationMode,
    triggerReason: options.triggerReason,
  });
  summarizationFailures.increment(context, 1, {
    errorKind,
    invocation: options.backgroundSummarizationMode,
    triggerReason: options.triggerReason,
  });
  if (options.isFallbackToMainModel) {
    summarizationFallbackAttempts.increment(context);
    summarizationFallbackFailures.increment(context, 1, {
      errorKind,
      invocation: options.backgroundSummarizationMode,
      triggerReason: options.triggerReason,
    });
  }
  if (options.throwOnRetryExhaustion && !wasCancelled) {
    throw new Error(`Summarization failed after ${attemptsPerformed} attempts (${errorKinds.join(", ")})`);
  }
  return {
    text: "No summary generated",
    inputTokens: undefined,
    outputTokens: undefined,
    hadError: true,
    errorKind,
  };
}

const summarizationSuccess = createCounter("agent.summarization.success", {
  description: "Successful summarizations",
  labelNames: ["invocation", "triggerReason"],
});
const summarizationAttempts = createCounter("agent.summarization.attempts", {
  description: "Total summarization attempts",
  labelNames: ["invocation", "triggerReason"],
});
const summarizationFailures = createCounter("agent.summarization.failures", {
  description: "Failed summarizations",
  labelNames: ["errorKind", "invocation", "triggerReason"],
});
const summarizationTryAttempts = createCounter("agent.summarization.try.attempts", {
  description: "Per-try summarization attempts within the retry loop",
});
const summarizationTrySuccess = createCounter("agent.summarization.try.success", {
  description: "Per-try successful summarization attempts",
});
const summarizationTryFailures = createCounter("agent.summarization.try.failures", {
  description: "Per-try failed summarization attempts",
  labelNames: ["errorKind", "invocation", "triggerReason"],
});
const summarizationRetries = createCounter("agent.summarization.retries", {
  description: "Total retries (attempts beyond the first) that actually executed",
  labelNames: ["errorKind"],
});
const summaryLengthChars = createHistogram("agent.summarization.summary_length_chars", {
  description: "Summary length in characters",
});
const summaryBlockingDurationMs = createHistogram("agent.summarization.summary_blocking_duration_ms", {
  description: "Blocking duration of summarization",
});
const summarizationInputTokens = createHistogram("agent.summarization.input_tokens", {
  description: "Input tokens consumed during summarization",
  labelNames: ["model"],
});
const summarizationOutputTokens = createHistogram("agent.summarization.output_tokens", {
  description: "Output tokens generated during summarization",
  labelNames: ["model"],
});
const summarizationCompressionPercent = createHistogram("agent.summarization.compression_percent", {
  description: "Percentage of tokens removed by summarization: (input - output) / input * 100",
  labelNames: ["model"],
});
const summarizationOriginalLengthChars = createHistogram("agent.summarization.original_length_chars", {
  description: "Total character length of all messages before summarization",
  labelNames: ["model"],
});
const summarizationPersistedLengthChars = createHistogram("agent.summarization.persisted_length_chars", {
  description: "Total character length of all messages persisted after summarization (system + userInfo + summary + preserved tail)",
  labelNames: ["model"],
});
const summarizationTotalCompressionPercent = createHistogram("agent.summarization.total_compression_percent", {
  description: "End-to-end compression percentage including preserved tail messages: (1 - persisted/original) * 100",
  labelNames: ["model"],
});
const summarizationDeterministicFallbackUsed = createCounter(
  "agent.summarization.deterministic_fallback.used",
  {
    description: "WaitForCompletion summarizations that fell back to deterministic compaction after LLM retries exhausted",
    labelNames: ["errorKind", "triggerReason", "model"],
  },
);
const summarizationFallbackAttempts = createCounter("agent.summarization.fallback_attempts", {
  description: "Summarization attempts where all summarization models are blocked and the main model is used as fallback",
});
const summarizationFallbackFailures = createCounter("agent.summarization.fallback_failures", {
  description: "Failed summarizations where all summarization models are blocked and the main model is used as fallback",
  labelNames: ["errorKind", "invocation", "triggerReason"],
});
const timeBetweenLastTwoMessagesMs = createHistogram("agent.summarization.time_between_last_two_messages_ms", {
  description: "Time between last two messages in conversation",
});

const DEBUG_SUMMARIZATION_STRATEGY_FILE = path.join(os.homedir(), "debug-summarization-strategy.txt");

function hasToolInvocation(message: CoreMessageLike): boolean {
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some(part => part.type === "tool-call");
}

function isToolResult(message: CoreMessageLike): boolean {
  if (message.role !== "tool") return false;
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some(part => part.type === "tool-result");
}

export function shouldForceSummarizationForTesting(
  messages: readonly CoreMessageLike[],
  evalCompletionMode: string | undefined,
): BackgroundSummarizationMode | undefined {
  if (process.env.NODE_ENV === "production" && process.env.IS_EVALS_SERVICE !== "true") return undefined;
  if (messages.length === 0) return undefined;
  const lastMessage = messages[messages.length - 1]!;
  const lastMessageIsUser = lastMessage.role === "user";
  const lastMessageIsToolResult = isToolResult(lastMessage);
  const numToolCalls = messages.filter(hasToolInvocation).length;
  if (evalCompletionMode === "next-human") {
    return lastMessageIsUser ? BackgroundSummarizationMode.WaitForCompletion : undefined;
  }
  if (evalCompletionMode === "in-flight") {
    return BackgroundSummarizationMode.WaitForCompletionIfStarted;
  }
  try {
    const strategy = fs.readFileSync(DEBUG_SUMMARIZATION_STRATEGY_FILE, "utf8").trim();
    if (strategy.startsWith("every-human")) {
      const numHumanMessages = messages.filter(message => message.role === "user").length;
      const numHumanMessagesLimit = Number.parseInt(
        strategy.includes(":") ? (strategy.split(":")[1] ?? "1") : "1",
        10,
      );
      return Number.isFinite(numHumanMessagesLimit) &&
        numHumanMessagesLimit > 0 &&
        lastMessageIsUser &&
        numHumanMessages % numHumanMessagesLimit === 0
        ? BackgroundSummarizationMode.WaitForCompletion
        : undefined;
    }
    if (strategy === "next-human") {
      if (lastMessageIsUser) fs.rmSync(DEBUG_SUMMARIZATION_STRATEGY_FILE);
      return lastMessageIsUser ? BackgroundSummarizationMode.WaitForCompletion : undefined;
    }
    if (strategy === "next-tool") {
      if (lastMessageIsToolResult) fs.rmSync(DEBUG_SUMMARIZATION_STRATEGY_FILE);
      return lastMessageIsToolResult ? BackgroundSummarizationMode.WaitForCompletion : undefined;
    }
    if (strategy.startsWith("every-tool")) {
      const numToolCallsLimit = Number.parseInt(
        strategy.includes(":") ? (strategy.split(":")[1] ?? "1") : "1",
        10,
      );
      return Number.isFinite(numToolCallsLimit) &&
        numToolCallsLimit > 0 &&
        lastMessageIsToolResult &&
        numToolCalls % numToolCallsLimit === 0
        ? BackgroundSummarizationMode.WaitForCompletion
        : undefined;
    }
  } catch {
    // Debug forcing is deliberately best-effort.
  }
  return undefined;
}

const SUMMARIZATION_SYSTEM_PROMPT = "You are an intelligent assistant, tasked with summarizing the following conversation. You MUST follow the instructions given in the <summarization_request> tags and summarize the conversation. This summary will be provided to another AI assistant to continue the task at hand, so you should align the summary with the task in the conversation.";
const PREVIOUS_CONVERSATION_SUMMARY_PREFIX = "[Previous conversation summary]:";
const SUMMARY_PRESERVED_IMAGE_NOTE = "[Latest screenshot]: The image below is the most recent screenshot from the summarized conversation, captured before the summary above was created. Use it to continue from the last known visual state; take a fresh screenshot if you need to confirm the current state.";
const MORE_PROMPT = `What you see above is the conversation so far, rendered as a transcript. Previous user messages, previous assistant messages, and tool calls are shown in tags, while the original system prompt has been removed. The content in the tags has been rendered exactly as it was in the original conversation.

Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions. This summary will be provided to another AI assistant to continue the task at hand, so you should align the summary with the task in the conversation above. So you should NEVER refer to summarization in your summary, just an output that could be used to continue the task.

This summary should be thorough in capturing technical details, code patterns, and architectural decisions
that would be essential for continuing development work without losing context.

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
   - file names
   - full code snippets
   - function signatures
   - file edits
- Errors that you ran into and how you fixed them
- Pay special attention to specific user feedback that you received, especially if the user told you to do
something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results or subagent prompts/results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed.

If there is a next step, include direct quotes from the most recent conversation
showing exactly what task you were working on and where you left off. This should be verbatim to ensure
there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
Summary:
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
   - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
   - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
   - [Detailed non tool use, non subagent user message]
   - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

export class SummarizationHandler {
  declare readonly promptSession: SummarizationPromptSession;
  declare readonly isFallbackToMainModel: boolean;
  declare readonly enableReduceInputsRetry: boolean;
  declare readonly enableRetryUncategorizedErrors: boolean;
  declare readonly throwOnRetryExhaustion: boolean;
  declare readonly maxPromptChars: number | undefined;
  declare readonly useRelaxedSplitIndexGuard: boolean;
  declare readonly preserveLastUserMessage: boolean;
  declare readonly alwaysRetryOutputTokenLimit: boolean;
  declare readonly preserveLatestImage: boolean;
  declare readonly promptSuffix: string | undefined;
  declare readonly metricsModelLabel: string | undefined;
  declare readonly enableDeterministicFallback: boolean;
  declare readonly deterministicFallbackWindowRatio: number;
  declare readonly maxOutputTokens: number | undefined;

  constructor(
    promptSession: SummarizationPromptSession,
    isFallbackToMainModel = false,
    options?: SummarizationHandlerOptions,
  ) {
    this.promptSession = promptSession;
    this.isFallbackToMainModel = isFallbackToMainModel;
    this.enableReduceInputsRetry = options?.enableReduceInputsRetry ?? false;
    this.enableRetryUncategorizedErrors = options?.enableRetryUncategorizedErrors ?? true;
    this.throwOnRetryExhaustion = options?.throwOnRetryExhaustion ?? false;
    this.maxPromptChars = options?.maxPromptChars;
    this.useRelaxedSplitIndexGuard = options?.useRelaxedSplitIndexGuard ?? false;
    this.preserveLastUserMessage = options?.preserveLastUserMessage ?? true;
    this.alwaysRetryOutputTokenLimit = options?.alwaysRetryOutputTokenLimit ?? true;
    this.preserveLatestImage = options?.preserveLatestImage ?? false;
    this.promptSuffix = options?.promptSuffix;
    this.metricsModelLabel = options?.metricsModelLabel;
    this.enableDeterministicFallback = options?.enableDeterministicFallback ?? false;
    this.deterministicFallbackWindowRatio = options?.deterministicFallbackWindowRatio ??
      DEFAULT_DETERMINISTIC_FALLBACK_WINDOW_RATIO;
    this.maxOutputTokens = this.isFallbackToMainModel ? undefined : options?.maxOutputTokens;
  }

  getModelId(): string {
    return this.promptSession.getModelId();
  }

  getMetricsModelLabel(): string {
    return this.metricsModelLabel ?? this.promptSession.getModelId();
  }

  partitionMessages(
    messages: readonly RedactedCoreMessage[],
    options: SummarizationRunOptions,
  ): PartitionedMessages {
    const { systemMessage, userInfoMessage, messagesForSummarization } =
      prepareMessagesForCompaction(messages);
    let splitIndex = -1;
    for (let index = messagesForSummarization.length - 1; index >= 0; index--) {
      if (messagesForSummarization[index]!.role === "user") {
        splitIndex = index;
        break;
      }
    }
    const splitGuardThreshold = this.useRelaxedSplitIndexGuard ? 0 : 1;
    if (splitIndex <= splitGuardThreshold || options.fullSummarization) {
      splitIndex = messagesForSummarization.length;
    }
    const preserveLastUser = this.preserveLastUserMessage && options.fullSummarization !== true;
    const summarizeEnd = preserveLastUser ? splitIndex + 1 : splitIndex;
    const messagesToSummarize = messagesForSummarization.slice(0, summarizeEnd);
    let preservedTailMessages = messagesForSummarization.slice(splitIndex);
    if (preserveLastUser && preservedTailMessages.length === 0 && messagesToSummarize.length > 0) {
      let lastUserIndex = -1;
      for (let index = messagesToSummarize.length - 1; index >= 0; index--) {
        const message = messagesToSummarize[index]!;
        const cursor = (message.providerOptions as { cursor?: { isSummary?: unknown } } | undefined)?.cursor;
        if (message.role === "user" && cursor?.isSummary !== true) {
          lastUserIndex = index;
          break;
        }
      }
      if (lastUserIndex !== -1 && lastUserIndex !== messagesToSummarize.length - 1) {
        preservedTailMessages = [messagesToSummarize[lastUserIndex]!];
      }
    }
    const skillBlocks = collectAllSkillBlocks(messagesForSummarization);
    return {
      systemMessage,
      userInfoMessage,
      messagesToSummarize,
      preservedTailMessages,
      skillBlocks,
    };
  }

  async generateSummary(
    context: Context,
    partitioned: PartitionedMessages,
    options: SummarizationRunOptions,
  ): Promise<SummarizationRawResult> {
    const result = await executeSummarizationWithRetry(
      context,
      this.promptSession,
      partitioned.messagesToSummarize,
      {
        isFallbackToMainModel: this.isFallbackToMainModel,
        enableReduceInputsRetry: this.enableReduceInputsRetry,
        enableRetryUncategorizedErrors: this.enableRetryUncategorizedErrors,
        enableRetryOutputTokenLimit: options.enableRetryOutputTokenLimit ?? this.alwaysRetryOutputTokenLimit,
        throwOnRetryExhaustion: this.throwOnRetryExhaustion,
        maxPromptChars: this.maxPromptChars,
        backgroundSummarizationMode: options.backgroundSummarizationMode,
        triggerReason: options.triggerReason,
        maxOutputTokens: this.maxOutputTokens,
        cancellationToken: options.cancellationToken,
        promptSuffix: this.promptSuffix,
        metricsModelLabel: this.metricsModelLabel,
      },
    );
    if (this.shouldUseDeterministicFallback(result) && partitioned.messagesToSummarize.length > 0) {
      const fallbackText = this.buildDeterministicFallbackText(
        context,
        partitioned,
        options,
        result.errorKind,
      );
      if (fallbackText !== null) return { ...result, text: fallbackText };
    }
    return result;
  }

  shouldUseDeterministicFallback(result: SummarizationRawResult): boolean {
    if (!this.enableDeterministicFallback || !result.hadError) return false;
    const errorKind = result.errorKind;
    if (errorKind === "Cancelled") return false;
    if (errorKind?.toLowerCase().includes("abort")) return false;
    return true;
  }

  buildDeterministicFallbackText(
    context: Context,
    partitioned: PartitionedMessages,
    options: SummarizationRunOptions,
    errorKind: string | undefined,
  ): string | null {
    const metricsModel = this.getMetricsModelLabel();
    const maxChars = computeDeterministicFallbackMaxChars(
      options.contextWindowTokens,
      this.deterministicFallbackWindowRatio,
    );
    const built = buildDeterministicSummaryText(context, partitioned.messagesToSummarize, { maxChars });
    if (built === null) {
      logger.warn(
        context,
        "[summarization-handler] Deterministic fallback could not fit within budget; falling through to placeholder",
        {
          summarization: {
            model: metricsModel,
            triggerReason: options.triggerReason,
            backgroundSummarizationMode: options.backgroundSummarizationMode,
            errorKind: errorKind ?? "unknown",
            contextWindowTokens: options.contextWindowTokens,
            windowRatio: this.deterministicFallbackWindowRatio,
            maxChars,
            totalMessages: partitioned.messagesToSummarize.length,
          },
        },
      );
      return null;
    }
    summarizationDeterministicFallbackUsed.increment(context, 1, {
      errorKind: errorKind ?? "unknown",
      triggerReason: options.triggerReason,
      model: metricsModel,
    });
    logger.info(context, "[summarization-handler] Deterministic fallback produced summary", {
      summarization: {
        model: metricsModel,
        triggerReason: options.triggerReason,
        backgroundSummarizationMode: options.backgroundSummarizationMode,
        errorKind: errorKind ?? "unknown",
        contextWindowTokens: options.contextWindowTokens,
        windowRatio: this.deterministicFallbackWindowRatio,
        maxChars,
        fallbackTextLength: built.text.length,
        fullyPreservedMessageCount: built.fullyPreservedMessageCount,
        truncatedCount: built.truncatedCount,
        droppedCount: built.droppedCount,
        totalMessages: partitioned.messagesToSummarize.length,
      },
    });
    return built.text;
  }

  buildSummaryMessage(
    rawSummary: SummarizationRawResult,
    partitioned: PartitionedMessages,
    enrichments: SummarizationEnrichments,
  ): { message: RedactedCoreMessage; summaryTextLength: number } {
    const durableBlocks = renderDurableBlocks(
      "external",
      enrichments as DurableBlockEnrichments,
    );
    const summary = rawSummary.text + appendDurableBlocks("external", durableBlocks);
    const carrierContent = `${PREVIOUS_CONVERSATION_SUMMARY_PREFIX} ${summary}`;
    const privacyMode = partitioned.systemMessage?._privacyMode ??
      partitioned.messagesToSummarize[0]?._privacyMode ??
      PrivacyMode.UNSPECIFIED;
    const preservedImage = this.preserveLatestImage &&
      findLatestImagePart(partitioned.preservedTailMessages as readonly SummarizationImageMessage[]) === null
      ? findLatestImagePart(partitioned.messagesToSummarize as readonly SummarizationImageMessage[])
      : null;
    const carrierMessage: CoreMessageLike = preservedImage === null
      ? {
          role: "user",
          content: carrierContent,
          providerOptions: { cursor: { isSummary: true } },
        }
      : {
          role: "user",
          content: [
            { type: "text", text: carrierContent },
            { type: "text", text: SUMMARY_PRESERVED_IMAGE_NOTE },
            toUserMessageImagePart(preservedImage),
          ],
          providerOptions: { cursor: { isSummary: true } },
        };
    return {
      message: toRedactedCoreMessage(carrierMessage, privacyMode),
      summaryTextLength: carrierContent.length,
    };
  }

  assembleFinalMessages(
    partitioned: PartitionedMessages,
    summaryMessage: RedactedCoreMessage,
  ): readonly RedactedCoreMessage[] {
    return [
      ...(partitioned.systemMessage ? [partitioned.systemMessage] : []),
      ...(partitioned.userInfoMessage ? [partitioned.userInfoMessage] : []),
      summaryMessage,
      ...partitioned.preservedTailMessages,
    ];
  }

  async summarize(
    context: Context,
    messages: readonly RedactedCoreMessage[],
    options: SummarizationRunOptions,
  ): Promise<{
    messagesActuallySummarized: readonly RedactedCoreMessage[];
    newSummaryMessage: RedactedCoreMessage;
    preservedOriginalTailMessages: readonly RedactedCoreMessage[];
    fullReplacementMessages: readonly RedactedCoreMessage[];
    rawSummary: SummarizationRawResult;
    summaryTextLength: number;
    summary: { summary: RedactedString };
    hadError: boolean;
    errorKind: string | undefined;
  }> {
    if (!messages.find(message => message.role === "system")) {
      logger.warn(context, "Compaction input has no system message", {
        summarization: { messagesCount: messages.length },
      });
    }
    const { userInfoMessage } = prepareMessagesForCompaction(messages);
    if (!userInfoMessage) {
      logger.warn(context, "Compaction input has no userInfo message", {
        summarization: { messagesCount: messages.length },
      });
    }
    const summarizationLogFields = {
      summarizationMode: options.backgroundSummarizationMode,
      triggerReason: options.triggerReason,
      model: this.getMetricsModelLabel(),
    };
    const startTime = performance.now();
    let timeBetweenMessages: number | undefined;
    if (messages.length >= 2) {
      const lastMessage = messages[messages.length - 1]!;
      const secondLastMessage = messages[messages.length - 2]!;
      if ("timestamp" in lastMessage && "timestamp" in secondLastMessage) {
        const lastTime = lastMessage.timestamp;
        const secondLastTime = secondLastMessage.timestamp;
        if (typeof lastTime === "number" && typeof secondLastTime === "number") {
          timeBetweenMessages = lastTime - secondLastTime;
        }
      }
    }
    try {
      const pipelineResult = await runSummarizationPipeline(this, context, messages, options);
      const { rawSummary, summaryTextLength } = pipelineResult;
      const durationMs = performance.now() - startTime;
      this.recordMetrics(context, {
        rawSummary,
        durationMs,
        timeBetweenMessages,
        originalMessages: messages,
        fullReplacementMessages: pipelineResult.fullReplacementMessages,
        summaryTextLength,
      });
      const content = pipelineResult.newSummaryMessage.content;
      let carrierText: RedactedString | undefined;
      if (isRedactedString(content)) {
        carrierText = content;
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "text" && isRedactedString(part.text)) {
            carrierText = part.text;
            break;
          }
        }
      }
      const summaryPrefix = `${PREVIOUS_CONVERSATION_SUMMARY_PREFIX} `;
      const summary = carrierText !== undefined
        ? carrierText.safeTransform(summaryText =>
            summaryText.startsWith(summaryPrefix)
              ? summaryText.slice(summaryPrefix.length)
              : summaryText)
        : createRedactedString(
            pipelineResult.rawSummary.text,
            DataClassification.CODE,
            "summary",
            messages[0]?._privacyMode ?? PrivacyMode.UNSPECIFIED,
          );
      const hadError = pipelineResult.rawSummary.hadError === true;
      logger.info(context, "[summarization-handler] Summarization completed", {
        summarization: {
          ...summarizationLogFields,
          durationMs,
          hadError,
          errorKind: pipelineResult.rawSummary.errorKind,
        },
      });
      return {
        ...pipelineResult,
        summary: { summary },
        hadError,
        errorKind: pipelineResult.rawSummary.errorKind,
      };
    } catch (error) {
      const durationMs = performance.now() - startTime;
      summaryBlockingDurationMs.histogram(context, durationMs);
      if (timeBetweenMessages !== undefined) {
        timeBetweenLastTwoMessagesMs.histogram(context, timeBetweenMessages);
      }
      logger.error(context, "[summarization-handler] Summarize pipeline failed", error, {
        summarization: summarizationLogFields,
      });
      throw error;
    }
  }

  recordMetrics(
    context: Context,
    params: {
      readonly rawSummary: SummarizationRawResult;
      readonly durationMs: number;
      readonly timeBetweenMessages: number | undefined;
      readonly originalMessages: readonly RedactedCoreMessage[];
      readonly fullReplacementMessages: readonly RedactedCoreMessage[];
      readonly summaryTextLength: number;
    },
  ): void {
    const { rawSummary, durationMs, timeBetweenMessages } = params;
    summaryBlockingDurationMs.histogram(context, durationMs);
    summaryLengthChars.histogram(context, params.summaryTextLength);
    const model = this.getMetricsModelLabel();
    if (rawSummary.inputTokens !== undefined) {
      summarizationInputTokens.histogram(context, rawSummary.inputTokens, { model });
      if (rawSummary.inputTokens > INPUT_TOKENS_WARN_THRESHOLD) {
        logger.warn(context, "[summarization-handler] Summarization input tokens are very high", {
          summarization: {
            inputTokens: rawSummary.inputTokens,
            outputTokens: rawSummary.outputTokens,
            durationMs,
            model,
          },
        });
      }
    }
    if (rawSummary.outputTokens !== undefined) {
      summarizationOutputTokens.histogram(context, rawSummary.outputTokens, { model });
      if (rawSummary.outputTokens > OUT_TOKENS_WARN_THRESHOLD) {
        logger.warn(context, "[summarization-handler] Summarization output tokens are very high", {
          summarization: {
            inputTokens: rawSummary.inputTokens,
            outputTokens: rawSummary.outputTokens,
            durationMs,
            model,
          },
        });
      }
    }
    if (
      rawSummary.inputTokens !== undefined &&
      rawSummary.outputTokens !== undefined &&
      rawSummary.inputTokens > 0
    ) {
      const percentRemoved = (rawSummary.inputTokens - rawSummary.outputTokens) /
        rawSummary.inputTokens * 100;
      summarizationCompressionPercent.histogram(context, percentRemoved, { model });
    }
    if (timeBetweenMessages !== undefined) {
      timeBetweenLastTwoMessagesMs.histogram(context, timeBetweenMessages);
    }
    const originalLengthChars = this.totalRawSerializedCharLength(params.originalMessages);
    const persistedLengthChars = this.totalRawSerializedCharLength(params.fullReplacementMessages);
    summarizationOriginalLengthChars.histogram(context, originalLengthChars, { model });
    summarizationPersistedLengthChars.histogram(context, persistedLengthChars, { model });
    if (originalLengthChars > 0) {
      const compressionPercent = (originalLengthChars - persistedLengthChars) /
        originalLengthChars * 100;
      summarizationTotalCompressionPercent.histogram(context, compressionPercent, { model });
    }
  }

  totalRawSerializedCharLength(messages: readonly RedactedCoreMessage[]): number {
    let total = 0;
    for (const message of messages) total += turnMessageToString(message, false).length;
    return total;
  }

  static isTokenLimitError(error: unknown): boolean {
    return error instanceof InputTokenLimitError;
  }
}
