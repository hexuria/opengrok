export type DiskPressureLevel = "hard" | "soft" | string;
export interface DiskPressureReport {
  level: DiskPressureLevel;
  volume: string;
  trigger: string;
  totalBytes: number;
  availableBytes: number;
  usedPercent: number;
}
export function telemetryLevel(
  level: DiskPressureLevel,
): "error" | "warn" | "info" {
  if (level === "hard") return "error";
  if (level === "soft") return "warn";
  return "info";
}
export function diskPressureTelemetry(report: DiskPressureReport) {
  return {
    level: telemetryLevel(report.level),
    metadata: {
      volume: report.volume,
      pressure_level: report.level,
      trigger: report.trigger,
      total_bytes: String(report.totalBytes),
      available_bytes: String(report.availableBytes),
      used_percent: report.usedPercent.toFixed(1),
    },
  };
}
