import type { Context } from "../../context/core.js";
import { createLogger } from "../../context/logger.js";
import { prepareMessagesForCompaction } from "../../agent-summarization/prepare-messages.js";
import type { PrivacyMode } from "../../redaction/privacy-mode.js";
import {
  EVAL_ENFORCED_SELF_SUMMARY_TOKEN_LIMIT,
} from "../utils/overridable-config.js";
import {
  SELF_SUMMARY_CONTEXT_WINDOW_FRACTION,
  SELF_SUMMARY_NUM_TURNS,
} from "./constants.js";
import { estimateTokenCount } from "./token-estimate.js";

export interface SelfSummaryMessage {
  readonly role: string;
  readonly content: unknown;
  readonly providerOptions?: {
    readonly cursor?: {
      readonly isSummary?: unknown;
      readonly [key: string]: unknown;
    } | undefined;
    readonly [key: string]: unknown;
  } | undefined;
  readonly _privacyMode: PrivacyMode;
  readonly [key: string]: unknown;
}

export interface SelfSummaryTokenDetails {
  readonly usedTokens?: number | undefined;
  readonly maxTokens?: number | undefined;
}

const logger = createLogger("@anysphere/agent");

export function findLastUserMessageIndex(
  messages: readonly SelfSummaryMessage[],
  options?: { readonly includeSummaryMessages?: boolean | undefined } | null,
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (
      message.role === "user" &&
      (options?.includeSummaryMessages || !message.providerOptions?.cursor?.isSummary)
    ) {
      return index;
    }
  }
  return -1;
}

function getMessagesToSummarize(messages: readonly SelfSummaryMessage[]): SelfSummaryMessage[] {
  const { messagesForSummarization } = prepareMessagesForCompaction(messages);
  return messagesForSummarization as SelfSummaryMessage[];
}

function countTurns(messages: readonly SelfSummaryMessage[]): number {
  if (messages.length < 2) return 0;
  const messagesToBeSummarized = getMessagesToSummarize(messages);
  let turnCount = 0;
  for (const message of messagesToBeSummarized) {
    if (message.role === "user" && !message.providerOptions?.cursor?.isSummary) {
      turnCount++;
    }
  }
  return turnCount;
}

export function shouldPerformSelfSummary(
  messages: readonly SelfSummaryMessage[],
  tokenDetails: SelfSummaryTokenDetails | null | undefined,
  ctx: Context | undefined,
  configTokenLimit: number | undefined,
): boolean {
  const turnCount = countTurns(messages);
  if (turnCount >= SELF_SUMMARY_NUM_TURNS) return true;

  const tokenCount = tokenDetails?.usedTokens !== undefined &&
      Number.isFinite(tokenDetails.usedTokens) && tokenDetails.usedTokens > 0
    ? tokenDetails.usedTokens
    : estimateTokenCount(messages, { includeNonTextContent: true });
  const evalOverrideLimit = ctx !== undefined
    ? EVAL_ENFORCED_SELF_SUMMARY_TOKEN_LIMIT(ctx)
    : undefined;
  if (evalOverrideLimit !== undefined && ctx !== undefined) {
    logger.info(ctx, "[self-summary] using eval override token limit", {
      evalOverrideLimit,
      configTokenLimit,
    });
  }
  const fractionLimit = tokenDetails?.maxTokens !== undefined && tokenDetails.maxTokens > 0
    ? Math.floor(tokenDetails.maxTokens * SELF_SUMMARY_CONTEXT_WINDOW_FRACTION)
    : undefined;
  const tokenLimit = evalOverrideLimit ?? configTokenLimit ?? fractionLimit;
  if (tokenLimit === undefined) return false;
  return tokenCount >= tokenLimit;
}
