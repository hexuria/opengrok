export const BOX_LOG_SHIP_EVENT = "sand.box.log_ship";
export type BoxLogShipReport =
  | {
      kind: "progress";
      bytesWritten: number;
      bytesDelivered: number;
      pendingWindowCount: number;
      oldestPendingWindowAgeMs: number;
    }
  | {
      kind: "save_failed" | "save_recovered";
      errorClass: string;
      failureCount: number;
    };
export function boxLogShipTelemetry(report: BoxLogShipReport) {
  switch (report.kind) {
    case "progress":
      return {
        level: "info",
        message: BOX_LOG_SHIP_EVENT,
        metadata: {
          kind: report.kind,
          bytes_written: String(report.bytesWritten),
          bytes_delivered: String(report.bytesDelivered),
          pending_window_count: String(report.pendingWindowCount),
          oldest_pending_window_age_ms: String(report.oldestPendingWindowAgeMs),
        },
      };
    case "save_failed":
    case "save_recovered":
      return {
        level: report.kind === "save_failed" ? "warn" : "info",
        message: BOX_LOG_SHIP_EVENT,
        metadata: {
          kind: report.kind,
          error_class: report.errorClass,
          failure_count: String(report.failureCount),
        },
      };
  }
}
