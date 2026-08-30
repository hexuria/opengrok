export type SessionRefreshFailure =
  | { readonly kind: "http_status"; readonly httpStatus: number }
  | { readonly kind: "network"; readonly errno: string }
  | { readonly kind: "bad_payload" };
export type SessionSignoutCause = "policy" | "session_revoked" | "unparseable" | "user_action" | "login_cancelled" | "account_refused";
export type SessionReport =
  | { readonly phase: "refresh_failed"; readonly failure: SessionRefreshFailure }
  | { readonly phase: "refresh_recovered"; readonly consecutiveFailures: number; readonly degradedMs: number }
  | { readonly phase: "rotation_rescued" }
  | { readonly phase: "signed_out"; readonly cause: SessionSignoutCause; readonly durable: boolean }
  | { readonly phase: "keychain_unavailable" };
export interface SessionTelemetryProjection { readonly level: "info" | "warn"; readonly metadata: Readonly<Record<string, string>> }

export const CONSECUTIVE_FAILURES_CAP = 10_000;
export const DEGRADED_MS_BUCKET_CAP = 86_400_000;
export const DEGRADED_MS_BUCKET_CEILINGS_MS = [5_000, 30_000, 60_000, 300_000, 1_800_000, 21_600_000, DEGRADED_MS_BUCKET_CAP] as const;
const PRE_INSTALL_BUFFER_CAP = 16;

export function degradedMsBucket(degradedMs: number): number {
  for (const ceiling of DEGRADED_MS_BUCKET_CEILINGS_MS) if (degradedMs < ceiling) return ceiling;
  return DEGRADED_MS_BUCKET_CAP;
}

function errorTags(code: string, retryable: boolean, payload: Readonly<Record<string, string | number | undefined>> = {}): Record<string, string> {
  const tags: Record<string, string> = { error_code: code, error_domain: "auth", error_retryable: String(retryable) };
  for (const [key, value] of Object.entries(payload)) if (value !== undefined) tags[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = String(value);
  return tags;
}

function refreshFailureTags(failure: SessionRefreshFailure): Record<string, string> {
  switch (failure.kind) {
    case "http_status": return errorTags("SAND-E0214", true, { httpStatus: failure.httpStatus });
    case "network": return errorTags("SAND-E0215", true, { errno: failure.errno });
    case "bad_payload": return errorTags("SAND-E0216", true);
  }
}

export function sessionReportToTelemetry(report: SessionReport): SessionTelemetryProjection {
  switch (report.phase) {
    case "refresh_failed": return { level: "warn", metadata: { phase: report.phase, ...refreshFailureTags(report.failure) } };
    case "refresh_recovered": return { level: "info", metadata: { phase: report.phase, consecutive_failures: String(Math.min(report.consecutiveFailures, CONSECUTIVE_FAILURES_CAP)), degraded_ms: String(degradedMsBucket(report.degradedMs)) } };
    case "rotation_rescued": return { level: "info", metadata: { phase: report.phase } };
    case "signed_out": {
      const tags = report.cause === "policy" ? errorTags("SAND-E0218", false)
        : report.cause === "session_revoked" || report.cause === "unparseable" ? errorTags("SAND-E0217", false) : {};
      return { level: Object.keys(tags).length > 0 || !report.durable ? "warn" : "info", metadata: { phase: report.phase, cause: report.cause, durable: String(report.durable), ...tags } };
    }
    case "keychain_unavailable": return { level: "warn", metadata: { phase: report.phase, ...errorTags("SAND-E0219", false) } };
  }
}

let reporter: ((report: SessionReport) => void) | null | undefined;
let pendingPreInstall: SessionReport[] = [];
export function installSessionReporter(next: ((report: SessionReport) => void) | null): void {
  reporter = next;
  const flush = pendingPreInstall;
  pendingPreInstall = [];
  if (next != null) for (const report of flush) next(report);
}
export function reportSessionEvent(report: SessionReport): void {
  if (reporter != null) { reporter(report); return; }
  if (pendingPreInstall.length < PRE_INSTALL_BUFFER_CAP) pendingPreInstall.push(report);
}
export function attachSessionTelemetry(telemetry: () => { reportDesktopSession(level: "info" | "warn", metadata: Readonly<Record<string, string>>): void } | null | undefined): void {
  installSessionReporter((report) => { const projection = sessionReportToTelemetry(report); telemetry()?.reportDesktopSession(projection.level, projection.metadata); });
}
