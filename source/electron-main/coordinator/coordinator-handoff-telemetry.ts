import { desktopErrorTags } from "../telemetry/desktop-error-tags.js";
import type { TelemetryLevel, TelemetryMetadata } from "../telemetry/desktop-lifecycle-telemetry.js";

export function createCoordinatorHandoffTelemetry(report: (level: TelemetryLevel, metadata: TelemetryMetadata) => void) {
  return {
    requested(): void { report("info", { phase: "requested" }); },
    adopted(leg: string): void { report("info", { phase: "adopted", leg }); },
    invokeFailed(leg: string): void { report("warn", { phase: "invoke_failed", ...desktopErrorTags("SAND-E0606", { leg }) }); },
    exitTimeout(timeoutMs: number): void { report("warn", { phase: "timeout", ...desktopErrorTags("SAND-E0607", { timeoutMs }) }); },
  };
}
