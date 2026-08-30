export interface AutoReviewApprovalReport {
  eventType: string;
  conversationId: string;
  approvalId: string;
  surface: string;
  status: string;
  ageMs: number;
  ttlMs?: number;
  cause?: string;
}

export function autoReviewApprovalTelemetry(report: AutoReviewApprovalReport) {
  return {
    event: "sand.auto_review.approval",
    metadata: {
      event_type: report.eventType,
      conversation_id: report.conversationId,
      approval_id: report.approvalId,
      surface: report.surface,
      status: report.status,
      age_ms: String(Math.max(0, Math.round(report.ageMs))),
      ...(report.ttlMs !== undefined
        ? { ttl_ms: String(Math.max(0, Math.round(report.ttlMs))) }
        : {}),
      ...(report.cause !== undefined ? { cause: report.cause } : {}),
    },
  };
}
