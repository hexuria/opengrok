import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { format } from "node:util";
import type {
  DeadlinePolicy,
  ExpiryPolicy,
  PollingPolicy,
} from "../../../internal/scheduling.js";
import type { StructuredLogClient } from "../../../shared/observability/structured-log-transport.js";
import { errorLogTag } from "../../../shared/errors.js";
import { getSandInferenceBackendUrl } from "../../../shared/node/cursor-backend/cursor-inference.js";
import { getSandClientVersion } from "../../../shared/node/sand-client-metadata.js";
import {
  SandProductAnalytics,
  type ProductAnalyticsClient,
  type ProductAnalyticsGate,
} from "../../../shared/node/analytics/product-analytics.js";
import { setTurnTraceHostBundleVersion } from "../../send-trace-host.js";
import { sandMessageLengthBucket } from "../../ports/sand-analytics-types.js";
import {
  withAutomationRunAnalytics,
  type AnalyticsClient,
} from "./analytics-service.js";
import { BoxLogShipper, isBoxLogShippingEnabled } from "./box-log-shipper.js";
import { forwardDesktopHealthWith } from "./desktop-health-forwarder.js";
import { createEventLoopTelemetry } from "./event-loop-telemetry.js";
import {
  forwardHostCrashMarkerWith,
  type HostCrashMarkerStore,
} from "./host-crash-marker.js";
import { HostLifecycleProgress } from "./host-lifecycle-progress.js";
import { initSandHostTracing, type HostTracing } from "./host-tracing.js";
import { createModelExperimentExposureLatch } from "./model-experiment-exposure.js";
import { createPressureCpuProfiler } from "./pressure-cpu-profiler.js";
import {
  SandStructuredLogTelemetry,
  type LogLevel,
  type Metadata,
} from "./structured-log-telemetry.js";
export const SUPERVISOR_LOG_PATH = "/tmp/sand-supervisor.log",
  SAND_SUPERVISOR_DESKTOP_HEALTH_PATH =
    "/tmp/sand-supervisor/desktop-health.json",
  DESKTOP_HEALTH_FORWARD_INTERVAL_MS = 30_000,
  DESKTOP_HEALTH_HEARTBEAT_MS = 5 * 60_000;
type Renewal = {
  outcome: string;
  consecutiveFailures: number;
  durationMs: number;
  errorSummary?: string;
};
export interface ProductAnalytics extends AnalyticsClient {
  activate(experiments: ProductAnalyticsGate): Promise<void>;
  markActive(reason: string): void;
  canRecordEvents(): boolean;
  dispose(): Promise<void>;
}
export class NoopProductAnalytics implements ProductAnalytics {
  async activate(): Promise<void> {}
  markActive(): void {}
  canRecordEvents(): boolean {
    return false;
  }
  trackEvent(): void {}
  async dispose(): Promise<void> {}
}
export function subscribeToCredentialRenewalTelemetry(
  auth: {
    subscribeToRenewal(listener: (result: Renewal) => void): () => void;
    getLastRenewalEvent(): Renewal | null;
  },
  logs: SandStructuredLogTelemetry,
): () => void {
  const report = (result: Renewal) =>
    logs.reportInferenceCredentialRenewal(
      result.outcome === "failed" ? "error" : "info",
      {
        outcome: result.outcome,
        consecutive_failures: String(result.consecutiveFailures),
        duration_ms: String(result.durationMs),
        error_summary: result.errorSummary,
      },
    );
  const unsubscribe = auth.subscribeToRenewal(report);
  const missed = auth.getLastRenewalEvent();
  if (missed !== null) report(missed);
  return unsubscribe;
}
interface Polling {
  start(listener: () => Promise<void>): { dispose(): void };
}
export interface HostTelemetryOptions {
  auth: {
    peekAccessToken(): string | null;
    getAccessToken(...args: unknown[]): Promise<string>;
    getMachineId(): Promise<string>;
    subscribeToRenewal(listener: (result: Renewal) => void): () => void;
    getLastRenewalEvent(): Renewal | null;
  };
  experiments: {
    checkGate(name: string): Promise<boolean>;
    subscribe(listener: () => void): () => void;
    hasHydratedStatsigUserId(): boolean;
    waitForHydratedStatsigUserId(ms: number): Promise<boolean>;
    getSandModelExperimentState():
      { active: boolean; arm: string } | null | undefined;
    logSandModelExperimentExposure(): boolean;
    getDynamicConfig(name: string): Record<string, number> | undefined;
    checkFeatureGate(name: string): boolean;
  };
  inference: { onModelExperimentApplied(listener: () => void): () => void };
  identityTags?: Metadata;
  flushPolling?: PollingPolicy;
  submitDeadline?: DeadlinePolicy;
  identityHoldExpiry?: ExpiryPolicy;
  createStructuredLogClient?: () => StructuredLogClient;
  createProductAnalyticsClient?: () => ProductAnalyticsClient;
  boxLogPolling: Polling;
  desktopHealthPolling: Polling;
  hostCrashMarkerPolling: Polling;
  hostCrashMarkerStore: HostCrashMarkerStore;
  fatalFlushDeadline: { run<T>(operation: () => Promise<T>): Promise<T> };
  clock: { monotonicNow(): number };
  hostLifecycleWatchdog: { arm(listener: () => void): { dispose(): void } };
  analytics?: ProductAnalytics;
  tracing?: HostTracing;
  logs?: SandStructuredLogTelemetry;
}

export interface MessageSentReport {
  agentId: string;
  prompt?: string;
  attachmentPaths?: readonly string[];
  richText?: string;
  isFork?: boolean;
  source?: string;
  isGroupRoom: boolean;
}

export class HostTelemetryService {
  readonly logs: SandStructuredLogTelemetry;
  readonly analytics: ProductAnalytics;
  readonly brain: ReturnType<typeof withAutomationRunAnalytics>;
  readonly tracing: HostTracing;
  readonly modelExperimentExposure: ReturnType<
    typeof createModelExperimentExposureLatch
  >;
  private eventLoop: ReturnType<typeof createEventLoopTelemetry> | undefined;
  private pressureProfiler:
    ReturnType<typeof createPressureCpuProfiler> | undefined;
  private boxLogShipper: BoxLogShipper | undefined;
  private desktopHealthPolling: { dispose(): void } | undefined;
  private unsubscribeEvents: (() => void) | undefined;
  private restoreConsole: (() => void) | undefined;
  private hostCrashMarkerForwarding: { dispose(): void } | undefined;
  private lastHandledHostCrashMarker: string | undefined;
  private lastForwardedDesktopHealthRevision: number | null = null;
  private lastForwardedDesktopHealthAtMs: number | null = null;
  constructor(private readonly options: HostTelemetryOptions) {
    this.tracing =
      options.tracing ??
      initSandHostTracing({
        getToken: options.auth.peekAccessToken.bind(options.auth),
        backendUrl: getSandInferenceBackendUrl(),
        serviceVersion: getSandClientVersion(),
      });
    this.logs =
      options.logs ??
      new SandStructuredLogTelemetry({
        ...(options.identityTags === undefined
          ? {}
          : { identityTags: options.identityTags }),
        ...(options.flushPolling === undefined
          ? {}
          : { flushPolling: options.flushPolling }),
        ...(options.submitDeadline === undefined
          ? {}
          : { submitDeadline: options.submitDeadline }),
        ...(options.identityHoldExpiry === undefined
          ? {}
          : { identityHoldExpiry: options.identityHoldExpiry }),
        ...(options.createStructuredLogClient === undefined
          ? {}
          : { createClient: options.createStructuredLogClient }),
        getAccessToken: (...args) => options.auth.getAccessToken(...args),
        getMachineId: () => options.auth.getMachineId(),
        holdFlushForHostBundleIdentity: true,
      });
    this.analytics =
      options.analytics ??
      new SandProductAnalytics({
        getAccessToken: (request) => options.auth.getAccessToken(request),
        getMachineId: () => options.auth.getMachineId(),
        ...(options.createProductAnalyticsClient === undefined
          ? {}
          : { createClient: options.createProductAnalyticsClient }),
        hostInBox: true,
      });
    this.brain = withAutomationRunAnalytics(this.logs, this.analytics);
    this.modelExperimentExposure = createModelExperimentExposureLatch({
      experiments: options.experiments,
      analytics: this.analytics,
    });
  }
  async start(): Promise<void> {
    this.restoreConsole = this.installConsoleForwarding();
    const unsubscribeRenewal = subscribeToCredentialRenewalTelemetry(
        this.options.auth,
        this.logs,
      ),
      unsubscribeModelExperiment =
        this.options.inference.onModelExperimentApplied(() =>
          this.modelExperimentExposure.note(),
        );
    this.unsubscribeEvents = () => {
      unsubscribeRenewal();
      unsubscribeModelExperiment();
    };
    const telemetryEnabled = process.env.SAND_DISABLE_TELEMETRY !== "1";
    if (telemetryEnabled) {
      this.pressureProfiler = createPressureCpuProfiler({
        overrides: () =>
          this.options.experiments.getDynamicConfig(
            "sand_pressure_cpu_profiler_config",
          ),
      });
      this.eventLoop = createEventLoopTelemetry({
        report: (summary, trigger) => {
          this.logs.reportHostEventLoop({ trigger, ...summary });
          if (
            trigger === "pressure" &&
            this.options.experiments.checkFeatureGate(
              "sand_enable_pressure_cpu_profiler",
            )
          )
            this.pressureProfiler?.onPressure();
        },
      });
      this.logs.setFlushTickListener(() => {
        this.eventLoop?.onTick();
        this.pressureProfiler?.onTick();
      });
      this.desktopHealthPolling = this.options.desktopHealthPolling.start(() =>
        this.forwardDesktopHealth(),
      );
    }
    if (isBoxLogShippingEnabled() && telemetryEnabled) {
      const hostLogFile = process.env.SAND_HOST_LOG_FILE?.trim(),
        skipPaths =
          hostLogFile != null && hostLogFile.length > 0
            ? [hostLogFile]
            : [SUPERVISOR_LOG_PATH];
      this.boxLogShipper = new BoxLogShipper({
        reportBatch: (records, settle) =>
          this.logs.reportBoxLogBatch(records, settle),
        reportBoxLogShip: (report, settle) =>
          this.logs.reportBoxLogShip(report, settle),
        skipPaths,
        polling: this.options.boxLogPolling,
        clock: this.options.clock,
      });
    }
    void this.analytics
      .activate(this.options.experiments)
      .then(() => this.analytics.markActive("host_startup"))
      .catch((error) => {
        console.warn(
          `[sand-telemetry] analytics activation failed (${errorLogTag(error)})`,
        );
      });
  }
  api() {
    return {
      logs: this.logs,
      brain: this.brain,
      analytics: this.analytics,
      createHostLifecycleProgress: (startedAt: number) =>
        new HostLifecycleProgress({
          startedAt,
          now: () => this.options.clock.monotonicNow(),
          watchdog: this.options.hostLifecycleWatchdog,
          report: (report) => this.logs.reportHostLifecycle(report),
        }),
      setHostBundleIdentity: (identity: {
        hostBundleVersion?: string;
        boxStoreId?: string;
      }) => this.setHostBundleIdentity(identity),
      flushTracing: () => this.tracing.flush(),
      flushForFatalExit: () => this.flushForFatalExit(),
      reportMessageSent: (report: MessageSentReport) =>
        this.reportMessageSent(report),
      noteSandModelExperimentActive: () => this.modelExperimentExposure.note(),
    };
  }
  async setHostBundleIdentity(identity: {
    hostBundleVersion?: string;
    boxStoreId?: string;
  }): Promise<void> {
    setTurnTraceHostBundleVersion(identity.hostBundleVersion);
    this.logs.setHostBundleIdentity(identity);
    this.startHostCrashMarkerForwarding();
    await this.boxLogShipper?.start();
  }
  reportMessageSent(report: MessageSentReport): void {
    const text = typeof report.prompt === "string" ? report.prompt.trim() : "",
      charCount = text.length;
    this.analytics.markActive("user_action");
    this.analytics.trackEvent("sand.message.sent", {
      agent_id: report.agentId,
      char_count: charCount,
      length_bucket: sandMessageLengthBucket(charCount),
      attachment_count: Array.isArray(report.attachmentPaths)
        ? report.attachmentPaths.length
        : 0,
      has_rich_text:
        typeof report.richText === "string" && report.richText.length > 0,
      is_fork: report.isFork === true,
      source: typeof report.source === "string" ? report.source : "desktop",
      is_group_room: report.isGroupRoom === true,
    });
  }
  async dispose(): Promise<void> {
    const shipper = this.boxLogShipper;
    await shipper?.stopPolling();
    await shipper?.checkpointOffsets();
    this.boxLogShipper = undefined;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    this.hostCrashMarkerForwarding?.dispose();
    this.hostCrashMarkerForwarding = undefined;
    this.desktopHealthPolling?.dispose();
    this.desktopHealthPolling = undefined;
    this.logs.setFlushTickListener(undefined);
    this.eventLoop?.dispose();
    this.eventLoop = undefined;
    this.pressureProfiler?.dispose();
    this.pressureProfiler = undefined;
    this.restoreConsole?.();
    this.restoreConsole = undefined;
    await this.analytics.dispose();
    await this.logs.dispose();
    await shipper?.dispose();
    await this.tracing.dispose();
  }
  startHostCrashMarkerForwarding(): void {
    if (this.hostCrashMarkerForwarding !== undefined) return;
    this.hostCrashMarkerForwarding = this.options.hostCrashMarkerPolling.start(
      async () => {
        const result = await forwardHostCrashMarkerWith({
          store: this.options.hostCrashMarkerStore,
          emit: (marker) => this.logs.reportHostProcessExitConfirmed(marker),
          wasForwarded: (raw) => raw === this.lastHandledHostCrashMarker,
          markForwarded: (raw) => {
            this.lastHandledHostCrashMarker = raw;
          },
        });
        if (
          result === "absent" ||
          result === "delivered" ||
          result === "parse_error"
        ) {
          this.hostCrashMarkerForwarding?.dispose();
          this.hostCrashMarkerForwarding = undefined;
        }
      },
    );
  }
  async flushForFatalExit(): Promise<void> {
    try {
      await this.options.fatalFlushDeadline.run(async () => {
        const shipper = this.boxLogShipper;
        await shipper?.stopPolling();
        await shipper?.checkpointOffsets();
        await this.logs.dispose();
        await shipper?.dispose();
      });
    } catch {}
  }
  async forwardDesktopHealth(): Promise<void> {
    try {
      await forwardDesktopHealthWith({
        heartbeatMs: DESKTOP_HEALTH_HEARTBEAT_MS,
        readRaw: async () => {
          try {
            if (!existsSync(SAND_SUPERVISOR_DESKTOP_HEALTH_PATH)) return null;
            return await readFile(SAND_SUPERVISOR_DESKTOP_HEALTH_PATH, "utf8");
          } catch {
            return null;
          }
        },
        emit: (level, metadata) =>
          this.logs.reportDesktopHealth(level, metadata),
        now: Date.now,
        getLast: () => ({
          revision: this.lastForwardedDesktopHealthRevision,
          atMs: this.lastForwardedDesktopHealthAtMs,
        }),
        setLast: (revision, atMs) => {
          this.lastForwardedDesktopHealthRevision = revision;
          this.lastForwardedDesktopHealthAtMs = atMs;
        },
      });
    } catch {}
  }
  installConsoleForwarding(): () => void {
    const originalLog = console.log,
      originalInfo = console.info,
      originalWarn = console.warn,
      originalError = console.error;
    let forwarding = false;
    const wrap =
      (original: (...args: unknown[]) => void, level: LogLevel) =>
      (...args: unknown[]) => {
        original(...args);
        if (forwarding) return;
        forwarding = true;
        try {
          this.logs.reportHostLog(level, format(...args));
        } catch {
        } finally {
          forwarding = false;
        }
      };
    const wrappedLog = wrap(originalLog, "info"),
      wrappedInfo = wrap(originalInfo, "info"),
      wrappedWarn = wrap(originalWarn, "warn"),
      wrappedError = wrap(originalError, "error");
    console.log = wrappedLog;
    console.info = wrappedInfo;
    console.warn = wrappedWarn;
    console.error = wrappedError;
    return () => {
      if (console.log === wrappedLog) console.log = originalLog;
      if (console.info === wrappedInfo) console.info = originalInfo;
      if (console.warn === wrappedWarn) console.warn = originalWarn;
      if (console.error === wrappedError) console.error = originalError;
    };
  }
}
