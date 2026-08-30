export function reachabilityReportToTelemetry(report: { readonly outcome: string; readonly method: string; readonly latencyMs: number; readonly baseUrlKind: string; readonly httpStatus?: number; readonly causeSummary?: string }) {
  return { level: report.outcome === "ok" ? "info" : "warn", metadata: { outcome: report.outcome, method: report.method, latency_ms: String(Math.round(report.latencyMs)), base_url_kind: report.baseUrlKind, http_status: report.httpStatus === undefined ? undefined : String(report.httpStatus), cause: report.causeSummary } };
}
export function dnsDiagnosticReportToTelemetry(report: { readonly cluster: string; readonly trigger: string; readonly diagnosis: string; readonly systemExact?: string; readonly independentExact?: string; readonly independentWildcard?: string; readonly independentGeneral?: string }) {
  return { cluster: report.cluster, trigger: report.trigger, diagnosis: report.diagnosis, system_exact: report.systemExact, independent_exact: report.independentExact, independent_wildcard: report.independentWildcard, independent_general: report.independentGeneral };
}
