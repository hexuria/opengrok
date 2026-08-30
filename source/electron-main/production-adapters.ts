import type {
  ElectronProductionServiceFactories,
  ProductionAccountService,
  ProductionCoordinatorService,
  ProductionDisposable,
  ProductionMcpService,
  ProductionExperimentsService,
  ProductionNotificationsService,
  ProductionServiceContext,
  ProductionSettingsService,
  ProductionTelemetryService,
  ProductionUpdateService,
} from "./main-production-services.js";
import type { MainBrowserWindow, MainEdge } from "./main.js";
import {
  createCoordinatorRendererPortIpcRegistrar,
  createProductionCoordinatorAdapter,
  type CoordinatorRendererPortIpcPorts,
  type ProductionCoordinatorAuthStatus,
  type ProductionCoordinatorPorts,
} from "./coordinator/production-provider.js";

export const ELECTRON_PRODUCTION_AREA_EVIDENCE = Object.freeze({
  secureStorage: {
    recoveredProviders: ["source/electron-main/secrets/secret-store.ts", "source/electron-main/account/cursor-machine-id.ts"],
    injectedPorts: ["electron.safeStorage"],
  },
  settings: {
    recoveredProviders: ["source/shared/node/settings/sand-settings-store.ts", "source/electron-main/prefs/theme-controller.ts"],
    injectedPorts: ["electron.nativeTheme"],
  },
  attachmentGateway: {
    recoveredProviders: ["source/host/extensions/attachments/attachments-service.ts", "source/electron-main/attachments/attachments.ts", "source/electron-main/attachments/attachment-manager.ts", "source/shared/link-preview-policy.ts"],
    injectedPorts: ["ProductionServiceContext.coordinatorLegs.legs", "electron.app", "electron.BrowserWindow", "electron.dialog", "electron.nativeImage"],
  },
  avatarImages: {
    recoveredProviders: ["source/electron-main/media/avatar-images.ts", "source/shared/node/cursor-backend/cursor-generate-image.ts"],
    injectedPorts: ["electron.dialog", "electron.BrowserWindow", "electron.nativeImage", "ProductionServiceContext.requireAccount", "ProductionServiceContext.machineId"],
  },
  cursorAccount: {
    recoveredProviders: ["source/electron-main/account/cursor-auth-wiring.ts", "source/electron-main/account/access.ts", "source/electron-main/account/cursor-avatar.ts", "source/electron-main/account/cursor-profile.ts", "source/electron-main/account/cursor-pr-review.ts"],
    injectedPorts: ["ProductionServiceContext.requireAccount", "ProductionServiceContext.requireMcp", "ProductionServiceContext.requireExperiments", "generated Dashboard clients"],
  },
  mainRpc: {
    recoveredProviders: ["source/electron-main/main-edge.ts", "source/electron-main/main-edge-wiring.ts", "source/electron-main/adapters/main-rpc.ts", "source/shared/rpc/main.ts"],
    injectedPorts: ["electron.ipcMain (zero-input provider)", "ProductionServiceContext live service readers", "ProductionServiceContext trusted WebContents/broadcast"],
  },
  updaterInstaller: {
    recoveredProviders: ["source/electron-main/update/update-wiring.ts", "source/electron-main/update/sand-update-service.ts", "source/electron-main/update/win32-installer.ts"],
    injectedPorts: ["electron.autoUpdater", "electron.powerMonitor", "platform signature verifier"],
  },
  mediaProtocol: {
    recoveredProviders: ["source/electron-main/media/media-protocol.ts"],
    injectedPorts: ["electron.protocol", "coordinator attachment reader"],
  },
  accountOAuth: {
    recoveredProviders: ["source/electron-main/account/cursor-auth.ts", "source/electron-main/account/cursor-auth-wiring.ts", "source/electron-main/account/account-authorization.ts"],
    injectedPorts: ["generated account/backend clients", "OAuth browser callback environment"],
  },
  experiments: {
    recoveredProviders: ["source/electron-main/experiments/experiments-runtime.ts", "source/shared/node/experiments/statsig-bootstrap.ts"],
    injectedPorts: ["@statsig/js-client", "authenticated backend token provider"],
  },
  mcpOAuth: {
    recoveredProviders: ["source/electron-main/mcp/mcp-runtime.ts", "source/electron-main/mcp/mcp-desktop.ts", "source/electron-main/mcp/desktop-mcp-manager.ts"],
    injectedPorts: ["generated MCP/backend clients", "OAuth loopback listener"],
  },
  telemetry: {
    recoveredProviders: ["source/electron-main/telemetry/desktop-structured-log-telemetry.ts", "source/electron-main/telemetry/telemetry-report-pipes.ts", "source/electron-main/telemetry/telemetry-report-sinks.ts"],
    injectedPorts: ["generated AnalyticsService client", "packaged Sentry SDK"],
  },
  notifications: {
    recoveredProviders: ["source/electron-main/notifications/os-notification-manager.ts", "source/electron-main/notifications/dock-badge-manager.ts", "source/electron-main/notifications/agents-control-feed.ts"],
    injectedPorts: ["electron.Notification", "electron.app.setBadgeCount"],
  },
  coordinator: {
    recoveredProviders: ["source/electron-main/coordinator/production-provider.ts", "source/electron-main/coordinator/coordinator-runtime.ts", "source/electron-main/coordinator/coordinator-launcher.ts", "source/electron-main/coordinator/coordinator-main-legs.ts", "source/electron-main/coordinator/coordinator-control-server.ts"],
    injectedPorts: ["electron.utilityProcess", "electron.MessageChannelMain", "dist/node-agent-coordinator/main.cjs"],
  },
  ipc: {
    recoveredProviders: ["source/electron-main/prefs/settings-ipc.ts", "source/electron-main/experiments/experiments-ipc.ts", "source/electron-main/secrets/secrets-ipc.ts", "source/electron-main/collections/collections-ipc.ts", "source/electron-main/collections/collections-store.ts", "source/electron-main/collections/collections-window.ts", "source/electron-main/mcp/mcp-desktop.ts", "source/electron-main/coordinator/production-provider.ts", "source/electron-main/production-ipc-contract.ts"],
    injectedPorts: ["electron.ipcMain", "generated typed-RPC contract/transport"],
  },
} as const);

/**
 * The shipped main bundle owns the order in which these first-party areas are
 * composed.  Concrete generated clients, packaged modules and Electron ABI
 * values remain injected at this boundary; this file does not manufacture
 * successful services for an absent binding.
 */
export interface ElectronProductionAdapterBindings {
  readonly secureStorage: {
    initialize(): void;
    getMachineId(): Promise<string>;
  };
  readonly settings: {
    create(args: Parameters<ElectronProductionServiceFactories["createSettings"]>[0]): ProductionSettingsService;
  };
  readonly attachmentGateway: {
    create(context: Omit<ProductionServiceContext, "attachments" | "avatarImages" | "cursorAccount" | "ensureTranscriptionManager">): unknown;
  };
  readonly avatarImages: {
    create(context: Omit<ProductionServiceContext, "attachments" | "avatarImages" | "cursorAccount" | "ensureTranscriptionManager">): unknown;
  };
  readonly cursorAccount: {
    create(context: Omit<ProductionServiceContext, "attachments" | "avatarImages" | "cursorAccount" | "ensureTranscriptionManager">): unknown;
    createTranscriptionManager(context: Omit<ProductionServiceContext, "attachments" | "avatarImages" | "cursorAccount" | "ensureTranscriptionManager">): () => Promise<unknown>;
  };
  readonly mainRpc: {
    create(context: ProductionServiceContext): MainEdge & Partial<ProductionDisposable>;
  };
  readonly updaterInstaller: {
    create(context: ProductionServiceContext): Promise<ProductionUpdateService> | ProductionUpdateService;
    killLocalExecDaemon?(): Promise<void>;
  };
  readonly mediaProtocol: {
    registerScheme(): void;
    register(context: ProductionServiceContext): ProductionDisposable;
  };
  readonly accountOAuth: {
    create(context: ProductionServiceContext): Promise<ProductionAccountService> | ProductionAccountService;
  };
  readonly experiments: {
    create(context: ProductionServiceContext): Promise<ProductionExperimentsService> | ProductionExperimentsService;
  };
  readonly mcpOAuth: {
    create(context: ProductionServiceContext): Promise<ProductionMcpService> | ProductionMcpService;
  };
  readonly telemetry: {
    create(context: ProductionServiceContext): Promise<ProductionTelemetryService> | ProductionTelemetryService;
  };
  readonly notifications: {
    create(context: ProductionServiceContext): ProductionNotificationsService;
  };
  readonly coordinator: {
    create(context: ProductionServiceContext): Promise<ProductionCoordinatorService> | ProductionCoordinatorService;
  };
  readonly ipc: {
    register(context: ProductionServiceContext): ProductionDisposable;
  };
  /** Built-in process-lifetime image context-menu registration; not a manifest slot. */
  readonly imageContextMenu?: {
    register(deps: { readonly openExternalUrl: (url: string) => Promise<unknown>; readonly onEdgeFailure: (failure: { readonly leg: string; readonly errorClass: string }) => void }): void;
  };
  readonly windowLifecycle?: {
    onWindowCreated(window: MainBrowserWindow, context: ProductionServiceContext): void;
  };
}

export interface ElectronProductionCoordinatorBindingParts {
  readonly coordinatorPorts: ProductionCoordinatorPorts<ProductionCoordinatorAuthStatus>;
  readonly rendererPortIpc: Omit<CoordinatorRendererPortIpcPorts, "requestRendererPort">;
}

/**
 * The immutable root creates coordinator and renderer IPC ports after the
 * service context exists.  A manifest may therefore export this lazy owner;
 * the composition seam resolves it once and shares the result across create
 * and register calls.
 */
export interface ElectronProductionCoordinatorBinding {
  readonly coordinatorPorts?: ProductionCoordinatorPorts<ProductionCoordinatorAuthStatus>;
  readonly rendererPortIpc?: Omit<CoordinatorRendererPortIpcPorts, "requestRendererPort">;
  readonly create?: (context: ProductionServiceContext) => ElectronProductionCoordinatorBindingParts;
}

export type ElectronProductionCoordinatorBindingValue =
  | ElectronProductionCoordinatorBinding
  | (() => ElectronProductionCoordinatorBinding);

/**
 * Makes the recovered coordinator provider part of the production executable
 * graph while leaving every Electron, generated-client and executable port at
 * the manifest boundary. The coordinator request handler is registered inside
 * the normal IPC phase, which runs after the coordinator service has started.
 */
export function composeElectronProductionCoordinatorBindings(
  binding: ElectronProductionCoordinatorBindingValue,
  mainIpc: ElectronProductionAdapterBindings["ipc"],
): Pick<ElectronProductionAdapterBindings, "coordinator" | "ipc"> {
  const manifestBinding = typeof binding === "function" ? binding() : binding;
  if (manifestBinding == null || (manifestBinding.create == null && (manifestBinding.coordinatorPorts == null || manifestBinding.rendererPortIpc == null))) {
    throw new Error("Incomplete Electron production coordinator binding.");
  }
  if (mainIpc == null || typeof mainIpc.register !== "function") {
    throw new Error("Incomplete Electron production main IPC binding: register.");
  }
  let resolvedContext: ProductionServiceContext | undefined;
  let resolved: ElectronProductionCoordinatorBindingParts | undefined;
  let coordinator: ReturnType<typeof createProductionCoordinatorAdapter> | undefined;
  let coordinatorIpc: ReturnType<typeof createCoordinatorRendererPortIpcRegistrar> | undefined;
  const resolve = (context: ProductionServiceContext): {
    readonly coordinator: ReturnType<typeof createProductionCoordinatorAdapter>;
    readonly coordinatorIpc: ReturnType<typeof createCoordinatorRendererPortIpcRegistrar>;
  } => {
    if (resolvedContext === context && resolved !== undefined && coordinator !== undefined && coordinatorIpc !== undefined) {
      return { coordinator, coordinatorIpc };
    }
    if (resolvedContext !== undefined && resolvedContext !== context) {
      throw new Error("Electron production coordinator binding was resolved for more than one context.");
    }
    const next = manifestBinding.create?.(context) ?? {
      coordinatorPorts: manifestBinding.coordinatorPorts!,
      rendererPortIpc: manifestBinding.rendererPortIpc!,
    };
    if (next == null || next.coordinatorPorts == null || next.rendererPortIpc == null) {
      throw new Error("Incomplete Electron production coordinator binding after context resolution.");
    }
    const nextCoordinator = createProductionCoordinatorAdapter(next.coordinatorPorts);
    const nextCoordinatorIpc = createCoordinatorRendererPortIpcRegistrar({
      ...next.rendererPortIpc,
      requestRendererPort: nextCoordinator.requestRendererPort,
    });
    resolvedContext = context;
    resolved = next;
    coordinator = nextCoordinator;
    coordinatorIpc = nextCoordinatorIpc;
    return { coordinator: nextCoordinator, coordinatorIpc: nextCoordinatorIpc };
  };
  return {
    coordinator: { create: (context) => resolve(context).coordinator.create(context) },
    ipc: {
      register(context) {
        const { coordinatorIpc: registrar } = resolve(context);
        const coordinatorRegistration = registrar.register(context);
        if (coordinatorRegistration == null || typeof coordinatorRegistration.dispose !== "function") {
          throw new Error("Coordinator renderer-port IPC did not provide dispose().");
        }
        let mainRegistration: ProductionDisposable;
        try {
          mainRegistration = mainIpc.register(context);
          if (mainRegistration == null || typeof mainRegistration.dispose !== "function") {
            throw new Error("Electron production main IPC did not provide dispose().");
          }
        } catch (error) {
          try {
            coordinatorRegistration.dispose();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Electron production IPC registration and rollback both failed.");
          }
          throw error;
        }
        return {
          async dispose() {
            const failures: unknown[] = [];
            try { await mainRegistration.dispose(); } catch (error) { failures.push(error); }
            try { await coordinatorRegistration.dispose(); } catch (error) { failures.push(error); }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) throw new AggregateError(failures, "Electron production IPC cleanup failed.");
          },
        };
      },
    },
  };
}

export function createElectronProductionServiceFactories(
  adapters: ElectronProductionAdapterBindings,
): ElectronProductionServiceFactories {
  const requirements: Readonly<Record<keyof ElectronProductionAdapterBindings, readonly string[]>> = {
    secureStorage: ["initialize", "getMachineId"], settings: ["create"], attachmentGateway: ["create"], avatarImages: ["create"], cursorAccount: ["create", "createTranscriptionManager"], mainRpc: ["create"],
    updaterInstaller: ["create"], mediaProtocol: ["registerScheme", "register"], accountOAuth: ["create"],
    experiments: ["create"], mcpOAuth: ["create"], telemetry: ["create"], notifications: ["create"], coordinator: ["create"],
    ipc: ["register"], windowLifecycle: ["onWindowCreated"], imageContextMenu: ["register"],
  };
  for (const [area, methods] of Object.entries(requirements) as Array<[keyof ElectronProductionAdapterBindings, readonly string[]]>) {
    const adapter = adapters[area];
    if ((area === "windowLifecycle" || area === "imageContextMenu") && adapter == null) continue;
    if (adapter == null) throw new Error(`Incomplete Electron production adapter graph: ${area}.`);
    const missing = methods.filter((method) => typeof (adapter as unknown as Record<string, unknown>)[method] !== "function");
    if (missing.length > 0) throw new Error(`Incomplete Electron production adapter ${area}: ${missing.join(", ")}.`);
  }
  return {
    initializeSecureStorage: () => adapters.secureStorage.initialize(),
    getMachineId: () => adapters.secureStorage.getMachineId(),
    createSettings: (args) => adapters.settings.create(args),
    createAttachments: (context) => adapters.attachmentGateway.create(context),
    createAvatarImages: (context) => adapters.avatarImages.create(context),
    createCursorAccount: (context) => adapters.cursorAccount.create(context),
    createTranscriptionManager: (context) => adapters.cursorAccount.createTranscriptionManager(context),
    createMainEdge: (context) => adapters.mainRpc.create(context),
    createUpdate: (context) => adapters.updaterInstaller.create(context),
    registerMediaScheme: () => adapters.mediaProtocol.registerScheme(),
    registerMedia: (context) => adapters.mediaProtocol.register(context),
    createAccount: (context) => adapters.accountOAuth.create(context),
    createExperiments: (context) => adapters.experiments.create(context),
    createMcp: (context) => adapters.mcpOAuth.create(context),
    createTelemetry: (context) => adapters.telemetry.create(context),
    createNotifications: (context) => adapters.notifications.create(context),
    createCoordinator: (context) => adapters.coordinator.create(context),
    registerIpc: (context) => adapters.ipc.register(context),
    ...(adapters.updaterInstaller.killLocalExecDaemon == null ? {} : {
      killLocalExecDaemon: () => adapters.updaterInstaller.killLocalExecDaemon!(),
    }),
    ...(adapters.windowLifecycle == null ? {} : {
      onWindowCreated: (window, context) => adapters.windowLifecycle!.onWindowCreated(window, context),
    }),
    ...(adapters.imageContextMenu == null ? {} : {
      registerImageContextMenu: (deps: { readonly openExternalUrl: (url: string) => Promise<unknown>; readonly onEdgeFailure: (failure: { readonly leg: string; readonly errorClass: string }) => void }) => adapters.imageContextMenu!.register(deps),
    }),
  };
}
