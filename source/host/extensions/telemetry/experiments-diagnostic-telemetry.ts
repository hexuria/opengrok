export const EXPERIMENTS_DIAGNOSTIC_EVENT = "sand.experiments.diagnostic";
export const INFO_KINDS = new Set([
  "bootstrap_resolved",
  "bootstrap_anonymous",
  "bootstrap_discarded_auth_changed",
  "exposure_flush_failed",
  "shutdown_failed",
]);
export const WARN_KINDS = new Set([
  "bootstrap_config_unparseable",
  "bootstrap_cache_read_failed",
]);
export interface ExperimentsDiagnostic {
  kind: string;
  stage?: string;
  reason?: string;
  errorClass?: string;
  gatesOnCount?: number | null;
  authenticated?: boolean | null;
}
export function levelFor(
  diagnostic: ExperimentsDiagnostic,
): "info" | "warn" | "error" {
  if (diagnostic.kind === "config_not_applied")
    return diagnostic.reason === "identity_unhydrated" ? "info" : "warn";
  if (INFO_KINDS.has(diagnostic.kind)) return "info";
  return WARN_KINDS.has(diagnostic.kind) ? "warn" : "error";
}
export function experimentsDiagnosticTelemetry(
  diagnostic: ExperimentsDiagnostic,
) {
  return {
    level: levelFor(diagnostic),
    event: EXPERIMENTS_DIAGNOSTIC_EVENT,
    metadata: {
      kind: diagnostic.kind,
      stage: diagnostic.stage,
      reason: diagnostic.reason,
      error_class: diagnostic.errorClass,
      gates_on_count:
        diagnostic.gatesOnCount != null
          ? String(diagnostic.gatesOnCount)
          : undefined,
      authenticated:
        diagnostic.authenticated != null
          ? String(diagnostic.authenticated)
          : undefined,
    },
  };
}
