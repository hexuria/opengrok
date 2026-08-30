import { desktopErrorTags } from "./desktop-error-tags.js";
import type { TelemetryLevel, TelemetryMetadata } from "./desktop-lifecycle-telemetry.js";

export const DESKTOP_STARTUP_STUCK_MS = 120_000;
export type DesktopStartupPhase = "app_ready_wait" | "services" | "coordinator" | "window" | string;

export function resolveDesktopTranslated(args: { readonly platform: NodeJS.Platform; readonly runningUnderArm64Translation: () => boolean }): "true" | "false" | "unknown" {
  if (args.platform !== "darwin") return "unknown";
  return args.runningUnderArm64Translation() ? "true" : "false";
}

export function createDesktopStartupTracker(deps: {
  readonly monotonicNow: () => number;
  readonly translated: "true" | "false" | "unknown";
  readonly report: (level: TelemetryLevel, metadata: TelemetryMetadata) => void;
  readonly scheduleStuck: (listener: () => void) => void;
  readonly captureFailure: (error: unknown, phase: DesktopStartupPhase) => void;
}) {
  const startedAt = deps.monotonicNow();
  let phase: DesktopStartupPhase = "app_ready_wait";
  let phaseStartedAt = startedAt;
  let windowStartedAt: number | undefined;
  let settled: "ready" | "failed" | "cancelled" | undefined;
  let watchdogArmed = false;
  deps.report("info", { outcome: "start", phase, translated: deps.translated });
  const elapsedMs = () => String(Math.round(deps.monotonicNow() - startedAt));
  return {
    markPhase(next: DesktopStartupPhase): void {
      if (settled != null) return;
      phase = next;
      phaseStartedAt = deps.monotonicNow();
      if (next === "window") windowStartedAt = phaseStartedAt;
    },
    armStuckWatchdog(): void {
      if (watchdogArmed || settled != null) return;
      watchdogArmed = true;
      deps.scheduleStuck(() => {
        if (settled != null) return;
        deps.report("warn", { outcome: "stuck", translated: deps.translated, elapsed_ms: elapsedMs(), phase_elapsed_ms: String(Math.round(deps.monotonicNow() - phaseStartedAt)), ...desktopErrorTags("SAND-E0602", { phase }) });
      });
    },
    noteReady(): void {
      if (settled != null) return;
      settled = "ready";
      const now = deps.monotonicNow();
      deps.report("info", { outcome: "ready", phase, translated: deps.translated, duration_ms: String(Math.round(now - startedAt)), window_ms: windowStartedAt === undefined ? undefined : String(Math.round(now - windowStartedAt)) });
    },
    noteFailed(error: unknown): void {
      if (settled != null) return;
      settled = "failed";
      deps.report("error", { outcome: "failed", translated: deps.translated, duration_ms: elapsedMs(), ...desktopErrorTags("SAND-E0601", { phase }) });
      deps.captureFailure(error, phase);
    },
    cancel(): void { if (settled == null) settled = "cancelled"; },
  };
}
