export const LOCAL_EXEC_REFUSED_EVENT = "sand.local_exec.refused",
  LOCAL_EXEC_FAILED_EVENT = "sand.local_exec.exec_failed",
  LOCAL_EXEC_PROVIDER_EVENT = "sand.local_exec.provider";
const refusalDefinitions = {
  no_providers: { code: "SAND-E0111", domain: "transport", retryable: true },
  stale_heartbeat: { code: "SAND-E0112", domain: "transport", retryable: true },
  computer_unknown: {
    code: "SAND-E0113",
    domain: "transport",
    retryable: true,
  },
} as const;
export type LocalExecRefusalCause = keyof typeof refusalDefinitions;
export function refusalError(cause: LocalExecRefusalCause) {
  return refusalDefinitions[cause];
}
export function localExecRefusedTelemetry(r: {
  cause: LocalExecRefusalCause;
  site: string;
  conversationId: string;
  providerCount: number;
  liveProviderCount: number;
  everRegistered: boolean;
  emptyForMs?: number;
}) {
  const error = refusalError(r.cause);
  return {
    level: "warn",
    event: LOCAL_EXEC_REFUSED_EVENT,
    metadata: {
      cause: r.cause,
      site: r.site,
      conversation_id: r.conversationId,
      provider_count: String(r.providerCount),
      live_provider_count: String(r.liveProviderCount),
      ever_registered: String(r.everRegistered),
      empty_for_ms:
        r.emptyForMs !== undefined
          ? String(Math.round(r.emptyForMs))
          : undefined,
      error_code: error.code,
      error_domain: error.domain,
      error_retryable: String(error.retryable),
    },
  };
}
export function localExecFailedTelemetry(r: {
  errorClass: string;
  errno?: string;
  site: string;
  conversationId: string;
}) {
  return {
    level: "warn",
    event: LOCAL_EXEC_FAILED_EVENT,
    metadata: {
      error_class: r.errorClass,
      errno: r.errno,
      site: r.site,
      surface: "external",
      conversation_id: r.conversationId,
    },
  };
}
export type LocalExecProviderReport =
  | {
      phase: "hello";
      providerId: string;
      providerCount: number;
      helloDelayMs: number;
      computerIdPresent: boolean;
      rehello: boolean;
      supervised?: boolean;
      variant?: string;
    }
  | {
      phase: "detached";
      providerId: string;
      providerCount: number;
      ageMs: number;
      hadHello: boolean;
      hasHeartbeat: boolean;
      wasLive: boolean;
      emptied: boolean;
    };
export function localExecProviderTelemetry(r: LocalExecProviderReport) {
  const supervised =
    r.phase === "hello" && r.supervised !== undefined
      ? String(r.supervised)
      : undefined;
  return {
    level: "info",
    event: LOCAL_EXEC_PROVIDER_EVENT,
    metadata: {
      phase: r.phase,
      provider_id: r.providerId,
      provider_count: String(r.providerCount),
      ...(r.phase === "hello"
        ? {
            hello_delay_ms: String(Math.round(r.helloDelayMs)),
            computer_id_present: String(r.computerIdPresent),
            rehello: String(r.rehello),
            supervised,
            variant: r.variant,
          }
        : {}),
      ...(r.phase === "detached"
        ? {
            age_ms: String(Math.round(r.ageMs)),
            had_hello: String(r.hadHello),
            has_heartbeat: String(r.hasHeartbeat),
            was_live: String(r.wasLive),
            emptied: String(r.emptied),
          }
        : {}),
    },
  };
}
