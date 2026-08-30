export const AUTOMATION_LATE_FIRE_THRESHOLD_MS = 5 * 60_000;
export const AUTOMATION_RUN_EVENT = "sand.automation.run";
export const AUTOMATION_FIRE_DROPPED_EVENT = "sand.automation.fire_dropped";
export interface AutomationRunReport {
  conversationId: string;
  automationId: string;
  trigger: string;
  outcome: string;
  isGroup: boolean;
  durationMs: number;
  latenessMs?: number | null;
  scheduledForMs?: number | null;
  sentMessageCount?: number | null;
  eventBatchSize?: number | null;
}
export interface AutomationFireDroppedReport {
  conversationId: string;
  trigger: string;
  reason: string;
  scheduledForMs?: number | null;
  latenessMs?: number | null;
  errorType?: string;
  errorCode?: string;
  runUuid?: string;
  fireAgeMs?: number | null;
  hasDefinitionRevision?: boolean | null;
  boxUptimeMs?: number | null;
}

export function automationRunTelemetry(report: AutomationRunReport) {
  const isLate =
    report.latenessMs != null &&
    report.latenessMs >= AUTOMATION_LATE_FIRE_THRESHOLD_MS;
  return {
    level: report.outcome === "ok" && !isLate ? "info" : "warn",
    event: AUTOMATION_RUN_EVENT,
    metadata: {
      conversation_id: report.conversationId,
      automation_id: report.automationId,
      trigger: report.trigger,
      outcome: report.outcome,
      is_group: String(report.isGroup),
      duration_ms: String(report.durationMs),
      lateness_ms:
        report.latenessMs != null ? String(report.latenessMs) : undefined,
      scheduled_for_ms:
        report.scheduledForMs != null
          ? String(report.scheduledForMs)
          : undefined,
      late: report.latenessMs != null ? String(isLate) : undefined,
      sent_message_count:
        report.sentMessageCount != null
          ? String(report.sentMessageCount)
          : undefined,
      event_batch_size:
        report.eventBatchSize != null
          ? String(report.eventBatchSize)
          : undefined,
    },
  };
}

export function automationFireDroppedTelemetry(
  report: AutomationFireDroppedReport,
) {
  return {
    level: "warn",
    event: AUTOMATION_FIRE_DROPPED_EVENT,
    metadata: {
      conversation_id: report.conversationId,
      trigger: report.trigger,
      reason: report.reason,
      scheduled_for_ms:
        report.scheduledForMs != null
          ? String(report.scheduledForMs)
          : undefined,
      lateness_ms:
        report.latenessMs != null ? String(report.latenessMs) : undefined,
      error_type: report.errorType,
      error_code: report.errorCode,
      run_uuid: report.runUuid,
      fire_age_ms:
        report.fireAgeMs != null ? String(report.fireAgeMs) : undefined,
      has_definition_revision:
        report.hasDefinitionRevision != null
          ? String(report.hasDefinitionRevision)
          : undefined,
      box_uptime_ms:
        report.boxUptimeMs != null ? String(report.boxUptimeMs) : undefined,
    },
  };
}
