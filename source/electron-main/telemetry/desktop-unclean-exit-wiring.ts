import { join } from "node:path";
import { createPollingPolicy, realClock } from "../../internal/scheduling.js";
import { isProcessAlive } from "../local-exec/local-exec-native.js";
import { createDesktopUncleanExitSettlement, SESSION_MARKER_FILE_NAME, SESSION_MARKER_HEARTBEAT_INTERVAL_MS } from "./desktop-unclean-exit-telemetry.js";
import type { TelemetryLevel, TelemetryMetadata } from "./desktop-lifecycle-telemetry.js";

export function wireDesktopUncleanExitSettlement(deps: {
  readonly app: { getPath(name: "userData"): string; on(event: "will-quit", listener: () => void): void };
  readonly report: (level: TelemetryLevel, metadata: TelemetryMetadata) => void;
  readonly pid?: number;
  readonly startedAtMs?: number;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly reportEdgeFailure?: (subsystem: string, leg: string, error: unknown) => void;
}) {
  const controller = createDesktopUncleanExitSettlement({
    markerPath: join(deps.app.getPath("userData"), SESSION_MARKER_FILE_NAME),
    report: deps.report,
    pid: deps.pid ?? process.pid,
    isPidAlive: deps.isPidAlive ?? isProcessAlive,
    startedAtMs: deps.startedAtMs ?? Math.round(performance.timeOrigin),
    heartbeatPolicy: createPollingPolicy(realClock, { name: "sand-desktop-session-marker", intervalMs: SESSION_MARKER_HEARTBEAT_INTERVAL_MS }),
    ...(deps.reportEdgeFailure === undefined ? {} : { reportEdgeFailure: deps.reportEdgeFailure }),
  });
  deps.app.on("will-quit", () => controller.settleClean());
  return controller;
}
