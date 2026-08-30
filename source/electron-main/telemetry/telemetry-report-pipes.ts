import { accessBlockedReportToTelemetry, isValidAccessBlockedReport } from "./access-blocked-telemetry.js";
import { agentLoadReportToTelemetry, isValidAgentLoadReport } from "./agent-load-telemetry.js";
import { isValidAgentsUnreachableReport } from "./agents-unreachable-telemetry.js";
import { clientFailureReportToTelemetry, isValidClientFailureReport, type ClientFailureTelemetry } from "./client-failure-telemetry.js";
import { isValidOnboardingStepReport, onboardingStepReportToAnalytics } from "./onboarding-analytics.js";
import { isValidReactionAckReport, reactionAckReportToTelemetry } from "./reaction-ack-telemetry.js";
import { isValidRebuildLifecycleReport } from "./rebuild-lifecycle-telemetry.js";
import { isValidReconciliationReport } from "./reconciliation-telemetry.js";
import { isValidRecoveryActionReport } from "./recovery-action-telemetry.js";
import { isValidRenderStreamReport, isValidRenderTtfrReport, renderStreamReportToTelemetry, renderTtfrReportToTelemetry } from "./render-telemetry.js";
import { isValidSendAckReport, sendAckReportToTelemetry } from "./send-ack-telemetry.js";
import { recordSendAckSpan, recordSendStageSpan } from "./desktop-send-trace.js";
import { isValidSendLatencyReport, sendLatencyReportToTelemetry } from "./send-telemetry.js";
import { isValidSentryConversationReport } from "./sentry-conversation.js";
import { setSandSentryConversation } from "./sentry.js";
import { reportPipe, type ReportPipe } from "./telemetry-report-sinks.js";
import { isValidVncLivenessReport } from "../../shared/vnc-liveness.js";

type Level = "info" | "warn" | "error";
type Metadata = Readonly<Record<string, string | undefined>>;
interface TelemetryUploader {
  reportAgentLoad(level: Level, metadata: Metadata): void; reportAccessBlocked(level: Level, metadata: Metadata): void; reportSendLatency(level: Level, metadata: Metadata): void; reportSendAck(level: Level, metadata: Metadata): void; reportReactionAck(level: Level, metadata: Metadata): void; reportVncSession(level: Level, metadata: Metadata): void; reportVncLiveness(level: Level, metadata: Metadata): void; reportOpenComputer(level: Level, metadata: Metadata): void; reportRenderTtfr(level: Level, metadata: Metadata): void; reportRenderStream(level: Level, metadata: Metadata): void; reportUpdatePrompt(level: Level, metadata: Metadata): void; reportDesktopSignin(level: Level, metadata: Metadata): void; reportClientFailure(failure: ClientFailureTelemetry): void;
}
interface CoordinatorTelemetry { agentsUnreachable(report: any): void; recoveryAction(report: any): void; rebuildLifecycle(report: any): void; reconciliation(report: any): void }
export interface BuiltTelemetryReportPipes { readonly agentLoad: ReportPipe; readonly agentsUnreachable: ReportPipe; readonly accessBlocked: ReportPipe; readonly recoveryAction: ReportPipe; readonly rebuildLifecycle: ReportPipe; readonly reconciliation: ReportPipe; readonly sendLatency: ReportPipe; readonly sendAck: ReportPipe; readonly reactionAck: ReportPipe; readonly vncSession: ReportPipe; readonly vncLiveness: ReportPipe; readonly openComputer: ReportPipe; readonly renderTtfr: ReportPipe; readonly renderStream: ReportPipe; readonly updatePrompt: ReportPipe; readonly signinGate: ReportPipe; readonly onboardingStep: ReportPipe; readonly clientFailure: ReportPipe; readonly sentryConversation: ReportPipe }

const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function isValidVncSessionReport(value: unknown): boolean { if (typeof value !== "object" || value === null) return false; const r = value as Record<string, unknown>; return typeof r.surface === "string" && ["preview", "interactive"].includes(r.surface) && typeof r.phase === "string" && ["navigate", "dom_ready", "load_fail", "rfb_connect", "rfb_disconnect", "reconnect", "focus"].includes(r.phase) && [r.vncHost, r.display, r.failCode].every((v) => v === undefined || typeof v === "string") && [r.durationMs, r.sinceOpenMs].every((v) => v === undefined || nonnegative(v)) && [r.clean, r.focusLanded].every((v) => v === undefined || typeof v === "boolean") && (r.focusOwner === undefined || typeof r.focusOwner === "string" && ["vnc", "composer", "pending"].includes(r.focusOwner)); }
function vncSessionToTelemetry(r: any, token?: { seeded: boolean; source?: string }) { const warn = r.phase === "load_fail" || r.phase === "reconnect" || r.phase === "rfb_disconnect" && r.clean === false || r.phase === "focus" && r.focusLanded === false; return { level: warn ? "warn" as const : "info" as const, metadata: { surface: r.surface, phase: r.phase, vnc_host: r.vncHost, display: r.display, duration_ms: r.durationMs === undefined ? undefined : String(Math.round(r.durationMs)), since_open_ms: r.sinceOpenMs === undefined ? undefined : String(Math.round(r.sinceOpenMs)), fail_code: r.failCode, clean: r.clean === undefined ? undefined : String(r.clean), focus_owner: r.focusOwner, focus_landed: r.focusLanded === undefined ? undefined : String(r.focusLanded), token_seeded: token === undefined ? undefined : String(token.seeded), token_source: token?.source } }; }
function vncLivenessToTelemetry(r: any) { return { level: "warn" as const, metadata: { phase: r.phase, stall_ms: String(Math.round(r.stallMs)), keys: String(Math.round(r.keys)), clicks: String(Math.round(r.clicks)), moves: String(Math.round(r.moves)), in_bytes: String(Math.round(r.inBytes)), error_code: "SAND-E0609", error_domain: "desktop", error_retryable: "true" } }; }
function isValidOpenComputerReport(value: unknown): boolean { if (typeof value !== "object" || value === null) return false; const r = value as Record<string, unknown>; return typeof r.trigger === "string" && ["preview", "handoff", "teach"].includes(r.trigger) && typeof r.hadVncUrl === "boolean" && typeof r.monitorFocused === "boolean"; }
function openComputerToTelemetry(r: any) { return { level: "info" as const, metadata: { trigger: r.trigger, had_vnc_url: String(r.hadVncUrl), monitor_focused: String(r.monitorFocused) } }; }
function isValidUpdatePromptReport(value: unknown): boolean { if (typeof value !== "object" || value === null) return false; const r = value as Record<string, unknown>; return typeof r.surface === "string" && ["footer_pill", "account_menu", "palette", "settings", "blocker"].includes(r.surface) && typeof r.action === "string" && ["shown", "clicked", "confirmed", "canceled", "refused_superseded"].includes(r.action) && typeof r.kind === "string" && ["check", "progress", "ready", "error", "disabled"].includes(r.kind) && (r.targetVersion === undefined || typeof r.targetVersion === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(r.targetVersion)); }
function updatePromptToTelemetry(r: any) { return { level: "info" as const, metadata: { surface: r.surface, action: r.action, kind: r.kind, target_version: r.targetVersion } }; }
function isValidSigninGateReport(value: unknown): boolean { if (typeof value !== "object" || value === null) return false; const r = value as Record<string, unknown>; return typeof r.gate === "string" ? ["shell", "onboarding", "sign-in"].includes(r.gate) : typeof r.consult === "string" && ["veto-seen", "veto-roster", "fresh", "fail-open-probes", "fail-open-deadline"].includes(r.consult); }
function signinGateToTelemetry(r: any) { return "gate" in r ? { level: "warn" as const, metadata: { phase: "boot_gate", gate: r.gate } } : { level: "warn" as const, metadata: { phase: "account_consult", outcome: r.consult } }; }

export function buildTelemetryReportPipes(deps: { readonly telemetry: () => TelemetryUploader | undefined; readonly productAnalytics: () => { trackEvent(name: string, properties: Readonly<Record<string, unknown>>): void } | undefined; readonly getVncTokenInfo: (host: string) => { seeded: boolean; source?: string } | undefined; readonly coordinatorTelemetry: CoordinatorTelemetry }): BuiltTelemetryReportPipes {
  const emit = (method: keyof TelemetryUploader, projection: (report: any) => { level: string; metadata: Metadata }) => (report: any): void => { const value = projection(report); const uploader = deps.telemetry(); const fn = uploader?.[method] as ((level: Level, metadata: Metadata) => void) | undefined; fn?.call(uploader, value.level as Level, value.metadata); };
  return {
    agentLoad: reportPipe(isValidAgentLoadReport, emit("reportAgentLoad", agentLoadReportToTelemetry)),
    agentsUnreachable: reportPipe(isValidAgentsUnreachableReport, deps.coordinatorTelemetry.agentsUnreachable),
    accessBlocked: reportPipe(isValidAccessBlockedReport, emit("reportAccessBlocked", accessBlockedReportToTelemetry)),
    recoveryAction: reportPipe(isValidRecoveryActionReport, deps.coordinatorTelemetry.recoveryAction),
    rebuildLifecycle: reportPipe(isValidRebuildLifecycleReport, deps.coordinatorTelemetry.rebuildLifecycle),
    reconciliation: reportPipe(isValidReconciliationReport, deps.coordinatorTelemetry.reconciliation),
    sendLatency: reportPipe(isValidSendLatencyReport, emit("reportSendLatency", sendLatencyReportToTelemetry)),
    sendAck: reportPipe(isValidSendAckReport, (report: any) => { emit("reportSendAck", sendAckReportToTelemetry)(report); recordSendAckSpan(report); }),
    reactionAck: reportPipe(isValidReactionAckReport, emit("reportReactionAck", reactionAckReportToTelemetry)),
    vncSession: reportPipe(isValidVncSessionReport, (report: any) => { const value = vncSessionToTelemetry(report, report.vncHost === undefined ? undefined : deps.getVncTokenInfo(report.vncHost)); deps.telemetry()?.reportVncSession(value.level, value.metadata); }),
    vncLiveness: reportPipe(isValidVncLivenessReport, emit("reportVncLiveness", vncLivenessToTelemetry)),
    openComputer: reportPipe(isValidOpenComputerReport, emit("reportOpenComputer", openComputerToTelemetry)),
    renderTtfr: reportPipe(isValidRenderTtfrReport, (report: any) => { emit("reportRenderTtfr", renderTtfrReportToTelemetry)(report); if (report.outcome === "rendered") recordSendStageSpan({ name: "render-first-chunk", traceparent: report.traceparent, ...(report.clientNonce === undefined ? {} : { clientNonce: report.clientNonce }), startEpochMs: report.enterEpochMs, durationMs: report.ttfrMs, attributes: { "sand.render_ttfr_ms": Math.round(report.ttfrMs), ...(report.chunkType === undefined ? {} : { "sand.render_chunk_type": report.chunkType }), ...(report.conversationId === undefined ? {} : { "sand.conversation_id": report.conversationId }) } }); }),
    renderStream: reportPipe(isValidRenderStreamReport, emit("reportRenderStream", renderStreamReportToTelemetry)),
    updatePrompt: reportPipe(isValidUpdatePromptReport, emit("reportUpdatePrompt", updatePromptToTelemetry)),
    signinGate: reportPipe(isValidSigninGateReport, emit("reportDesktopSignin", signinGateToTelemetry)),
    onboardingStep: reportPipe(isValidOnboardingStepReport, (report) => deps.productAnalytics()?.trackEvent("sand.onboarding.step_viewed", onboardingStepReportToAnalytics(report))),
    clientFailure: reportPipe(isValidClientFailureReport, (report: any) => deps.telemetry()?.reportClientFailure(clientFailureReportToTelemetry(report))),
    sentryConversation: reportPipe(isValidSentryConversationReport, (report) => setSandSentryConversation(report.agentId)),
  };
}
