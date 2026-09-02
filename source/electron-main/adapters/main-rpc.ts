import { serveMainEdge, type MainEdgeWiringDeps } from "../main-edge-wiring.js";
import {
  MAIN_METHOD_TABLE,
  mainRpcContract,
  serveEdge as generatedServeEdge,
} from "../generated/main-rpc.js";
import type { MainEdge } from "../main.js";
import type { ElectronProductionAdapterBindings } from "../production-adapters.js";
import type { ProductionDisposable, ProductionServiceContext } from "../main-production-services.js";
import { addCollectionMessagesFromApp, listCollectionsFromApp, openCollectionsFromApp } from "../collections/collections-ipc.js";
import { createElectronProductionIpcMainBinding, type ElectronProductionIpcMainSource } from "./ipc.js";
import { requireFunction, requireObject } from "./provider-guards.js";

type ExistingMainRpcCoreDeps = Pick<MainEdgeWiringDeps,
  "settingsStore"
  | "agentPrefsStore"
  | "boxToggleStore"
  | "onboardingSeen"
  | "shell"
  | "boxRecovery"
  | "windowChrome"
  | "syncHostSettingsToBox"
  | "broadcast"
  | "platform"
  | "avatarImages"
  | "attachments"
  | "cursorAccount"
  | "ensureTranscriptionManager"
  | "fetchAvailableModels"
  | "recordLocalToolApproval"
  | "clearLocalToolApprovals"
  | "experiments"
  | "getComputerUseModelOverride"
  | "revealSecret"
  | "clearAgentImageMetadata"
>;

type MainRpcResolverDeps = Omit<MainEdgeWiringDeps,
  keyof ExistingMainRpcCoreDeps
  | "serveEdge"
  | "mainRpcContract"
  | "mainMethodTable"
> & Partial<Pick<MainEdgeWiringDeps,
  keyof ExistingMainRpcCoreDeps
  | "serveEdge"
  | "mainRpcContract"
  | "mainMethodTable"
>>;

export interface ProductionMainRpcPorts {
  readonly resolveDeps: (
    context: ProductionServiceContext,
  ) => MainRpcResolverDeps;
}

/**
 * Zero-input root join for the immutable MainEdge constructor. The generated
 * serve/contract/table defaults remain local to this adapter; Electron's
 * ipcMain is the only native input and may be substituted only by tests.
 */
export function createElectronProductionMainRpcBinding(
  electron?: ElectronProductionIpcMainSource,
): ElectronProductionAdapterBindings["mainRpc"] {
  const ipcMain = createElectronProductionIpcMainBinding(electron);
  return createProductionMainRpcAdapter({
    resolveDeps(context) {
      return {
        ipcMain,
        readLiveUpdateService: () => {
          try {
            return context.requireUpdate().updateService as unknown as ReturnType<MainEdgeWiringDeps["readLiveUpdateService"]>;
          } catch {
            return null;
          }
        },
        readThemeController: () => {
          try {
            return context.settings.getThemeController() as unknown as ReturnType<MainEdgeWiringDeps["readThemeController"]>;
          } catch {
            return null;
          }
        },
        readEgressTunnelController: () => {
          try {
            return context.requireEgressTunnelController() as unknown as ReturnType<MainEdgeWiringDeps["readEgressTunnelController"]>;
          } catch {
            return null;
          }
        },
        readHostSettingsFromBox: async () => {
          const settings = await context.coordinatorResync.readHostSettings();
          if (typeof settings !== "object" || settings == null || Array.isArray(settings)) {
            throw new Error("Electron production MainEdge received an invalid host-settings response.");
          }
          return settings as Record<string, unknown>;
        },
        deleteTranscriptEntries: (args) => context.coordinatorLegs.legs.deleteTranscriptEntries!(args),
        addCollectionMessages: (args) => addCollectionMessagesFromApp(args),
        listCollections: () => listCollectionsFromApp(),
        openCollections: (collectionId?: string) => openCollectionsFromApp(collectionId),
        emitEgressTunnelChanged: (enabled) => context.requireMainEdge().emit("egress-tunnel-changed", enabled),
        emitWebauthnProxyChanged: (enabled) => context.requireMainEdge().emit("webauthn-proxy-changed", enabled),
        getTrustedContents: () => {
          const contents = context.getTrustedContents();
          return contents == null ? null : contents as unknown as NonNullable<ReturnType<MainEdgeWiringDeps["getTrustedContents"]>>;
        },
        broadcast: context.broadcast,
        platform: process.platform,
      };
    },
  });
}

function createExistingMainRpcCoreDeps(
  context: ProductionServiceContext,
  supplied: MainRpcResolverDeps,
): ExistingMainRpcCoreDeps {
  const shell = requireObject(
    supplied.shell === undefined ? context.shell : supplied.shell,
    "mainRpc.shell",
  );
  const settingsStore = requireObject(
    supplied.settingsStore === undefined ? context.settings?.settingsStore : supplied.settingsStore,
    "mainRpc.settingsStore",
  );
  const agentPrefsStore = requireObject(
    supplied.agentPrefsStore === undefined ? context.settings?.settingsStore : supplied.agentPrefsStore,
    "mainRpc.agentPrefsStore",
  );
  const boxToggleStore = requireObject(
    supplied.boxToggleStore === undefined ? context.settings?.settingsStore : supplied.boxToggleStore,
    "mainRpc.boxToggleStore",
  );
  const onboardingSeen = requireObject(
    supplied.onboardingSeen === undefined
      ? context.hostSettingsFields.onboardingSeen
      : supplied.onboardingSeen,
    "mainRpc.onboardingSeen",
  );
  const windowChrome = requireObject(
    supplied.windowChrome === undefined ? context.windowChrome : supplied.windowChrome,
    "mainRpc.windowChrome",
  );
  const boxRecovery = requireObject(
    supplied.boxRecovery === undefined ? context.boxRecovery : supplied.boxRecovery,
    "mainRpc.boxRecovery",
  ) as MainEdgeWiringDeps["boxRecovery"];
  const attachments = requireObject(
    supplied.attachments === undefined
      ? (typeof context.attachments === "object" && context.attachments != null ? context.attachments : undefined)
      : supplied.attachments,
    "mainRpc.attachments",
  );
  const avatarImages = requireObject(
    supplied.avatarImages === undefined
      ? (typeof context.avatarImages === "object" && context.avatarImages != null ? context.avatarImages : undefined)
      : supplied.avatarImages,
    "mainRpc.avatarImages",
  );
  const cursorAccount = requireObject(
    supplied.cursorAccount === undefined
      ? (typeof context.cursorAccount === "object" && context.cursorAccount != null ? context.cursorAccount : undefined)
      : supplied.cursorAccount,
    "mainRpc.cursorAccount",
  );
  const ensureTranscriptionManager = requireFunction(
    supplied.ensureTranscriptionManager === undefined ? context.ensureTranscriptionManager : supplied.ensureTranscriptionManager,
    "mainRpc.ensureTranscriptionManager",
  );
  const fetchAvailableModels = requireFunction(
    supplied.fetchAvailableModels === undefined ? context.fetchAvailableModels : supplied.fetchAvailableModels,
    "mainRpc.fetchAvailableModels",
  );
  const recordLocalToolApproval = requireFunction(
    supplied.recordLocalToolApproval === undefined ? context.recordLocalToolApproval : supplied.recordLocalToolApproval,
    "mainRpc.recordLocalToolApproval",
  );
  const clearLocalToolApprovals = requireFunction(
    supplied.clearLocalToolApprovals === undefined ? context.clearLocalToolApprovals : supplied.clearLocalToolApprovals,
    "mainRpc.clearLocalToolApprovals",
  );
  const experiments = {
    ensureService: () => context.requireExperiments().ensureService(),
    isTelemetryDisabled: () => context.requireExperiments().isTelemetryDisabled(),
    startRpcTraceWindow: () => context.requireExperiments().startRpcTraceWindow(),
  };
  const getComputerUseModelOverride = () => context.requireExperiments().getComputerUseModelOverride();
  const syncHostSettingsToBox = requireFunction(
    supplied.syncHostSettingsToBox === undefined
      ? context.coordinatorResync?.pushHostSettings
      : supplied.syncHostSettingsToBox,
    "mainRpc.syncHostSettingsToBox",
  );
  const broadcast = requireFunction(
    supplied.broadcast === undefined ? context.broadcast : supplied.broadcast,
    "mainRpc.broadcast",
  );
  const platform = supplied.platform === undefined ? process.platform : supplied.platform;
  if (typeof platform !== "string") throw new TypeError("Missing Electron production adapter port: mainRpc.platform.");
  return {
    // MainEdgeDeps models these exact shared-object slots as indexable
    // records; the assertions are erased and preserve the SandSettingsStore
    // identity used by the immutable constructor.
    settingsStore: settingsStore as unknown as MainEdgeWiringDeps["settingsStore"],
    agentPrefsStore: agentPrefsStore as unknown as MainEdgeWiringDeps["agentPrefsStore"],
    boxToggleStore: boxToggleStore as unknown as MainEdgeWiringDeps["boxToggleStore"],
    onboardingSeen: onboardingSeen as MainEdgeWiringDeps["onboardingSeen"],
    shell,
    boxRecovery,
    windowChrome,
    // The attachment gateway is an exact runtime object but its production
    // context intentionally keeps the public field opaque.
    attachments: attachments as MainEdgeWiringDeps["attachments"],
    avatarImages: avatarImages as MainEdgeWiringDeps["avatarImages"],
    cursorAccount: cursorAccount as MainEdgeWiringDeps["cursorAccount"],
    ensureTranscriptionManager: ensureTranscriptionManager as MainEdgeWiringDeps["ensureTranscriptionManager"],
    fetchAvailableModels,
    recordLocalToolApproval,
    clearLocalToolApprovals,
    experiments,
    getComputerUseModelOverride,
    syncHostSettingsToBox,
    broadcast,
    platform,
    revealSecret: async (key: string) => {
      try {
        const stores = (context as { secretsStores?: { userSecretsStore?: { reveal?: (key: string) => Promise<string | null> } } }).secretsStores;
        return await stores?.userSecretsStore?.reveal?.(key) ?? null;
      } catch { return null; }
    },
    clearAgentImageMetadata: async (args: { id: string }) => {
      const legs = (context as { coordinatorLegs?: { legs?: { clearAgentImageMetadata?: (a: unknown) => Promise<unknown> } } }).coordinatorLegs;
      return await legs?.legs?.clearAgentImageMetadata?.(args) ?? { cleared: 0 };
    },
  };
}

type ResolvedMainRpcDeps = Omit<MainEdgeWiringDeps, "serveEdge" | "mainRpcContract" | "mainMethodTable">
  & Partial<Pick<MainEdgeWiringDeps, "serveEdge" | "mainRpcContract" | "mainMethodTable">>;

function withGeneratedMainRpc(
  deps: ResolvedMainRpcDeps & Pick<MainEdgeWiringDeps, "shell">,
): MainEdgeWiringDeps {
  return {
    ...deps,
    serveEdge: deps.serveEdge ?? generatedServeEdge as unknown as MainEdgeWiringDeps["serveEdge"],
    mainRpcContract: deps.mainRpcContract ?? mainRpcContract,
    mainMethodTable: deps.mainMethodTable ?? MAIN_METHOD_TABLE,
  };
}

function validateMainRpcDeps(deps: MainEdgeWiringDeps): MainEdgeWiringDeps {
  requireObject(deps, "mainRpc.deps");
  requireObject(deps.shell, "mainRpc.shell");
  for (const name of ["settingsStore", "agentPrefsStore", "boxToggleStore", "windowChrome", "cursorAccount"] as const) {
    requireObject(deps[name], `mainRpc.${name}`);
  }
  requireFunction(deps.syncHostSettingsToBox, "mainRpc.syncHostSettingsToBox");
  if (typeof deps.platform !== "string") throw new TypeError("Missing Electron production adapter port: mainRpc.platform.");
  requireObject(deps.ipcMain, "mainRpc.ipcMain");
  requireFunction(deps.ipcMain.handle, "mainRpc.ipcMain.handle");
  requireFunction(deps.ipcMain.removeHandler, "mainRpc.ipcMain.removeHandler");
  requireFunction(deps.getTrustedContents, "mainRpc.getTrustedContents");
  requireFunction(deps.broadcast, "mainRpc.broadcast");
  requireFunction(deps.serveEdge, "mainRpc.generatedServeEdge");
  if (deps.mainRpcContract == null) throw new TypeError("Missing Electron production adapter port: mainRpc.generatedContract.");
  if (deps.mainMethodTable == null) throw new TypeError("Missing Electron production adapter port: mainRpc.generatedMethodTable.");
  return deps;
}

/** Artifact anchor: main.cjs:506198, `const mainEdge = serveMainEdge({`. */
export function createProductionMainRpcAdapter(
  ports: ProductionMainRpcPorts,
): ElectronProductionAdapterBindings["mainRpc"] {
  requireFunction(ports?.resolveDeps, "mainRpc.resolveDeps");
  return {
    create(context): MainEdge & Partial<ProductionDisposable> {
      const supplied = requireObject(ports.resolveDeps(context), "mainRpc.resolveDeps.result");
      const resolved = { ...createExistingMainRpcCoreDeps(context, supplied), ...supplied };
      const edge = serveMainEdge(validateMainRpcDeps(withGeneratedMainRpc(resolved)));
      requireObject(edge as object | null, "mainRpc.edge");
      requireFunction((edge as { emit?: (...args: never[]) => unknown }).emit, "mainRpc.edge.emit");
      return edge as MainEdge & Partial<ProductionDisposable>;
    },
  };
}
