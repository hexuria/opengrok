export const AGENTS_UNREACHABLE_PHASES = ["entered", "retry", "recovered"] as const;
export function isValidAgentsUnreachableReport(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Record<string, unknown>;
  return typeof report.phase === "string" && (AGENTS_UNREACHABLE_PHASES as readonly string[]).includes(report.phase) && typeof report.isManual === "boolean" && (report.errorClass === undefined || typeof report.errorClass === "string") && (report.msSinceLastReachedMs === undefined || typeof report.msSinceLastReachedMs === "number" && Number.isFinite(report.msSinceLastReachedMs) && report.msSinceLastReachedMs >= 0);
}
export function agentsUnreachableReportToTelemetry(report: any) {
  return { level: report.phase === "entered" ? "warn" : "info", metadata: { phase: report.phase, is_manual: String(report.isManual), error_class: report.errorClass, ms_since_last_reached: report.msSinceLastReachedMs === undefined ? undefined : String(Math.round(report.msSinceLastReachedMs)) } };
}
