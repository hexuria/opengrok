import { randomUUID } from "node:crypto";
import { release as osRelease } from "node:os";
import { AiService } from "../../packages/proto/generated/aiserver/v1/aiserver_connect.js";
import { createSandCursorBackendClient } from "../../shared/node/cursor-backend/cursor-inference.js";
import { readLocalExecDaemonDiscovery } from "../../host/local-exec/local-exec-daemon-protocol.js";
import { isProcessAlive } from "../local-exec/local-exec-native.js";
import { SandProcessMetricsCollector, type SandProcessMetricsConfig } from "./collector.js";
import { SandClientNumericMetricsManager } from "./cursor-client-numeric-metrics.js";
import { createFlushCoalescer } from "./heap-metrics-ingest.js";
import { createNativeProcessScan } from "./native-scan.js";
import { SandProcessMetricsReporter } from "./transport.js";
import { resolveScanRoots } from "./wiring.js";
import type { ProcessScanTuple } from "./sampler.js";

interface AuthService { getValidAccessToken(options?: { readonly backendUrl?: string }): Promise<string> }
interface ExperimentService {
  checkFeatureGate(name: string): boolean;
  getDynamicConfig(name: string): SandProcessMetricsConfig;
  subscribe(listener: () => void): () => void;
}
interface DisposableNumericMetrics { flush(): Promise<void>; dispose(): void }
interface DisposableCollector { start(): void; dispose(): void }

export interface DesktopMetricsRuntimeDeps {
  readonly ensureCursorAuthService: () => Promise<AuthService>;
  readonly ensureExperimentService: () => Promise<ExperimentService>;
  readonly getMachineId: () => string | Promise<string>;
  readonly getClientVersion: () => string;
  readonly isQuitting: () => boolean;
  readonly createNumericMetricsClient?: (auth: AuthService) => { reportClientNumericMetrics(request: unknown): Promise<unknown> };
  readonly createProcessMetricsClient?: (auth: AuthService) => { reportSandProcessMetrics(request: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown> };
  readonly createNumericMetricsManager?: (options: ConstructorParameters<typeof SandClientNumericMetricsManager>[0]) => DisposableNumericMetrics;
  readonly createCollector?: (options: ConstructorParameters<typeof SandProcessMetricsCollector>[0]) => DisposableCollector;
  readonly createNativeScan?: () => ReturnType<typeof createNativeProcessScan>;
  readonly readDaemonDiscovery?: () => Promise<{ readonly pid?: unknown } | null | undefined>;
  readonly processId?: number;
  readonly processPlatform?: NodeJS.Platform;
  readonly processArch?: string;
  readonly osRelease?: () => string;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly sessionId?: () => string;
  readonly reportFailure?: (subsystem: string, leg: string, error: unknown) => void;
}

export interface DesktopMetricsRuntime {
  ensureClientNumericMetricsManager(): Promise<DisposableNumericMetrics>;
  ensureSandProcessMetricsCollector(experiments: ExperimentService): void;
  disposeProcessMetricsCollector(): void;
  takeClientNumericMetricsManager(): DisposableNumericMetrics | undefined;
  requestHeapMetricsFlush(): void;
}

export function createDesktopMetricsRuntime(deps: DesktopMetricsRuntimeDeps): DesktopMetricsRuntime {
  let clientNumericMetricsManager: DisposableNumericMetrics | undefined;
  let clientNumericMetricsManagerInit: Promise<DisposableNumericMetrics> | undefined;
  let requestHeapFlush: (() => void) | undefined;
  let sandProcessMetricsCollector: DisposableCollector | undefined;

  async function ensureClientNumericMetricsManager(): Promise<DisposableNumericMetrics> {
    if (clientNumericMetricsManagerInit == null) {
      clientNumericMetricsManagerInit = (async () => {
        const authService = await deps.ensureCursorAuthService();
        const experiments = await deps.ensureExperimentService();
        const createManager = deps.createNumericMetricsManager ?? ((options) => new SandClientNumericMetricsManager(options));
        const manager = createManager({
          isFlushEnabled: () => experiments.checkFeatureGate("client_numeric_metrics"),
          clientVersion: deps.getClientVersion(),
          createClient: () => deps.createNumericMetricsClient?.(authService) ?? createSandCursorBackendClient(AiService, {
            getAccessToken: (request) => authService.getValidAccessToken(request),
            getMachineId: () => deps.getMachineId(),
          }) as unknown as { reportClientNumericMetrics(request: unknown): Promise<unknown> },
          reportFailure: (leg, error) => deps.reportFailure?.("numeric-metrics", leg, error),
        });
        if (deps.isQuitting()) { manager.dispose(); return manager; }
        clientNumericMetricsManager = manager;
        requestHeapFlush = createFlushCoalescer(() => manager.flush(), (error) => deps.reportFailure?.("numeric-metrics", "heap-flush", error));
        return manager;
      })();
      void clientNumericMetricsManagerInit.catch(() => { clientNumericMetricsManagerInit = undefined; });
    }
    return clientNumericMetricsManagerInit;
  }

  function ensureSandProcessMetricsCollector(experiments: ExperimentService): void {
    if (sandProcessMetricsCollector != null) return;
    let nativeScan: ReturnType<typeof createNativeProcessScan> | undefined;
    let reporter: SandProcessMetricsReporter | undefined;
    const createCollector = deps.createCollector ?? ((options) => new SandProcessMetricsCollector(options));
    const collector = createCollector({
      getConfig: () => experiments.getDynamicConfig("sand_process_metrics"),
      scan: async () => {
        nativeScan ??= deps.createNativeScan?.() ?? createNativeProcessScan();
        const roots = await resolveScanRoots(
          deps.processId ?? process.pid,
          deps.readDaemonDiscovery ?? (() => readLocalExecDaemonDiscovery()),
          deps.isPidAlive ?? isProcessAlive,
        );
        return await nativeScan(roots) as ProcessScanTuple[];
      },
      reporter: {
        report: async (sample, signal) => {
          if (reporter == null) {
            const auth = await deps.ensureCursorAuthService();
            reporter = new SandProcessMetricsReporter({
              client: deps.createProcessMetricsClient?.(auth) ?? createSandCursorBackendClient(AiService, {
                getAccessToken: (request) => auth.getValidAccessToken(request),
                getMachineId: () => deps.getMachineId(),
              }) as unknown as { reportSandProcessMetrics(request: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown> },
              meta: {
                os: deps.processPlatform ?? process.platform,
                osVersion: (deps.osRelease ?? osRelease)(),
                arch: deps.processArch ?? process.arch,
                clientVersion: deps.getClientVersion(),
                clientId: await deps.getMachineId(),
              },
            });
          }
          await reporter.report(sample, signal);
        },
      },
      onConfigChange: (listener) => experiments.subscribe(listener),
      sessionId: deps.sessionId?.() ?? randomUUID(),
      ...(deps.reportFailure === undefined ? {} : { reportEdgeFailure: deps.reportFailure }),
    });
    if (deps.isQuitting()) { collector.dispose(); return; }
    collector.start();
    sandProcessMetricsCollector = collector;
  }

  return {
    ensureClientNumericMetricsManager,
    ensureSandProcessMetricsCollector,
    disposeProcessMetricsCollector: () => { sandProcessMetricsCollector?.dispose(); sandProcessMetricsCollector = undefined; },
    takeClientNumericMetricsManager: () => {
      const manager = clientNumericMetricsManager;
      clientNumericMetricsManager = undefined;
      requestHeapFlush = undefined;
      return manager;
    },
    requestHeapMetricsFlush: () => requestHeapFlush?.(),
  };
}
