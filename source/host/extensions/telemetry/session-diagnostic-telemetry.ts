export const SESSION_WARN_KINDS = new Set([
  "open_io_retry",
  "wal_unavailable",
  "quarantine_copied",
  "stat_failed",
  "path_stat_failed",
  "connector_secrets_unreadable",
  "fallback_adopt_failed",
  "placeholder_check_failed",
  "degraded",
]);
export const SESSION_EVENT_BY_FAMILY = {
  store_db: "sand.session.store_db",
  maintenance: "sand.session.maintenance",
  materialize: "sand.session.materialize",
  summary_build: "sand.session.summary_build",
} as const;
export interface SessionDiagnostic {
  family: keyof typeof SESSION_EVENT_BY_FAMILY;
  kind: string;
  agentId?: string;
  errorClass?: string;
  outcome?: string;
  quarantine?: string;
  salvagedKv?: number | null;
  salvagedBlobs?: number | null;
  salvagedTranscript?: number | null;
}
export function sessionDiagnosticTelemetry(r: SessionDiagnostic) {
  const level = SESSION_WARN_KINDS.has(r.kind) ? "warn" : "error";
  if (r.family === "store_db")
    return {
      level,
      event: SESSION_EVENT_BY_FAMILY[r.family],
      metadata: {
        kind: r.kind,
        agent_id: r.agentId,
        error_class: r.errorClass,
        outcome: r.outcome,
        quarantine: r.quarantine,
        salvaged_kv: r.salvagedKv != null ? String(r.salvagedKv) : undefined,
        salvaged_blobs:
          r.salvagedBlobs != null ? String(r.salvagedBlobs) : undefined,
        salvaged_transcript:
          r.salvagedTranscript != null
            ? String(r.salvagedTranscript)
            : undefined,
      },
    };
  return {
    level,
    event: SESSION_EVENT_BY_FAMILY[r.family],
    metadata: { kind: r.kind, agent_id: r.agentId, error_class: r.errorClass },
  };
}
