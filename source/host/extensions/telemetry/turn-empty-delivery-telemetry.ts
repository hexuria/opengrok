export const TURN_EMPTY_DELIVERY_EVENT = "sand.turn.empty_delivery";
export interface TurnEmptyDeliveryReport {
  conversationId: string;
  requestId?: string;
  source: string;
  requestSource?: string;
  replyNudgeAttempts?: number;
  redriveAttempts?: number;
  toolCallCount: number;
  streamOutputProduced: boolean;
  durationMs: number;
  ackOutstanding: boolean;
}
export function turnEmptyDeliveryTelemetry(r: TurnEmptyDeliveryReport) {
  return {
    level: "warn",
    event: TURN_EMPTY_DELIVERY_EVENT,
    metadata: {
      conversation_id: r.conversationId,
      request_id: r.requestId,
      source: r.source,
      request_source: r.requestSource,
      reply_nudge_attempts:
        r.replyNudgeAttempts !== undefined
          ? String(r.replyNudgeAttempts)
          : undefined,
      redrive_attempts:
        r.redriveAttempts !== undefined ? String(r.redriveAttempts) : undefined,
      tool_call_count: String(r.toolCallCount),
      stream_output_produced: String(r.streamOutputProduced),
      duration_ms: String(Math.round(r.durationMs)),
      ack_outstanding: String(r.ackOutstanding),
    },
  };
}
