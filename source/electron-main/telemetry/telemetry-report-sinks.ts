import { createRequire } from "node:module";

let requireElectron: NodeRequire;
try {
  requireElectron = eval("require") as NodeRequire;
} catch {
  const requireFilename = typeof __filename === "string" ? __filename : import.meta.url;
  requireElectron = createRequire(requireFilename);
}

export interface ReportPipe { ingest(report: unknown): void }
export function reportPipe<T>(isValid: (value: unknown) => value is T, deliver: (report: T) => void): ReportPipe;
export function reportPipe(isValid: (value: unknown) => boolean, deliver: (report: any) => void): ReportPipe;
export function reportPipe(isValid: (value: unknown) => boolean, deliver: (report: any) => void): ReportPipe { return { ingest(report: unknown): void { if (isValid(report)) deliver(report); } }; }

export interface IpcMainPort { on(channel: string, listener: (event: IpcEventPort, report: unknown) => void): void }
export interface IpcEventPort { readonly sender: { isDestroyed(): boolean; readonly mainFrame: unknown }; readonly senderFrame: unknown }
export interface TelemetryReportPipes { readonly [name: string]: ReportPipe }
const { ipcMain } = requireElectron("electron") as { readonly ipcMain: IpcMainPort };
export const TELEMETRY_REPORT_CHANNELS = [
  ["sand:report-agent-load", "agentLoad"], ["sand:report-agents-unreachable", "agentsUnreachable"], ["sand:report-access-blocked", "accessBlocked"], ["sand:report-recovery-action", "recoveryAction"], ["sand:report-rebuild-lifecycle", "rebuildLifecycle"], ["sand:report-reconciliation", "reconciliation"], ["sand:report-send-latency", "sendLatency"], ["sand:report-send-ack", "sendAck"], ["sand:report-reaction-ack", "reactionAck"], ["sand:report-vnc-session", "vncSession"], ["sand:report-vnc-liveness", "vncLiveness"], ["sand:report-open-computer", "openComputer"], ["sand:report-render-ttfr", "renderTtfr"], ["sand:report-render-stream", "renderStream"], ["sand:report-update-prompt", "updatePrompt"], ["sand:report-signin-gate", "signinGate"], ["sand:report-onboarding-step", "onboardingStep"], ["sand:report-client-failure", "clientFailure"], ["sand:sentry-conversation", "sentryConversation"],
] as const;

function errorClass(error: unknown): string { return error instanceof Error ? error.name || "Error" : typeof error; }
export function registerTelemetryReportSinks(deps: { readonly pipes: TelemetryReportPipes; readonly heapMetrics: { isQuitting(): boolean; isEnabled(): Promise<boolean>; ingest(report: unknown): Promise<boolean>; requestFlush(): void }; readonly onSinkFailure: (failure: { readonly sink: "heap-metrics"; readonly errorClass: string }) => void; readonly handleBoxVisibilityReport: (report: { readonly report: unknown; readonly senderFrame: unknown; readonly currentMainFrame: unknown }) => void }): void {
  for (const [channel, name] of TELEMETRY_REPORT_CHANNELS) { const sink = deps.pipes[name]; if (sink === undefined) throw new TypeError(`Missing telemetry report pipe: ${name}`); ipcMain.on(channel, (_event, report) => sink.ingest(report)); }
  ipcMain.on("sand:report-heap-metrics", (_event, report) => { void (async () => { if (deps.heapMetrics.isQuitting() || !await deps.heapMetrics.isEnabled()) return; if (deps.heapMetrics.isQuitting() || !await deps.heapMetrics.ingest(report)) return; deps.heapMetrics.requestFlush(); })().catch((error: unknown) => deps.onSinkFailure({ sink: "heap-metrics", errorClass: errorClass(error) })); });
  ipcMain.on("sand:report-box-visibility", (event, report) => { if (event.sender.isDestroyed()) return; deps.handleBoxVisibilityReport({ report, senderFrame: event.senderFrame, currentMainFrame: event.sender.mainFrame }); });
}
