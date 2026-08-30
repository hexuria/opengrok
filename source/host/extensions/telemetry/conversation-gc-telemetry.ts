export const CONVERSATION_GC_EVENT = "sand.conversation.gc";
export type ConversationGcReport =
  | { outcome: "failed"; trigger: string; agentId: string }
  | {
      outcome: "skipped";
      trigger: string;
      agentId: string;
      skipReason: string;
      unresolvedProtoRefs?: number;
    }
  | {
      outcome: "collected";
      trigger: string;
      agentId: string;
      stillOverCap: boolean;
      deletedRows: number;
      deletedBytes: number;
      liveRows: number;
      liveBytes: number;
      vacuumed: boolean;
    };
export function cappedCount(value: number): string {
  return String(
    Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value))),
  );
}
export function conversationGcLevel(
  report: ConversationGcReport,
): "info" | "warn" {
  if (report.outcome === "failed") return "warn";
  if (report.outcome === "skipped")
    return report.skipReason === "unresolved-refs" ? "warn" : "info";
  return report.stillOverCap ? "warn" : "info";
}
export function conversationGcTelemetry(report: ConversationGcReport) {
  return {
    level: conversationGcLevel(report),
    event: CONVERSATION_GC_EVENT,
    metadata: {
      trigger: report.trigger,
      outcome: report.outcome,
      agent_id: report.agentId,
      skip_reason: report.outcome === "skipped" ? report.skipReason : undefined,
      unresolved_proto_refs:
        report.outcome === "skipped" && report.unresolvedProtoRefs !== undefined
          ? cappedCount(report.unresolvedProtoRefs)
          : undefined,
      deleted_rows:
        report.outcome === "collected"
          ? cappedCount(report.deletedRows)
          : undefined,
      deleted_bytes:
        report.outcome === "collected"
          ? cappedCount(report.deletedBytes)
          : undefined,
      live_rows:
        report.outcome === "collected"
          ? cappedCount(report.liveRows)
          : undefined,
      live_bytes:
        report.outcome === "collected"
          ? cappedCount(report.liveBytes)
          : undefined,
      vacuumed:
        report.outcome === "collected" ? String(report.vacuumed) : undefined,
    },
  };
}
