import { desktopErrorTags } from "./desktop-error-tags.js";
import type { TelemetryLevel, TelemetryMetadata } from "./desktop-lifecycle-telemetry.js";

export const DESKTOP_PROCESS_CRASH_EVENT_CAP = 20;
export type DesktopProcessCrashKind = "uncaughtException" | "unhandledRejection";

export function createDesktopProcessCrashReporter(deps: {
  readonly eventCap?: number;
  readonly monotonicNow: () => number;
  readonly report: (level: TelemetryLevel, metadata: TelemetryMetadata) => void;
  readonly captureCrash: (error: unknown, kind: DesktopProcessCrashKind) => void;
}) {
  const cap = deps.eventCap ?? DESKTOP_PROCESS_CRASH_EVENT_CAP;
  let crashSeq = 0;
  return (error: unknown, kind: DesktopProcessCrashKind): void => {
    crashSeq += 1;
    if (crashSeq <= cap) {
      deps.report("error", {
        kind,
        crash_seq: String(crashSeq),
        uptime_ms: String(Math.round(deps.monotonicNow())),
        capped: crashSeq === cap ? "true" : undefined,
        ...desktopErrorTags(kind === "uncaughtException" ? "SAND-E0603" : "SAND-E0604"),
      });
    }
    deps.captureCrash(error, kind);
  };
}
