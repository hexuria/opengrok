import { buildTelemetryReportPipes, type BuiltTelemetryReportPipes } from "./telemetry-report-pipes.js";
import { registerTelemetryReportSinks } from "./telemetry-report-sinks.js";
import type { DesktopMetricsRuntime } from "../process-metrics/desktop-metrics-runtime.js";
import type { SandBoxVisibilityTracker, createBoxVisibilityReportHandler } from "../box/box-visibility-telemetry.js";
import { ingestHeapMetricsReport } from "../process-metrics/heap-metrics-ingest.js";

export interface ProductionTelemetryIpcSources {
  readonly telemetry: Parameters<typeof buildTelemetryReportPipes>[0]["telemetry"];
  readonly productAnalytics: Parameters<typeof buildTelemetryReportPipes>[0]["productAnalytics"];
  readonly getVncTokenInfo: (host: string) => { readonly seeded: boolean; readonly source?: string } | undefined;
  readonly coordinatorTelemetry: Parameters<typeof buildTelemetryReportPipes>[0]["coordinatorTelemetry"];
  readonly desktopMetricsRuntime: DesktopMetricsRuntime;
  readonly boxVisibilityTracker: SandBoxVisibilityTracker;
  readonly handleBoxVisibilityReport: (report: Parameters<ReturnType<typeof createBoxVisibilityReportHandler>>[0]) => void;
  readonly isQuitting: () => boolean;
  readonly ensureExperimentService: () => Promise<{ checkFeatureGate(name: string): boolean }>;
  readonly reportTelemetrySinkFailure: (failure: { readonly sink: string; readonly errorClass: string }) => void;
}

/**
 * Process-owned telemetry registration. The imported owner captures Electron's
 * module-level ipcMain and intentionally has no disposer or rollback phase.
 * Call this only after the root has constructed every source in the contract.
 */
export function registerProductionTelemetryIpc(
  sources: ProductionTelemetryIpcSources,
): { readonly pipes: BuiltTelemetryReportPipes } {
  const pipes = buildTelemetryReportPipes({
    telemetry: sources.telemetry,
    productAnalytics: sources.productAnalytics,
    getVncTokenInfo: sources.getVncTokenInfo,
    coordinatorTelemetry: sources.coordinatorTelemetry,
  });
  registerTelemetryReportSinks({
    pipes: { ...pipes },
    heapMetrics: {
      isQuitting: sources.isQuitting,
      isEnabled: async () => (await sources.ensureExperimentService()).checkFeatureGate("sand_renderer_heap_metrics"),
      ingest: async (report) => {
        const manager = await sources.desktopMetricsRuntime.ensureClientNumericMetricsManager();
        if (sources.isQuitting()) return false;
        return ingestHeapMetricsReport(report, manager as unknown as { report(metric: string, value: number): void });
      },
      requestFlush: () => sources.desktopMetricsRuntime.requestHeapMetricsFlush(),
    },
    handleBoxVisibilityReport: sources.handleBoxVisibilityReport as unknown as (report: { readonly report: unknown; readonly senderFrame: unknown; readonly currentMainFrame: unknown }) => void,
    onSinkFailure: sources.reportTelemetrySinkFailure,
  });
  return { pipes };
}
