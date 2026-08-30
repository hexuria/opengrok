import { SAND_ACCESS_BLOCKED_CAUSES } from "../../shared/observability/telemetry.js";
import { isSandAccessBlockReason } from "../../shared/sand-access.js";
const validEdges = new Set(["entered", "recovered"]);
const validCauses = new Set<string>(SAND_ACCESS_BLOCKED_CAUSES);
export const ACCESS_BLOCKED_MS_BLOCKED_CAP_MS = 7 * 24 * 60 * 60 * 1_000;
export interface AccessBlockedReport { readonly edge: string; readonly cause: string; readonly accessReason: string; readonly msBlocked?: number }
export function isValidAccessBlockedReport(value: unknown): value is AccessBlockedReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Partial<AccessBlockedReport>;
  return typeof report.edge === "string" && validEdges.has(report.edge) && typeof report.cause === "string" && validCauses.has(report.cause) && isSandAccessBlockReason(report.accessReason) && (report.msBlocked === undefined || typeof report.msBlocked === "number" && Number.isFinite(report.msBlocked) && report.msBlocked >= 0);
}
export function isPagingAccessBlockedEdge(report: AccessBlockedReport): boolean { return report.edge === "entered" && report.cause !== "no_plan"; }
export function accessBlockedReportToTelemetry(report: AccessBlockedReport) { return { level: isPagingAccessBlockedEdge(report) ? "warn" : "info", metadata: { edge: report.edge, cause: report.cause, access_reason: report.accessReason, ms_blocked: report.msBlocked !== undefined ? String(Math.min(Math.round(report.msBlocked), ACCESS_BLOCKED_MS_BLOCKED_CAP_MS)) : undefined } }; }
