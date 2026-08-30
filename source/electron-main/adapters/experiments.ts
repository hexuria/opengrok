import { createExperimentsRuntime, type DesktopAuthService, type DesktopExperimentService } from "../experiments/experiments-runtime.js";
import type { ElectronProductionAdapterBindings } from "../production-adapters.js";
import type { ProductionServiceContext } from "../main-production-services.js";
import { SandExperimentService } from "../../shared/node/experiments/cursor-experiments.js";
import { startSandRpcTraceWindow } from "../../shared/node/cursor-backend/rpc-tracing.js";
import { requireFunction } from "./provider-guards.js";

export interface ProductionExperimentsPorts {
  readonly getAuthService: (context: ProductionServiceContext) => Promise<DesktopAuthService> | DesktopAuthService;
  readonly pushFeatureFlagOverrides: (context: ProductionServiceContext, overrides: Record<string, unknown>) => Promise<unknown>;
  readonly reportEdgeFailure: (surface: string, stage: string, error: unknown) => void;
}

/** Artifact anchor: main.cjs:506018, `var experimentsRuntime = createExperimentsRuntime({`. */
export function createProductionExperimentsAdapter(
  ports: ProductionExperimentsPorts,
): ElectronProductionAdapterBindings["experiments"] {
  requireFunction(ports?.getAuthService, "experiments.getAuthService");
  requireFunction(ports?.pushFeatureFlagOverrides, "experiments.pushFeatureFlagOverrides");
  requireFunction(ports?.reportEdgeFailure, "experiments.reportEdgeFailure");
  return {
    async create(context) {
      const runtime = createExperimentsRuntime({
        ensureCursorAuthService: async () => await ports.getAuthService(context),
        getMachineId: async () => context.machineId,
        getCacheDir: () => context.native.app.getPath("userData"),
        isDevBuild: context.env.SAND_PACKAGED !== "1",
        createExperimentService: (options) => new SandExperimentService(options),
        emitSnapshotChanged: (snapshot) => context.requireMainEdge().emit("experiments-changed", snapshot),
        pushFeatureFlagOverrides: (overrides) => ports.pushFeatureFlagOverrides(context, overrides),
        reportEdgeFailure: ports.reportEdgeFailure,
      });
      let service: DesktopExperimentService | undefined;
      let ensurePromise: Promise<DesktopExperimentService> | undefined;
      const listeners = new Set<() => void>();
      const ensureService = async (): Promise<DesktopExperimentService> => {
        if (service != null) return service;
        ensurePromise ??= runtime.ensureExperimentService().then((created) => {
          service = created;
          for (const listener of listeners) created.subscribe(() => listener());
          return created;
        });
        return await ensurePromise;
      };
      let disposed = false;
      return {
        async ensureService() {
          if (disposed) throw new Error("Electron production experiments adapter is disposed.");
          const created = await ensureService();
          return {
            getSnapshot: () => created.getSnapshot(),
            applyFeatureFlagOverrideCommand: (command: unknown) => created.applyFeatureFlagOverrideCommand(command as Parameters<DesktopExperimentService["applyFeatureFlagOverrideCommand"]>[0]),
            refreshNow: () => created.refreshNow(),
          };
        },
        isTelemetryDisabled() { return process.env.SAND_DISABLE_TELEMETRY === "1"; },
        startRpcTraceWindow() { return startSandRpcTraceWindow(); },
        getComputerUseModelOverride() { return service?.getComputerUseModelOverride(); },
        subscribe(listener: () => void) {
          listeners.add(listener);
          if (service != null) {
            const unsubscribe = service.subscribe(() => listener());
            return () => { listeners.delete(listener); unsubscribe(); };
          }
          return () => { listeners.delete(listener); };
        },
        getSnapshot() { return service?.getSnapshot() ?? {}; },
        getFeatureFlagOverridesRecord() { return service?.getFeatureFlagOverridesRecord() ?? {}; },
        checkFeatureGate(name: string) { return service?.checkFeatureGate(name) ?? false; },
        getDynamicConfig(name: string) { return service?.getDynamicConfig(name) ?? {}; },
        hasLiveStatsigBootstrap() { return service?.hasLiveStatsigBootstrap() ?? false; },
        getFlagsAgeMs() { return service?.getFlagsAgeMs(); },
        async dispose() {
          if (disposed) return;
          disposed = true;
          listeners.clear();
          await ensurePromise?.then((created) => created.dispose());
          await runtime.dispose();
        },
      };
    },
  };
}
