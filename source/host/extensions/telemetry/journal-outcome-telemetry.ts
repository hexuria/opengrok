import {
  sandErrorTags,
  type SandErrorValue,
} from "../../../shared/errors/registry.js";

export const JOURNAL_OUTCOME_EVENT = "sand.journal.outcome";
export interface JournalOutcomeReport {
  outcome: string;
  op: string;
  conversationId: string;
  entryCount?: number;
  bytes?: number;
  durationMs: number;
  cause?: SandErrorValue;
}
export function corruptTailKind(cause: SandErrorValue | undefined): unknown {
  return cause !== undefined && "tail" in cause ? cause.tail : undefined;
}
export function journalOutcomeLevel(
  report: JournalOutcomeReport,
): "error" | "warn" | "info" {
  if (report.outcome === "failed") return "error";
  const tail = corruptTailKind(report.cause);
  if (tail !== undefined && tail !== "missing") return "warn";
  return "info";
}
export function journalOutcomeTelemetry(r: JournalOutcomeReport) {
  return {
    level: journalOutcomeLevel(r),
    event: JOURNAL_OUTCOME_EVENT,
    metadata: {
      op: r.op,
      outcome: r.outcome,
      conversation_id: r.conversationId,
      entry_count:
        r.entryCount !== undefined ? String(r.entryCount) : undefined,
      bytes: r.bytes !== undefined ? String(r.bytes) : undefined,
      duration_ms: String(Math.round(r.durationMs)),
      ...(r.cause !== undefined ? sandErrorTags(r.cause) : {}),
    },
  };
}
