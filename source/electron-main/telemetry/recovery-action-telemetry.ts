const validActions = new Set(["retry", "recover", "reset", "relaunch"]);
const boundedFailureClass = /^[a-z0-9_]{1,64}$/i;
export const RECOVERY_FUTILITY_WARN_AT = 3;
export interface RecoveryActionReport { readonly action: string; readonly failureClass: string; readonly consecutiveIdentical: number }
export function isValidRecoveryActionReport(value: unknown): value is RecoveryActionReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Partial<RecoveryActionReport>;
  return typeof report.action === "string" && validActions.has(report.action) && typeof report.failureClass === "string" && boundedFailureClass.test(report.failureClass) && typeof report.consecutiveIdentical === "number" && Number.isInteger(report.consecutiveIdentical) && report.consecutiveIdentical >= 1;
}
export function recoveryActionReportToTelemetry(report: RecoveryActionReport) { return { level: report.consecutiveIdentical >= RECOVERY_FUTILITY_WARN_AT ? "warn" : "info", metadata: { action: report.action, failure_class: report.failureClass.toLowerCase(), consecutive_identical: String(report.consecutiveIdentical) } }; }
