export const SIGNIN_GATES = new Set(["shell", "onboarding", "sign-in"] as const);
export const CONSULT_OUTCOMES = new Set(["veto-seen", "veto-roster", "fresh", "fail-open-probes", "fail-open-deadline"] as const);
export type SigninSignoutCause = "user_logout" | "forced" | "account_refused" | "session_expired" | "retained_after_failed_logout";
export type SigninLoginReport =
  | { readonly phase: "login_started" | "login_completed" }
  | { readonly phase: "login_failed"; readonly cause: "error" | "policy_refused" | "timeout" }
  | { readonly phase: "signed_out"; readonly cause: SigninSignoutCause };
export type SigninGateReport = { readonly gate: "shell" | "onboarding" | "sign-in" } | { readonly consult: "veto-seen" | "veto-roster" | "fresh" | "fail-open-probes" | "fail-open-deadline" };
const PRE_INSTALL_BUFFER_CAP = 16;

export function isValidSigninGateReport(value: unknown): value is SigninGateReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Record<string, unknown>;
  if (typeof report.gate === "string") return SIGNIN_GATES.has(report.gate as never);
  return typeof report.consult === "string" && CONSULT_OUTCOMES.has(report.consult as never);
}
export function signinGateToTelemetry(report: SigninGateReport) {
  return "gate" in report
    ? { level: "warn" as const, metadata: { phase: "boot_gate", gate: report.gate } }
    : { level: "warn" as const, metadata: { phase: "account_consult", outcome: report.consult } };
}
export function signinSignoutCause(cause: "user_action" | "login_cancelled" | "account_refused" | "policy" | "session_revoked" | "unparseable"): SigninSignoutCause {
  switch (cause) {
    case "user_action": return "user_logout";
    case "login_cancelled": return "forced";
    case "account_refused": case "policy": return "account_refused";
    case "session_revoked": case "unparseable": return "session_expired";
  }
}
export function signinLoginToTelemetry(report: SigninLoginReport) {
  return { level: "warn" as const, metadata: { phase: report.phase, cause: report.phase === "login_failed" || report.phase === "signed_out" ? report.cause : undefined } };
}

let reporter: ((report: SigninLoginReport) => void) | null | undefined;
let pendingPreInstall: SigninLoginReport[] = [];
export function installSigninLoginReporter(next: ((report: SigninLoginReport) => void) | null): void {
  reporter = next;
  const flush = pendingPreInstall;
  pendingPreInstall = [];
  if (next != null) for (const report of flush) next(report);
}
export function reportSigninFunnel(report: SigninLoginReport): void {
  if (reporter != null) { reporter(report); return; }
  if (pendingPreInstall.length < PRE_INSTALL_BUFFER_CAP) pendingPreInstall.push(report);
}
export function reportSigninLogin(report: SigninLoginReport): void { reportSigninFunnel(report); }
export function reportSigninSignout(cause: SigninSignoutCause): void { reportSigninFunnel({ phase: "signed_out", cause }); }
export function attachSigninLoginTelemetry(telemetry: () => { reportDesktopSignin(level: "warn", metadata: Readonly<Record<string, string | undefined>>): void } | null | undefined): void {
  installSigninLoginReporter((report) => { const projection = signinLoginToTelemetry(report); telemetry()?.reportDesktopSignin(projection.level, projection.metadata); });
}
