import { createLogger, createSpan, type Context } from "../../context/index.js";
import { Updates } from "../../agent-core/interaction-updates.js";
import { createCounter } from "../../metrics/index.js";
import { PrivacyMode } from "../../proto/generated/aiserver/v1/privacy_mode_pb.js";
import { PrivacyCapability } from "../../redaction/classification.js";
import { fromRedactedCoreMessages, toRedactedCoreMessages } from "../../redaction/core-message.js";
import { promptSuggestionUserMessage, PROMPT_SUGGESTION_MAX_WORDS } from "../prompts/prompt-suggestion.js";
import { estimateStringTokenCount } from "../utils/token-estimate.js";
import { isCursorBigModel } from "../../utils/model-utils.js";

const logger = createLogger("prompt-suggestion");
const SILENCE_TAG_REGEX = /<{1,2}\/?\s*silence\s*\/?>/i;
const promptSuggestionOutcome = createCounter("agent.prompt_suggestion.outcome", {
  description: "Prompt suggestion outcome by model",
  labelNames: ["model", "outcome"],
});

type RedactedMessage = ReturnType<typeof toRedactedCoreMessages>[number];

interface PromptSuggestionStreamResult {
  readonly response: Promise<unknown>;
  readonly fullStream: AsyncIterable<{ readonly type: string; readonly textDelta?: string | undefined }>;
  readonly extendedUsage: Promise<{ readonly inputTokens: number; readonly cacheReadTokens: number }>;
}

interface PromptSuggestionExecutor {
  getMessages(): readonly RedactedMessage[];
  clearMessages(): void;
  appendMessages(messages: readonly RedactedMessage[]): void;
  stream(ctx: Context, invocationId: string, tools: readonly unknown[], options: { readonly maxTokens: number }): PromptSuggestionStreamResult;
}

interface PromptSuggestionInteractionListener {
  sendUpdate(ctx: Context, update: ReturnType<typeof Updates.promptSuggestion>): Promise<void> | void;
}

interface PromptSuggestionPriceOptions {
  readonly maxInputTokenCost?: number | undefined;
  readonly getModelInputCostForContext?: ((model: string, estimatedTokens: number) => number) | undefined;
}

function countConversationHistoryTokens(messages: readonly { readonly role: string; readonly content: unknown }[]) {
  let conversationHistoryTokens = 0;
  const nonSystemMessages = messages.filter(message => message.role !== "system");
  const conversationHistoryMessageCount = nonSystemMessages.length;
  for (const message of nonSystemMessages) {
    if (typeof message.content === "string") {
      conversationHistoryTokens += estimateStringTokenCount(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === "string") {
          conversationHistoryTokens += estimateStringTokenCount(part);
        } else if (typeof part === "object" && part !== null) {
          if ("text" in part && typeof part.text === "string") {
            conversationHistoryTokens += estimateStringTokenCount(part.text);
          }
          if ("toolName" in part && typeof part.toolName === "string") {
            conversationHistoryTokens += estimateStringTokenCount(part.toolName);
          }
          if ("args" in part && part.args !== undefined) {
            conversationHistoryTokens += estimateStringTokenCount(JSON.stringify(part.args)!);
          }
          if ("result" in part && part.result !== undefined) {
            conversationHistoryTokens += estimateStringTokenCount(JSON.stringify(part.result)!);
          }
        }
      }
    }
  }
  return { conversationHistoryTokens, conversationHistoryMessageCount };
}

function countWords(text: string): number {
  const words = text.trim().split(/\s+/);
  return words.length > 0 && words[0] !== "" ? words.length : 0;
}

function extractSuggestionWithReason(
  response: string,
  maxWords = PROMPT_SUGGESTION_MAX_WORDS,
):
  | { readonly type: "empty" }
  | { readonly type: "bad_output"; readonly suggestion: string; readonly reason: "human_prefix" | "thinking_tags" }
  | { readonly type: "too_long"; readonly suggestion: string; readonly wordCount: number }
  | { readonly type: "success"; readonly suggestion: string } {
  const trimmed = response.trim();
  if (trimmed.length === 0) {
    return { type: "empty" };
  }
  if (SILENCE_TAG_REGEX.test(trimmed)) {
    return { type: "empty" };
  }
  const firstLine = trimmed.split(/\r?\n/)[0]!.trim();
  const unquoted = firstLine.replace(/^"(.*)"$/, "$1").trim();
  if (unquoted.length === 0) {
    return { type: "empty" };
  }
  if (unquoted.startsWith("Human:")) {
    return {
      type: "bad_output",
      suggestion: unquoted,
      reason: "human_prefix",
    };
  }
  if (/<\/?think>/.test(unquoted)) {
    return {
      type: "bad_output",
      suggestion: unquoted,
      reason: "thinking_tags",
    };
  }
  const wordCount = countWords(unquoted);
  if (wordCount > maxWords) {
    return { type: "too_long", suggestion: unquoted, wordCount };
  }
  return { type: "success", suggestion: unquoted };
}

export async function requestPromptSuggestion(
  parentCtx: Context,
  invocationId: string,
  model: string,
  executor: PromptSuggestionExecutor,
  interactionListener: PromptSuggestionInteractionListener,
  tools: readonly unknown[],
  messagesSnapshot: readonly RedactedMessage[] | undefined,
  priceOptions: PromptSuggestionPriceOptions | undefined,
): Promise<void> {
  using spanCtxt = createSpan(parentCtx.withName("requestPromptSuggestion"));
  const ctx = spanCtxt.ctx;
  const currentMessages = messagesSnapshot ?? executor.getMessages();
  const maxCost = priceOptions?.maxInputTokenCost;
  const costFn = priceOptions?.getModelInputCostForContext;
  try {
    if (maxCost && maxCost > 0 && costFn) {
      const unwrappedMessages = fromRedactedCoreMessages(currentMessages, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
      const { conversationHistoryTokens: rawEstimatedTokens } = countConversationHistoryTokens(unwrappedMessages);
      const SYSTEM_PROMPT_OVERHEAD_TOKENS = 2e4;
      const estimatedTokens = rawEstimatedTokens + SYSTEM_PROMPT_OVERHEAD_TOKENS;
      const inputCost = costFn(model, estimatedTokens);
      if (inputCost > maxCost) {
        logger.info(ctx, "Prompt suggestion skipped: model too expensive", { model, rawEstimatedTokens, estimatedTokens, inputCost, maxCost });
        promptSuggestionOutcome.increment(ctx, 1, { model, outcome: "skipped_expensive" });
        return;
      }
    }
    if (messagesSnapshot) {
      executor.clearMessages();
      executor.appendMessages(messagesSnapshot);
    }
    const isDsv3 = isCursorBigModel(model);
    const userMessage = {
      role: "user",
      content: promptSuggestionUserMessage(isDsv3),
      providerOptions: {
        cursor: {
          inferenceReason: "prompt-suggestion",
          featureType: "promptSuggestion",
        },
      },
    };
    executor.appendMessages(toRedactedCoreMessages([userMessage], PrivacyMode.UNSPECIFIED));
    try {
      const maxTokens = isDsv3 ? 128 : 64;
      const streamResult = executor.stream(ctx, invocationId, tools, { maxTokens });
      const settledResponse = streamResult.response.then(() => ({ didReject: false as const }), error => ({ didReject: true as const, error }));
      let responseText = "";
      for await (const chunk of streamResult.fullStream) {
        if (chunk.type === "text-delta") {
          responseText += chunk.textDelta ?? "";
        }
      }
      const responseResult = await settledResponse;
      if (responseResult.didReject) {
        throw responseResult.error;
      }
      const extendedUsage = await streamResult.extendedUsage;
      const cacheHitRatio = extendedUsage.inputTokens > 0 ? (extendedUsage.cacheReadTokens / extendedUsage.inputTokens).toFixed(2) : "N/A";
      logger.info(ctx, "Prompt suggestion completed", { inputTokens: extendedUsage.inputTokens, cacheReadTokens: extendedUsage.cacheReadTokens, cacheHitRatio });
      const extractionResult = extractSuggestionWithReason(responseText);
      switch (extractionResult.type) {
        case "success":
          promptSuggestionOutcome.increment(ctx, 1, { model, outcome: "suggested" });
          await interactionListener.sendUpdate(ctx, Updates.promptSuggestion(extractionResult.suggestion));
          break;
        case "too_long":
          logger.info(ctx, "Prompt suggestion discarded: too long", { wordCount: extractionResult.wordCount, maxWords: PROMPT_SUGGESTION_MAX_WORDS, suggestion: extractionResult.suggestion });
          promptSuggestionOutcome.increment(ctx, 1, { model, outcome: "too_long" });
          break;
        case "bad_output":
          logger.info(ctx, "Prompt suggestion discarded: bad output", { reason: extractionResult.reason, suggestion: extractionResult.suggestion });
          promptSuggestionOutcome.increment(ctx, 1, { model, outcome: "bad_output" });
          break;
        case "empty":
          promptSuggestionOutcome.increment(ctx, 1, { model, outcome: "no_suggestion" });
          break;
      }
    } catch (error) {
      promptSuggestionOutcome.increment(ctx, 1, { model, outcome: "error" });
      logger.error(ctx, "Error during prompt suggestion request", error);
    } finally {
      executor.clearMessages();
      executor.appendMessages(currentMessages);
    }
  } catch {}
}
