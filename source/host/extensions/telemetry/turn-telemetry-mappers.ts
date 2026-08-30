export const TURN_INTERRUPT_EVENT = "sand.turn.interrupt",
  TURN_AWAIT_EVENT = "sand.turn.await",
  TURN_RETRY_EVENT = "sand.turn.retry",
  CLOSING_SEND_NUDGE_EVENT = "sand.turn.closing_send_nudge",
  USER_MESSAGE_RECEIVED_EVENT = "sand.user_message.received",
  COMPUTER_USE_USAGE_EVENT = "sand.computer_use.usage",
  TTFT_EVENT = "sand.ttft",
  TURN_USAGE_EVENT = "sand.turn.usage",
  TURN_USAGE_SCHEMA_VERSION = "2";
export const BOUNDED_ERROR_TYPE = /^[0-9A-Za-z._|:-]{1,64}$/;
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
}
type TurnFields = Record<
  string,
  string | number | boolean | null | undefined | TokenUsage
>;
export function totalInputTokens(usage: TokenUsage): number {
  return usage.inputTokens;
}
export function usageTokenTags(usage: TokenUsage | null | undefined) {
  if (usage == null) return {};
  return {
    input_tokens: String(usage.inputTokens),
    output_tokens: String(usage.outputTokens),
    cache_read_tokens: String(usage.cacheReadTokens),
    cache_write_tokens: String(usage.cacheWriteTokens),
    reasoning_tokens:
      usage.reasoningTokens != null ? String(usage.reasoningTokens) : undefined,
    total_input_tokens: String(totalInputTokens(usage)),
  };
}
export function turnInterruptTelemetry(r: TurnFields) {
  return {
    level: "info",
    event: TURN_INTERRUPT_EVENT,
    metadata: {
      conversation_id: r.conversationId,
      reason: r.reason,
      had_active_run: String(r.hadActiveRun),
      was_in_flight: String(r.wasInFlight),
    },
  };
}
export function turnAwaitTelemetry(r: TurnFields) {
  return {
    level: "info",
    event: TURN_AWAIT_EVENT,
    metadata: {
      conversation_id: r.conversationId,
      block_until_ms: String(r.blockUntilMs),
      outcome: r.outcome,
      await_index: String(r.awaitIndex),
    },
  };
}
export function turnRetryTelemetry(r: TurnFields) {
  return {
    level: r.outcome === "retried" ? "info" : "warn",
    event: TURN_RETRY_EVENT,
    metadata: {
      conversation_id: r.conversationId,
      outcome: r.outcome,
      attempt: String(r.attempt),
      max_attempts: String(r.maxAttempts),
      error_type: BOUNDED_ERROR_TYPE.test(String(r.errorType))
        ? r.errorType
        : "error",
      error_code: r.errorCode,
      cause: r.cause,
      delay_ms:
        r.delayMs != null ? String(Math.round(r.delayMs as number)) : undefined,
      server_paced: r.serverPaced != null ? String(r.serverPaced) : undefined,
    },
  };
}
export function userMessageReceivedTelemetry(r: TurnFields) {
  return {
    level: "info",
    event: USER_MESSAGE_RECEIVED_EVENT,
    metadata: {
      conversation_id: r.conversationId,
      was_in_flight: String(r.wasInFlight),
    },
  };
}
export function closingSendNudgeTelemetry(r: TurnFields) {
  return {
    level: !r.delivered && !r.aborted ? "warn" : "info",
    event: CLOSING_SEND_NUDGE_EVENT,
    metadata: {
      conversation_id: r.conversationId,
      delivered: String(r.delivered),
      sent_message_count: String(r.sentMessageCount),
      aborted: String(r.aborted),
    },
  };
}
export function ttftTelemetry(r: TurnFields) {
  return {
    level: "info",
    event: TTFT_EVENT,
    metadata: {
      conversation_id: r.conversationId,
      ttft_ms:
        r.ttftMs !== undefined
          ? String(Math.round(r.ttftMs as number))
          : undefined,
      skew: String(r.skew),
      skew_reason: r.skewReason,
      chunk_type: r.chunkType,
      is_fork: String(r.isFork),
      model_id: r.modelId,
      trace_id: r.traceId,
      span_id: r.spanId,
    },
  };
}
export function turnUsageTelemetry(r: TurnFields) {
  const usage = r.usage as TokenUsage | null | undefined;
  return {
    level: "info",
    event: TURN_USAGE_EVENT,
    metadata: {
      schema_version: TURN_USAGE_SCHEMA_VERSION,
      conversation_id: r.conversationId,
      source: r.source,
      request_id: r.requestId as string | undefined,
      has_request_id: String(r.requestId != null),
      request_id_count: String(r.requestIdCount),
      turn_ended_seq: String(r.turnEndedSeq),
      has_usage: String(usage != null),
      ...usageTokenTags(usage),
    },
  };
}
export function computerUseUsageTelemetry(r: TurnFields) {
  const usage = r.usage as TokenUsage | null | undefined;
  return {
    level: r.outcome === "error" ? "warn" : "info",
    event: COMPUTER_USE_USAGE_EVENT,
    metadata: {
      schema_version: "1",
      parent_agent_id: r.parentAgentId,
      subagent_agent_id: r.subagentAgentId,
      subagent_type: r.subagentType,
      request_id: r.subagentRequestId,
      model_id: r.modelId,
      outcome: r.outcome,
      duration_ms: String(Math.round(r.durationMs as number)),
      tool_call_count: String(r.toolCallCount),
      turn_ended_count: String(r.turnEndedCount),
      has_usage: String(usage != null),
      ...usageTokenTags(usage),
    },
  };
}
