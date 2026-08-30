import type { Context } from "../context/core.js";
import { createLogger } from "../context/logger.js";

export interface SummarizationPipelineMessage {
  readonly role: string;
  readonly [key: string]: unknown;
}

export interface SummarizationPartition<TMessage extends SummarizationPipelineMessage> {
  readonly messagesToSummarize: readonly TMessage[];
  readonly preservedTailMessages: readonly TMessage[];
  readonly skillBlocks: readonly string[];
}

export interface SummarizationPipelineOptions {
  readonly fullSummarization?: boolean | undefined;
  readonly backgroundSummarizationMode?: unknown;
  readonly triggerReason?: unknown;
  readonly todoContent?: unknown;
  readonly currentPlan?: unknown;
  readonly modePrompt?: unknown;
  readonly projectRootPrompt?: unknown;
  readonly automationTriggerContext?: unknown;
  readonly agentTranscriptsFolder?: unknown;
  readonly conversationId?: unknown;
  readonly [key: string]: unknown;
}

export interface SummarizationEnrichments {
  readonly skillBlocks: readonly string[];
  readonly todoContent: unknown;
  readonly currentPlan: unknown;
  readonly modePrompt: unknown;
  readonly projectRootPrompt: unknown;
  readonly automationTriggerContext: unknown;
  readonly agentTranscriptsFolder: unknown;
  readonly conversationId: unknown;
}

export interface SummarizationPipelineAdapter<
  TMessage extends SummarizationPipelineMessage,
  TRawSummary,
  TBuiltMessage extends TMessage,
> {
  partitionMessages(messages: readonly TMessage[], options: SummarizationPipelineOptions): SummarizationPartition<TMessage>;
  generateSummary(
    context: Context,
    partitioned: SummarizationPartition<TMessage>,
    options: SummarizationPipelineOptions,
  ): Promise<TRawSummary> | TRawSummary;
  buildSummaryMessage(
    rawSummary: TRawSummary,
    partitioned: SummarizationPartition<TMessage>,
    enrichments: SummarizationEnrichments,
  ): { readonly message: TBuiltMessage; readonly summaryTextLength: number };
  assembleFinalMessages(partitioned: SummarizationPartition<TMessage>, message: TBuiltMessage): readonly TMessage[];
}

const logger = createLogger("summarization-pipeline");

function warnIfPreservedTailShapeInvalid<TMessage extends SummarizationPipelineMessage>(
  context: Context,
  partitioned: SummarizationPartition<TMessage>,
  options: SummarizationPipelineOptions,
): void {
  const tail = partitioned.preservedTailMessages;
  if (tail.length === 0) return;
  const headIsUser = tail[0]!.role === "user";
  const laterUserIndex = tail.findIndex((message, index) => index > 0 && message.role === "user");
  if (headIsUser && laterUserIndex === -1) return;
  logger.warn(context, "[summarization-pipeline] preservedTailMessages shape invariant violated", {
    summarization: {
      preservedTailLength: tail.length,
      preservedTailRoles: tail.map(message => message.role),
      headRole: tail[0]!.role,
      headIsUser,
      laterUserIndex,
      messagesToSummarizeLength: partitioned.messagesToSummarize.length,
      fullSummarization: options.fullSummarization === true,
      backgroundSummarizationMode: options.backgroundSummarizationMode,
      triggerReason: options.triggerReason,
    },
  });
}

export async function runSummarizationPipeline<
  TMessage extends SummarizationPipelineMessage,
  TRawSummary,
  TBuiltMessage extends TMessage,
>(
  summarizer: SummarizationPipelineAdapter<TMessage, TRawSummary, TBuiltMessage>,
  context: Context,
  messages: readonly TMessage[],
  options: SummarizationPipelineOptions,
): Promise<{
  messagesActuallySummarized: readonly TMessage[];
  newSummaryMessage: TBuiltMessage;
  preservedOriginalTailMessages: readonly TMessage[];
  fullReplacementMessages: readonly TMessage[];
  rawSummary: TRawSummary;
  summaryTextLength: number;
}> {
  const partitioned = summarizer.partitionMessages(messages, options);
  warnIfPreservedTailShapeInvalid(context, partitioned, options);
  const enrichments: SummarizationEnrichments = {
    skillBlocks: partitioned.skillBlocks,
    todoContent: options.todoContent,
    currentPlan: options.currentPlan,
    modePrompt: options.modePrompt,
    projectRootPrompt: options.projectRootPrompt,
    automationTriggerContext: options.automationTriggerContext,
    agentTranscriptsFolder: options.agentTranscriptsFolder,
    conversationId: options.conversationId,
  };
  const rawSummary = await summarizer.generateSummary(context, partitioned, options);
  const builtSummary = summarizer.buildSummaryMessage(rawSummary, partitioned, enrichments);
  const finalMessages = summarizer.assembleFinalMessages(partitioned, builtSummary.message);
  return {
    messagesActuallySummarized: partitioned.messagesToSummarize,
    newSummaryMessage: builtSummary.message,
    preservedOriginalTailMessages: partitioned.preservedTailMessages,
    fullReplacementMessages: finalMessages,
    rawSummary,
    summaryTextLength: builtSummary.summaryTextLength,
  };
}
