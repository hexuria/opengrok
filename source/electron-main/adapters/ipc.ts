import type { ElectronProductionAdapterBindings } from "../production-adapters.js";
import type { ProductionDisposable, ProductionServiceContext } from "../main-production-services.js";
import { registerExperimentsIpc } from "../experiments/experiments-ipc.js";
import { registerSettingsIpc } from "../prefs/settings-ipc.js";
import { createTrustedSenderGuards, registerSecretsIpc } from "../secrets/secrets-ipc.js";
import { createProductionCollectionsIpcRegistrar } from "../collections/collections-ipc.js";
import { reportDesktopEdgeFailure } from "../desktop-edge-failures.js";
import { requireDisposable, requireFunction, requireObject } from "./provider-guards.js";

type Handler = (...args: any[]) => unknown;
export interface ProductionIpcMainPort {
  handle(channel: string, listener: Handler): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: Handler): void;
  removeListener(channel: string, listener: Handler): void;
}

export interface ElectronProductionIpcMainSource {
  readonly ipcMain: ProductionIpcMainPort;
}

/** Process-owned Electron carrier; listeners remain owned by the registrar. */
export function createElectronProductionIpcMainBinding(
  electron: ElectronProductionIpcMainSource = require("electron") as ElectronProductionIpcMainSource,
): ProductionIpcMainPort {
  const ipcMain = electron?.ipcMain;
  requireObject(ipcMain, "electron.ipcMain");
  for (const method of ["handle", "removeHandler", "on", "removeListener"] as const) requireFunction(ipcMain[method], `electron.ipcMain.${method}`);
  return ipcMain;
}
export interface ScopedProductionIpcPort {
  handle(channel: string, listener: Handler): void;
  on(channel: string, listener: Handler): void;
}
export type ProductionIpcRegistrar = (
  context: ProductionServiceContext,
  ipc: ScopedProductionIpcPort,
) => void | ProductionDisposable;

/** Exact process-owned secrets registration used by the shared IPC registrar. */
export function createProductionSecretsIpcRegistrar(): ProductionIpcRegistrar {
  return (context, ipc) => {
    registerSecretsIpc({
      ipcMain: ipc,
      guards: createTrustedSenderGuards(context.getTrustedContents),
      stores: context.secretsStores,
      pushBoxSecrets: () => context.secretsStores.pushBoxSecrets.push("edit"),
    });
  };
}

/** Exact one-channel experiments registration; the root owns the service lookup. */
export function createProductionExperimentsIpcRegistrar(): ProductionIpcRegistrar {
  return (context, ipc) => {
    registerExperimentsIpc({
      ipcMain: ipc,
      getExperimentService: () => context.requireExperiments(),
    });
  };
}

/** Exact four-channel settings registration after the root egress controller exists. */
export function createProductionSettingsIpcRegistrar(): ProductionIpcRegistrar {
  return (context, ipc) => {
    registerSettingsIpc({
      ipcMain: ipc,
      settingsStore: context.settings.settingsStore,
      themeController: context.settings.getThemeController(),
      egressTunnelController: context.requireEgressTunnelController(),
    });
  };
}

/** Exact ten-channel Collections registration; the window itself is the trusted sender. */
export function createProductionCollectionsRegistrar(): ProductionIpcRegistrar {
  const registrar = createProductionCollectionsIpcRegistrar();
  return (context, ipc) => registrar(context, ipc);
}

export interface ProductionIpcPorts {
  readonly ipcMain?: ProductionIpcMainPort;
  /** The shipped main root owns these listeners for the process lifetime. */
  readonly processOwned?: boolean;
  /**
   * The shipped telemetry sink is registered directly by the root before this
   * registrar. It remains injectable for isolated composition tests and for
   * callers that own the telemetry phase themselves.
   */
  readonly telemetry?: ProductionIpcRegistrar;
  readonly experiments?: ProductionIpcRegistrar;
  readonly settings?: ProductionIpcRegistrar;
  readonly secrets?: ProductionIpcRegistrar;
  readonly collections?: ProductionIpcRegistrar;
  readonly mcp: ProductionIpcRegistrar;
  readonly reportFailure: (stage: "rollback", error: unknown) => void;
}

interface RegisteredListener { readonly kind: "handle" | "on"; readonly channel: string; readonly listener: Handler }

/**
 * Artifact anchors: main.cjs:506609 coordinator handle, 506646 telemetry sinks,
 * 506703 experiments, 506722 settings, 506728 secrets, 506734 MCP.
 */
export function createProductionIpcAdapter(
  ports: ProductionIpcPorts,
): ElectronProductionAdapterBindings["ipc"] {
  const ipcMain = ports?.ipcMain ?? createElectronProductionIpcMainBinding();
  requireObject(ipcMain, "ipc.ipcMain");
  for (const method of ["handle", "removeHandler", "on", "removeListener"] as const) requireFunction(ipcMain[method], `ipc.ipcMain.${method}`);
  const ordered = ports.telemetry == null
    ? ["experiments", "settings", "secrets", "collections", "mcp"] as const
    : ["telemetry", "experiments", "settings", "secrets", "collections", "mcp"] as const;
  const registrars = {
    ...ports,
    experiments: ports.experiments ?? createProductionExperimentsIpcRegistrar(),
    settings: ports.settings ?? createProductionSettingsIpcRegistrar(),
    secrets: ports.secrets ?? createProductionSecretsIpcRegistrar(),
    collections: ports.collections ?? createProductionCollectionsRegistrar(),
  };
  for (const name of ordered) requireFunction(registrars[name], `ipc.${name}`);
  requireFunction(ports.reportFailure, "ipc.reportFailure");
  let active = false;
  return {
    register(context) {
      if (active) throw new Error("Electron production IPC is already registered.");
      active = true;
      const seen = new Set<string>();
      const cleanupSteps: Array<() => void | Promise<void>> = [];
      const removeTracked = (entry: RegisteredListener): void => {
        if (entry.kind === "handle") ipcMain.removeHandler(entry.channel);
        else ipcMain.removeListener(entry.channel, entry.listener);
      };
      const rollback = async (): Promise<void> => {
        active = false;
        const failures: unknown[] = [];
        for (const cleanup of [...cleanupSteps].reverse()) { try { await cleanup(); } catch (error) { failures.push(error); } }
        cleanupSteps.length = 0;
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Electron production IPC rollback failed.");
      };
      try {
        for (const name of ordered) {
          const scoped: ScopedProductionIpcPort = {
            handle(channel, listener) {
              if (seen.has(channel)) throw new Error(`Electron production IPC channel registered twice: ${channel}.`);
              seen.add(channel);
              ipcMain.handle(channel, listener);
              cleanupSteps.push(() => removeTracked({ kind: "handle", channel, listener }));
            },
            on(channel, listener) {
              if (seen.has(channel)) throw new Error(`Electron production IPC channel registered twice: ${channel}.`);
              seen.add(channel);
              ipcMain.on(channel, listener);
              cleanupSteps.push(() => removeTracked({ kind: "on", channel, listener }));
            },
          };
          const registrar = registrars[name];
          if (typeof registrar !== "function") throw new TypeError(`Missing Electron production IPC registrar: ipc.${name}.`);
          const custom = registrar(context, scoped);
          if (custom != null) {
            const disposable = requireDisposable(custom, `ipc.${name}.registration`);
            cleanupSteps.push(() => disposable.dispose());
          }
        }
      } catch (error) {
        void rollback().catch((cleanupError: unknown) => ports.reportFailure("rollback", cleanupError));
        throw error;
      }
      let disposed = false;
      return {
        async dispose() {
          if (disposed) return;
          disposed = true;
          if (ports.processOwned === true) return;
          await rollback();
        },
      };
    },
  };
}

/**
 * Zero-input production join for the immutable post-telemetry IPC phase.
 * Electron's ipcMain is the only native input; telemetry is intentionally
 * omitted because the root has already installed its process-owned sinks.
 */
export function createElectronProductionIpcBinding(
  electron?: ElectronProductionIpcMainSource,
): ElectronProductionAdapterBindings["ipc"] {
  const ipcMain = createElectronProductionIpcMainBinding(electron);
  return createProductionIpcAdapter({
    ipcMain,
    processOwned: true,
    mcp: (context, ipc) => {
      const service = context.requireMcp() as unknown as {
        registerDesktopIpc?: (value: ScopedProductionIpcPort) => ProductionDisposable;
      };
      if (typeof service.registerDesktopIpc !== "function") throw new TypeError("Electron production MCP service does not expose registerDesktopIpc().");
      return service.registerDesktopIpc(ipc);
    },
    reportFailure: (stage, error) => reportDesktopEdgeFailure("ipc", stage, error),
  });
}
