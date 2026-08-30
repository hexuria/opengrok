export const SEARCH_INDEX_HEALTH_EVENT = "sand.search_index.health";
export const SEARCH_INDEX_WARN_KINDS = new Set([
  "dispose_drain_cut",
  "worker_terminate_failed",
  "job_retry",
]);
export interface SearchIndexHealthReport {
  kind: string;
  stage?: string;
  errorClass?: string;
  count?: number | null;
}
export function searchIndexHealthTelemetry(report: SearchIndexHealthReport) {
  return {
    level: SEARCH_INDEX_WARN_KINDS.has(report.kind) ? "warn" : "error",
    event: SEARCH_INDEX_HEALTH_EVENT,
    metadata: {
      kind: report.kind,
      stage: report.stage,
      error_class: report.errorClass,
      count: report.count != null ? String(report.count) : undefined,
    },
  };
}
