import { desktopErrorTags } from "./desktop-error-tags.js";
import type { TelemetryLevel, TelemetryMetadata } from "./desktop-lifecycle-telemetry.js";

export const DESKTOP_CHILD_GONE_REASONS = ["clean_exit", "abnormal_exit", "killed", "crashed", "oom", "launch_failed", "integrity_failure", "unknown"] as const;
export type DesktopChildGoneReason = typeof DESKTOP_CHILD_GONE_REASONS[number];
export type DesktopChildProcessKind = "window" | "webview" | "renderer_other" | "utility_coordinator" | "utility_other" | "gpu" | "zygote" | "sandbox_helper" | "pepper" | "unknown";

export function classifyChildGoneReason(reason: string): DesktopChildGoneReason {
  const normalized = reason.replace(/-/g, "_");
  return (DESKTOP_CHILD_GONE_REASONS as readonly string[]).includes(normalized) ? normalized as DesktopChildGoneReason : "unknown";
}
export function classifyWebContentsKind(type: string): DesktopChildProcessKind { return type === "window" ? "window" : type === "webview" ? "webview" : "renderer_other"; }
export function classifyChildProcessKind(details: { readonly type: string; readonly serviceName?: string }, isCoordinatorService: (name: string | undefined) => boolean): DesktopChildProcessKind {
  switch (details.type) {
    case "Utility": return isCoordinatorService(details.serviceName) ? "utility_coordinator" : "utility_other";
    case "GPU": return "gpu";
    case "Zygote": return "zygote";
    case "Sandbox helper": return "sandbox_helper";
    case "Pepper Plugin": case "Pepper Plugin Broker": return "pepper";
    default: return "unknown";
  }
}
export function classifyExitCode(exitCode: number | undefined): "unknown" | "zero" | "nonzero" { return exitCode === undefined ? "unknown" : exitCode === 0 ? "zero" : "nonzero"; }

export function childGoneTelemetry(gone: { readonly process: DesktopChildProcessKind; readonly reason: DesktopChildGoneReason; readonly exitCode?: number }): { level: TelemetryLevel; metadata: TelemetryMetadata } {
  const abnormal = gone.reason !== "clean_exit" && gone.reason !== "killed";
  const metadata = { state: "gone", process: gone.process, reason: gone.reason, exit_code: gone.exitCode === undefined ? undefined : String(gone.exitCode), exit_code_class: classifyExitCode(gone.exitCode), ...(abnormal ? desktopErrorTags("SAND-E0605", { process: gone.process, reason: gone.reason }) : {}) };
  return { level: abnormal ? "error" : gone.reason === "killed" ? "warn" : "info", metadata };
}

interface EventPort { on(event: string, listener: (...args: any[]) => void): void }
export function installDesktopChildGoneTelemetry(deps: { readonly app: EventPort; readonly isCoordinatorService: (name: string | undefined) => boolean; readonly report: (level: TelemetryLevel, metadata: TelemetryMetadata) => void }): void {
  deps.app.on("render-process-gone", (_event, contents: { getType(): string }, details: { reason: string; exitCode?: number }) => {
    const result = childGoneTelemetry({ process: classifyWebContentsKind(contents.getType()), reason: classifyChildGoneReason(details.reason), ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }) });
    deps.report(result.level, result.metadata);
  });
  deps.app.on("child-process-gone", (_event, details: { type: string; serviceName?: string; reason: string; exitCode?: number }) => {
    const result = childGoneTelemetry({ process: classifyChildProcessKind(details, deps.isCoordinatorService), reason: classifyChildGoneReason(details.reason), ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }) });
    deps.report(result.level, result.metadata);
  });
}
export function installWindowResponsivenessTelemetry(deps: { readonly contents: EventPort; readonly monotonicNow: () => number; readonly report: (level: TelemetryLevel, metadata: TelemetryMetadata) => void }): void {
  let unresponsiveSince: number | undefined;
  deps.contents.on("unresponsive", () => { if (unresponsiveSince !== undefined) return; unresponsiveSince = deps.monotonicNow(); deps.report("warn", { state: "unresponsive", process: "window" }); });
  deps.contents.on("responsive", () => { if (unresponsiveSince === undefined) return; const duration = Math.round(deps.monotonicNow() - unresponsiveSince); unresponsiveSince = undefined; deps.report("info", { state: "responsive", process: "window", unresponsive_ms: String(duration) }); });
}
