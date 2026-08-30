import {
  appendDurableBlocks,
  prependDurableBlocks,
  renderDurableBlocks,
  type DurableBlockEnrichments,
} from "../../agent-summarization/durable-blocks.js";
import { getRetryDirective } from "../../agent-summarization/error-handling.js";
import {
  runSummarizationPipeline,
  type SummarizationEnrichments,
  type SummarizationPipelineOptions,
} from "../../agent-summarization/pipeline.js";
import { prepareMessagesForCompaction } from "../../agent-summarization/prepare-messages.js";
import { collectAllSkillBlocks } from "../../agent-summarization/skill-persistence.js";
import { SUMMARIZATION_CURSOR_PROVIDER_OPTIONS } from "../../agent-summarization/summarization-handler.js";
import type { Context } from "../../context/core.js";
import { createLogger, createSpan } from "../../context/index.js";
import { createCounter, createHistogram } from "../../metrics/index.js";
import { DataClassification, PrivacyCapability } from "../../redaction/classification.js";
import { fromRedactedCoreMessage, toRedactedCoreMessage } from "../../redaction/core-message.js";
import { createRedactedString, safeString } from "../../redaction/factory.js";
import { ANTHROPIC_COMPACTION_INSTRUCTIONS } from "./constants.js";
import {
  executeSelfSummaryWithRetry,
  type SelfSummaryPromptSession,
  type SelfSummaryRetryOptions,
  type SelfSummaryStateHandler,
  type SelfSummaryTool,
} from "./self-summary-handler.js";
import { extractTextContent } from "./token-estimate.js";

type RedactedCoreMessage = Parameters<typeof fromRedactedCoreMessage>[0];
type RedactedInteractionListener = Parameters<typeof executeSelfSummaryWithRetry>[3];

interface AnthropicPartition {
  readonly systemMessage: RedactedCoreMessage | undefined;
  readonly userInfoMessage: RedactedCoreMessage | undefined;
  readonly messagesToSummarize: readonly RedactedCoreMessage[];
  readonly preservedTailMessages: readonly RedactedCoreMessage[];
  readonly skillBlocks: readonly string[];
}

interface AnthropicRawSummary {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AnthropicCompactionOptions extends SelfSummaryRetryOptions {
  readonly explicit?: boolean | undefined;
  readonly anthropicCompactionInstructions?: string | undefined;
}

const logger = createLogger("@anysphere/agent");
const MIN_ANTHROPIC_COMPACTION_INPUT_TOKENS = 50_000;
const APPROX_CHARS_PER_TOKEN = 4;
const compactionInputTokens = createHistogram("anthropic_compaction.input_token", {
  description: "Input tokens consumed during Anthropic compaction",
  labelNames: ["mode"],
});
const compactionOutputTokens = createHistogram("anthropic_compaction.output_token", {
  description: "Output tokens generated during Anthropic compaction",
  labelNames: ["mode"],
});
const compactionCacheReadTokens = createHistogram("anthropic_compaction.cache_read_token", {
  description: "Cache read tokens during Anthropic compaction",
  labelNames: ["mode"],
});
const compactionCacheWriteTokens = createHistogram("anthropic_compaction.cache_write_token", {
  description: "Cache write tokens during Anthropic compaction",
  labelNames: ["mode"],
});
const compactionTimeTakenMs = createHistogram("anthropic_compaction.time_taken_ms", {
  description: "Time taken for Anthropic compaction in milliseconds",
  labelNames: ["mode"],
});
const compactionStatus = createCounter("anthropic_compaction.status", {
  description: "Count of Anthropic compaction attempts and their outcomes",
  labelNames: ["outcome", "errorKind", "mode"],
});

export class AnthropicCompactionHandler {
  declare readonly promptSession: SelfSummaryPromptSession;
  declare readonly stateHandler: SelfSummaryStateHandler;
  declare readonly interactionListener: RedactedInteractionListener;
  declare readonly tools: SelfSummaryTool[];
  declare readonly extraT: unknown;
  declare readonly modelId: string;
  declare readonly compactionMode: "explicit" | "beta";
  declare readonly anthropicCompactionInstructions: string | undefined;
  declare readonly retryOptions: SelfSummaryRetryOptions;

  constructor(
    promptSession: SelfSummaryPromptSession,
    stateHandler: SelfSummaryStateHandler,
    interactionListener: RedactedInteractionListener,
    tools: SelfSummaryTool[],
    extraT: unknown,
    modelId: string,
    options?: AnthropicCompactionOptions,
  ) {
    this.promptSession = promptSession;
    this.stateHandler = stateHandler;
    this.interactionListener = interactionListener;
    this.tools = tools;
    this.extraT = extraT;
    this.modelId = modelId;
    const { explicit, anthropicCompactionInstructions, ...retry } = options ?? {};
    this.compactionMode = explicit === true ? "explicit" : "beta";
    this.anthropicCompactionInstructions = anthropicCompactionInstructions;
    this.retryOptions = retry;
  }

  getModelId(): string { return this.modelId; }
  getMetricsModelLabel(): string { return this.modelId; }

  partitionMessages(messages: readonly RedactedCoreMessage[], _options: SummarizationPipelineOptions): AnthropicPartition {
    const { systemMessage, userInfoMessage, messagesForSummarization } = prepareMessagesForCompaction(messages);
    const skillBlocks = collectAllSkillBlocks(messagesForSummarization);
    return {
      systemMessage,
      userInfoMessage,
      messagesToSummarize: messagesForSummarization,
      preservedTailMessages: [],
      skillBlocks,
    };
  }

  async generateSummary(
    ctx: Context,
    partitioned: AnthropicPartition,
    _options: SummarizationPipelineOptions,
  ): Promise<AnthropicRawSummary> {
    if (this.compactionMode === "beta") {
      assertAnthropicCompactionInputTokens(partitioned.messagesToSummarize);
    }
    if (!partitioned.systemMessage) throw new Error("Expected system message in conversation");
    const privacySource = partitioned.preservedTailMessages[0] ?? partitioned.userInfoMessage ?? partitioned.systemMessage;
    const finalUserContent = this.compactionMode === "explicit"
      ? this.anthropicCompactionInstructions ?? ANTHROPIC_COMPACTION_INSTRUCTIONS
      : "Continue from where you left off.";
    logger.info(
      ctx,
      this.compactionMode === "explicit"
        ? "[anthropic-compaction] generating summary via explicit user prompt"
        : "[anthropic-compaction] generating summary via compact beta",
      { mode: this.compactionMode },
    );
    const compactInputMessages: RedactedCoreMessage[] = [
      partitioned.systemMessage,
      ...(partitioned.userInfoMessage ? [partitioned.userInfoMessage] : []),
      ...partitioned.messagesToSummarize,
      {
        _privacyMode: privacySource._privacyMode,
        role: "user",
        content: safeString(finalUserContent),
        providerOptions: SUMMARIZATION_CURSOR_PROVIDER_OPTIONS,
      },
    ];
    const unredact = (message: RedactedCoreMessage) =>
      fromRedactedCoreMessage(message, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    const { assistantMessage, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } =
      await executeSelfSummaryWithRetry(
        ctx,
        this.promptSession,
        this.stateHandler,
        this.interactionListener,
        compactInputMessages.map(unredact),
        this.tools,
        this.extraT,
        {
          preservedPrefixMessageCount: 1 + (partitioned.userInfoMessage !== undefined ? 1 : 0),
          ...this.retryOptions,
        },
      );
    const modeLabels = { mode: this.compactionMode };
    compactionInputTokens.histogram(ctx, inputTokens, modeLabels);
    compactionOutputTokens.histogram(ctx, outputTokens, modeLabels);
    compactionCacheReadTokens.histogram(ctx, cacheReadTokens!, modeLabels);
    compactionCacheWriteTokens.histogram(ctx, cacheWriteTokens!, modeLabels);
    const summaryText = extractTextContent(
      toRedactedCoreMessage(assistantMessage, this.stateHandler.getPrivacyMode()),
    ).unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    let candidate = summaryText.trim();
    if (candidate.startsWith("<analysis>")) {
      const leadingAnalysisClose = candidate.indexOf("</analysis>");
      if (leadingAnalysisClose !== -1) {
        candidate = candidate.slice(leadingAnalysisClose + "</analysis>".length);
      }
    }
    if (candidate.trimEnd().endsWith("</analysis>")) {
      const trailingAnalysisOpen = candidate.lastIndexOf("<analysis>");
      if (
        trailingAnalysisOpen !== -1 &&
        candidate.lastIndexOf("</summary>", trailingAnalysisOpen) !== -1
      ) {
        candidate = candidate.slice(0, trailingAnalysisOpen);
      }
    }
    const openTagIndex = candidate.indexOf("<summary>");
    const closeTagIndex = candidate.lastIndexOf("</summary>");
    const extractedSummaryBody = openTagIndex !== -1 && closeTagIndex > openTagIndex
      ? candidate.slice(openTagIndex + "<summary>".length, closeTagIndex).trim()
      : candidate.trim() || summaryText;
    return { text: extractedSummaryBody, inputTokens, outputTokens };
  }

  buildSummaryMessage(
    rawSummary: AnthropicRawSummary,
    partitioned: AnthropicPartition,
    enrichments: SummarizationEnrichments,
  ): { message: RedactedCoreMessage; summaryTextLength: number } {
    const durableBlocks = renderDurableBlocks(
      "anthropic-compaction",
      enrichments as DurableBlockEnrichments,
    );
    const wrappedContent = `${prependDurableBlocks("anthropic-compaction", durableBlocks)}

<summary>
${rawSummary.text}
</summary>${appendDurableBlocks("anthropic-compaction", durableBlocks)}`;
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
    partitioned: AnthropicPartition,
    summaryMessage: RedactedCoreMessage,
  ): readonly RedactedCoreMessage[] {
    if (!partitioned.systemMessage) throw new Error("Expected system message in conversation");
    return [
      partitioned.systemMessage,
      ...(partitioned.userInfoMessage ? [partitioned.userInfoMessage] : []),
      summaryMessage,
    ];
  }

  async summarize(
    ctx: Context,
    messages: readonly RedactedCoreMessage[],
    options: SummarizationPipelineOptions,
  ): Promise<Record<string, unknown>> {
    using spanContext = createSpan(ctx.withName("AnthropicCompactionHandler.summarize"));
    const innerCtx = spanContext.ctx;
    const startTime = performance.now();
    logger.info(innerCtx, "[anthropic-compaction] summarize starting", {
      messageCount: messages.length,
      modelId: this.modelId,
      mode: this.compactionMode,
    });
    try {
      const pipelineResult = await runSummarizationPipeline(this, innerCtx, messages, options);
      const summaryCodeString = createRedactedString(
        pipelineResult.rawSummary.text,
        DataClassification.CODE,
        "compaction-summary",
        this.stateHandler.getPrivacyMode(),
      );
      logger.info(innerCtx, "[anthropic-compaction] summarize completed", {
        summaryTextLength: pipelineResult.rawSummary.text.length,
        fullReplacementMessagesCount: pipelineResult.fullReplacementMessages.length,
        messagesActuallySummarizedCount: pipelineResult.messagesActuallySummarized.length,
      });
      compactionStatus.increment(innerCtx, 1, {
        outcome: "success",
        errorKind: "Ok",
        mode: this.compactionMode,
      });
      return {
        ...pipelineResult,
        summary: { summary: summaryCodeString },
        onPersisted: () => { this.stateHandler.incrementSelfSummaryCount(); },
      };
    } catch (error) {
      const errorKind = getRetryDirective(error, { transientRetryDelayMs: 0 }).errorType;
      compactionStatus.increment(innerCtx, 1, {
        outcome: "failed",
        errorKind,
        mode: this.compactionMode,
      });
      throw error;
    } finally {
      compactionTimeTakenMs.histogram(innerCtx, performance.now() - startTime, {
        mode: this.compactionMode,
      });
    }
  }
}

function estimateAnthropicCompactionTokens(messages: readonly RedactedCoreMessage[]): number {
  const serializedMessages = messages.map(
    message => `${message.role}: ${anthropicCompactionMessageToString(message)}`,
  );
  return Math.round(serializedMessages.join("\n\n").length / APPROX_CHARS_PER_TOKEN);
}

function anthropicCompactionMessageToString(message: RedactedCoreMessage): string {
  const unredactedMessage = fromRedactedCoreMessage(
    message,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
  );
  const content = unredactedMessage.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    const typedPart = part as Record<string, unknown>;
    if (typedPart.type === "text") return typedPart.text as string;
    if (typedPart.type === "reasoning") return typedPart.text as string;
    if (typedPart.type === "tool-call") {
      return `[Tool call] ${typedPart.toolName as string} ${JSON.stringify(typedPart.args) ?? "null"}`;
    }
    if (typedPart.type === "tool-result") {
      return `[Tool result] ${typedPart.toolName as string} ${JSON.stringify(typedPart.result) ?? "null"}`;
    }
    if (typedPart.type === "image") return "[Image]";
    if (typedPart.type === "file") return "[File]";
    return "";
  }).join("\n\n");
}

function assertAnthropicCompactionInputTokens(messages: readonly RedactedCoreMessage[]): void {
  const estimatedTokens = estimateAnthropicCompactionTokens(messages);
  if (estimatedTokens < MIN_ANTHROPIC_COMPACTION_INPUT_TOKENS) {
    throw new Error(
      `Refusing anthropic compaction for fewer than ${MIN_ANTHROPIC_COMPACTION_INPUT_TOKENS} tokens; estimated ${estimatedTokens} tokens in messagesToSummarize.`,
    );
  }
}
