export const REBUILD_KINDS = ["update", "reset", "recover", "reconnecting"] as const;
export const REBUILD_ESCALATIONS = ["taking-longer", "unreachable"] as const;
export const REBUILD_ESCALATION_ACTIONS = ["shown", "keep_waiting", "retry"] as const;

export function isValidRebuildLifecycleReport(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Record<string, unknown>;
  if (typeof report.rebuildKind !== "string" || !(REBUILD_KINDS as readonly string[]).includes(report.rebuildKind) || typeof report.elapsedMs !== "number" || !Number.isFinite(report.elapsedMs) || report.elapsedMs < 0) return false;
  if (report.kind === "escalation") return typeof report.action === "string" && (REBUILD_ESCALATION_ACTIONS as readonly string[]).includes(report.action) && typeof report.escalation === "string" && (REBUILD_ESCALATIONS as readonly string[]).includes(report.escalation);
  if (report.kind === "pending_stall") return typeof report.hasAck === "boolean" && typeof report.streamAttached === "boolean";
  return false;
}
export function rebuildLifecycleToTelemetry(report: any) {
  if (report.kind === "escalation") return { event: "escalation", level: report.action === "shown" ? "warn" : "info", metadata: { action: report.action, escalation: report.escalation, kind: report.rebuildKind, elapsed_ms: String(Math.round(report.elapsedMs)) } };
  return { event: "pending_stall", level: "warn", metadata: { kind: report.rebuildKind, has_ack: String(report.hasAck), stream_attached: String(report.streamAttached), elapsed_ms: String(Math.round(report.elapsedMs)) } };
}
