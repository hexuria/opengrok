import { stageAttachmentIpcRequest } from "../shared/media/bytes-base64.js";
import { CLIENT_PERSISTENCE_CHANNELS } from "../shared/persistence.js";
import {
  createCoordinatorPortBroker,
  wrapTransferredCoordinatorPort,
  type CoordinatorPortConsumer,
} from "./coordinator-port-bridge.js";
import { MAIN_RPC_CONTRACT_NAME, MAIN_RPC_METHOD_TABLE } from "./main-rpc-runtime.js";
import { bridgeRpcEdge } from "./rpc-edge-runtime.js";

export interface PreloadIpcRenderer {
  invoke(channel: string, payload?: unknown): Promise<any>;
  sendSync(channel: string, payload?: unknown): any;
  send(channel: string, payload?: unknown): void;
  on(channel: string, listener: (event: any, payload?: any) => void): void;
  off(channel: string, listener: (event: any, payload?: any) => void): void;
}

export interface PreloadWebFrame { getZoomFactor(): number }
export interface PreloadContextBridge { exposeInMainWorld(name: string, value: unknown): void }
export type MainPreloadEdge = Record<string, (...args: any[]) => any> & {
  subscribe(handlers: Record<string, (payload: any) => void>): () => void;
};

export function createMainEdgeTransport(ipc: PreloadIpcRenderer): {
  invoke(channel: string, payload: unknown): Promise<any>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
} {
  return {
    invoke: (channel, payload) => ipc.invoke(channel, payload),
    on: (channel, listener) => {
      const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
      ipc.on(channel, wrapped);
      return () => ipc.off(channel, wrapped);
    },
  };
}

function subscribeIpc(ipc: PreloadIpcRenderer, channel: string, listener: (payload: any) => void): () => void {
  const wrapped = (_event: unknown, payload: any): void => listener(payload);
  ipc.on(channel, wrapped);
  return () => ipc.off(channel, wrapped);
}

export const DESKTOP_TELEMETRY_CHANNELS = {
  reportAgentLoad: "sand:report-agent-load",
  reportBoxVisibility: "sand:report-box-visibility",
  reportSendLatency: "sand:report-send-latency",
  reportHeapMetrics: "sand:report-heap-metrics",
  reportSendAck: "sand:report-send-ack",
  reportReactionAck: "sand:report-reaction-ack",
  reportRenderTtfr: "sand:report-render-ttfr",
  reportRenderStream: "sand:report-render-stream",
  reportAgentsUnreachable: "sand:report-agents-unreachable",
  reportAccessBlocked: "sand:report-access-blocked",
  reportRecoveryAction: "sand:report-recovery-action",
  reportRebuildLifecycle: "sand:report-rebuild-lifecycle",
  reportReconciliation: "sand:report-reconciliation",
  reportVncSession: "sand:report-vnc-session",
  reportVncLiveness: "sand:report-vnc-liveness",
  reportOpenComputer: "sand:report-open-computer",
  reportUpdatePrompt: "sand:report-update-prompt",
  reportSigninGate: "sand:report-signin-gate",
  reportOnboardingStep: "sand:report-onboarding-step",
  reportClientFailure: "sand:report-client-failure",
  noteSentryConversation: "sand:sentry-conversation",
} as const;

export function createDesktopTelemetryBridge(ipc: PreloadIpcRenderer): Record<keyof typeof DESKTOP_TELEMETRY_CHANNELS, (report: unknown) => void> {
  return Object.fromEntries(Object.entries(DESKTOP_TELEMETRY_CHANNELS).map(([method, channel]) => [
    method,
    (report: unknown) => ipc.send(channel, report),
  ])) as Record<keyof typeof DESKTOP_TELEMETRY_CHANNELS, (report: unknown) => void>;
}

export interface PrimaryPreloadInitialState {
  readonly experimentSnapshot: unknown;
  readonly themeState: unknown;
  readonly egressTunnelEnabled: boolean;
  readonly webauthnProxyEnabled: boolean;
  readonly egressTunnelStatus: unknown;
}

export function readPrimaryPreloadInitialState(ipc: PreloadIpcRenderer): PrimaryPreloadInitialState {
  return {
    experimentSnapshot: ipc.sendSync("sand:experiments-snapshot-sync"),
    themeState: ipc.sendSync("sand:theme-get-sync"),
    egressTunnelEnabled: ipc.sendSync("sand:egress-tunnel-get-sync") === true,
    webauthnProxyEnabled: ipc.sendSync("sand:webauthn-proxy-get-sync") === true,
    egressTunnelStatus: ipc.sendSync("sand:egress-tunnel-status-get-sync"),
  };
}

function hasDevRestart(env: NodeJS.ProcessEnv): boolean {
  return env.SAND_RESTART_EXIT_CODE != null && env.SAND_RESTART_EXIT_CODE.length > 0;
}

export function createDesktopPreloadBridge(options: {
  readonly ipc: PreloadIpcRenderer;
  readonly webFrame: PreloadWebFrame;
  readonly mainEdge: MainPreloadEdge;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly initialState?: PrimaryPreloadInitialState;
  readonly devRestartEnabled?: boolean;
}): Record<string, any> {
  const { ipc, mainEdge } = options;
  const env = options.env ?? process.env;
  const isDevRestartEnabled = options.devRestartEnabled ?? hasDevRestart(env);
  const edge = (method: string, ...args: any[]): any => mainEdge[method]!(...args);
  const subscribe = (event: string, listener: (payload: any) => void): (() => void) => mainEdge.subscribe({ [event]: listener });
  const initialState = options.initialState ?? readPrimaryPreloadInitialState(ipc);
  const desktop: Record<string, any> = {
    resolveAttachmentMedia: (url: string) => edge("resolveAttachmentMedia", { source: url }),
    readAttachmentText: (path: string) => edge("readAttachmentText", { path }),
    readAttachmentBytes: (path: string, maxBytes: number) => edge("readAttachmentBytes", { path, maxBytes }),
    downloadAttachment: (path: string, suggestedName?: string) => edge("downloadAttachment", { path, suggestedName }),
    getLinkMetadata: (url: string) => edge("getLinkMetadata", { url }),
    async openExternal(url: string) { await edge("openExternal", { url }); },
    async openCloudAgent(bcId: string) { await edge("openCloudAgent", { bcId }); },
    stageAttachmentBytes: (filenameOrRequest: unknown, bytes?: unknown) => edge("stageAttachmentBytes", stageAttachmentIpcRequest(filenameOrRequest, bytes)),
    commitStagedAttachments: (paths: readonly string[], filenames: readonly string[]) => edge("commitStagedAttachments", { paths, filenames }),
    async discardStagedAttachment(path: string) { await edge("discardStagedAttachment", { path }); },
    mcp: {
      list: () => ipc.invoke("sand:mcp-list"),
      effectivePlugins: () => ipc.invoke("sand:mcp-effective-plugins"),
      catalog: () => ipc.invoke("sand:mcp-catalog"),
      teamPopularity: () => ipc.invoke("sand:mcp-team-popularity"),
      pluginLogo: (url: string) => ipc.invoke("sand:mcp-plugin-logo", { url }),
      install: (request: unknown) => ipc.invoke("sand:mcp-install", request),
      updatePluginInstall: (request: unknown) => ipc.invoke("sand:mcp-update-plugin-install", request),
      remove: (serverId: string) => ipc.invoke("sand:mcp-remove", { serverId }),
      uninstallPlugin: (pluginId: string) => ipc.invoke("sand:mcp-uninstall-plugin", { pluginId }),
      authenticate: (serverId: string, accountKey?: unknown, trigger?: unknown) => ipc.invoke("sand:mcp-auth", {
        serverId,
        ...(accountKey != null ? { accountKey } : {}),
        ...(trigger != null ? { trigger } : {}),
      }),
      renameAccount: (args: unknown) => ipc.invoke("sand:mcp-rename-account", args),
      removeAccount: (args: unknown) => ipc.invoke("sand:mcp-remove-account", args),
      setCustomInstructions: (args: unknown) => ipc.invoke("sand:mcp-set-instructions", args),
      listServerTools: (serverId: string) => ipc.invoke("sand:mcp-list-server-tools", { serverId }),
      toggleToolDisabled: (args: unknown) => ipc.invoke("sand:mcp-toggle-tool-disabled", args),
      onAuthCompleted: (listener: (payload: unknown) => void) => subscribeIpc(ipc, "sand:mcp-auth-event", listener),
    },
    async forceGatewayReconnect() { await edge("forceReconnectGateway"); },
    pickAvatarSource: () => edge("pickAvatarSource"),
    pickAvatarFile: () => edge("pickAvatarFile"),
    generateAgentAvatarImage: (description: string) => edge("generateAgentAvatarImage", { description }),
    onFocusAgent: (listener: (payload: unknown) => void) => subscribe("focus-agent", listener),
    onDeepLink: (listener: (payload: unknown) => void) => subscribe("deep-link", listener),
    async deepLinksReady() { await edge("markDeepLinksReady"); },
    getBoxMigrationStatus: () => edge("getBoxMigrationStatus"),
    onBoxMigration: (listener: (payload: unknown) => void) => subscribe("box-migration", listener),
    onDevBoxRebuild: (listener: (payload: unknown) => void) => subscribe("dev-box-rebuild", listener),
    onOpenFeedback: (listener: () => void) => subscribe("open-feedback", () => listener()),
    onOpenAbout: (listener: () => void) => subscribe("open-about", () => listener()),
    submitFeedback: (payload: unknown) => edge("submitFeedback", payload),
    onWidgetGallery: (listener: (payload: unknown) => void) => subscribeIpc(ipc, "sand:dev-widget-gallery", listener),
    onForceOnboarding: (listener: () => void) => subscribe("force-onboarding", () => listener()),
    transcribeAudio: (audio: Uint8Array, mimeType: string, language?: string) => edge("transcribeAudio", { audio, mimeType, language }),
    getTranscribeSettings: () => edge("getTranscribeSettings"),
    getHardwareAcceleration: () => edge("getHardwareAcceleration"),
    setHardwareAcceleration: (enabled: boolean) => edge("setHardwareAcceleration", { enabled }),
    clearAgentMediaCache: (id: string) => edge("clearAgentMediaCache", { id }),
    setTranscribeSettings: (request: { geminiEnabled?: boolean; languages?: string | readonly string[] }) => edge("setTranscribeSettings", request ?? {}),
    cursorAccount: {
      getStatus: () => edge("getCursorAuthStatus"),
      login: () => edge("loginCursor"),
      cancelLogin: () => edge("cancelCursorLogin"),
      logout: () => edge("logoutCursor"),
      updateName: (name: string) => edge("updateCursorAccountName", { name }),
      getAvatar: () => edge("getCursorAvatar"),
      getWeeklyUsage: () => edge("getCursorWeeklyUsage"),
      getUsageSummary: () => edge("getCursorUsageSummary"),
      getPrReviewPreferences: () => edge("getCursorPrReviewPreferences"),
      getPrivacyModeEnabled: () => edge("getCursorPrivacyModeEnabled"),
      getSandAccess: () => edge("getSandAccess"),
      getSandAccessFresh: () => edge("getSandAccessFresh"),
      invokeDashboardAction: (request: unknown) => edge("invokeCursorDashboardAction", request),
      cancelTrial: () => edge("cancelCursorSandTrial"),
      onStatusChanged: (listener: (payload: unknown) => void) => subscribe("cursor-auth-changed", listener),
    },
    experiments: {
      initialSnapshot: initialState.experimentSnapshot,
      getSnapshot: () => edge("getExperimentsSnapshot"),
      async applyFeatureFlagOverride(command: unknown) { await edge("applyFeatureFlagOverride", { command }); },
      async refresh() { await edge("refreshFeatureFlags"); },
      async startRpcTraceWindow() { return await edge("startRpcTraceWindow") === true; },
      onChanged: (listener: (payload: unknown) => void) => subscribe("experiments-changed", listener),
    },
    platform: options.platform ?? process.platform,
    isDev: isDevRestartEnabled,
    getWindowState: () => edge("getWindowState"),
    onWindowStateEvent: (listener: (payload: unknown) => void) => subscribe("window-state", listener),
    getZoomFactor: () => options.webFrame.getZoomFactor(),
    onZoomFactorEvent: (listener: (factor: number) => void) => subscribe("zoom-factor-changed", ({ factor }) => listener(factor)),
    onNotificationSound: (listener: (sound: string) => void) => subscribe("notification-sound", ({ sound }) => listener(sound)),
    notificationPreferences: {
      get: () => edge("getDesktopNotificationPreferences"),
      set: (preferences: unknown) => edge("setDesktopNotificationPreferences", { preferences }),
    },
    windowControls: {
      async minimize() { await edge("minimizeWindow"); },
      async toggleMaximize() { await edge("toggleMaximizeWindow"); },
      async close() { await edge("closeWindow"); },
      async setTitleBarOverlayTone(isOverlayTone: boolean) { await edge("setTitleBarOverlayTone", { isOverlayTone }); },
      resizeWidth: (deltaWidth: number) => edge("resizeWindowWidth", { deltaWidth }),
    },
    foreverBox: {
      forceRecreate: () => edge("forceRecreateComputer"),
      update: (id: string, force = false) => edge("updateComputer", { id, force }),
      onVncUserPresence: (listener: (value: boolean) => void) => subscribe("vnc-user-presence", ({ isPresent }) => listener(isPresent)),
      onDevBoxPullProgress: (listener: (payload: unknown) => void) => subscribe("dev-box-pull-progress", listener),
      egressTunnel: {
        initial: initialState.egressTunnelEnabled,
        get: async () => await edge("getEgressTunnelEnabled") === true,
        set: async (enabled: boolean) => await edge("setEgressTunnelEnabled", { enabled }) === true,
        onChanged: (listener: (value: boolean) => void) => subscribe("egress-tunnel-changed", (enabled) => listener(enabled === true)),
        initialStatus: initialState.egressTunnelStatus,
        getStatus: () => edge("getEgressTunnelStatus"),
        onStatusChanged: (listener: (payload: unknown) => void) => subscribe("egress-tunnel-status-changed", listener),
      },
      webauthnProxy: {
        initial: initialState.webauthnProxyEnabled,
        get: async () => await edge("getWebauthnProxyEnabled") === true,
        set: async (enabled: boolean) => await edge("setWebauthnProxyEnabled", { enabled }) === true,
        onChanged: (listener: (value: boolean) => void) => subscribe("webauthn-proxy-changed", (enabled) => listener(enabled === true)),
      },
    },
    onboarding: {
      getSeen: () => edge("getOnboardingSeen"),
      async setSeen(seen: boolean) { await edge("setOnboardingSeen", { seen }); },
      onSkip: (listener: () => void) => subscribe("skip-onboarding", () => listener()),
    },
    collections: {
      // Feature-detected by the multi-select overlay: present means Share to
      // Collection and Bookmark are offered.
      addMessages: (args: { readonly agentId: string; readonly entryIds: readonly string[]; readonly target?: string; readonly collectionId?: string; readonly name?: string }) => edge("addCollectionMessages", args),
      list: () => edge("listCollections"),
    },
    telemetry: createDesktopTelemetryBridge(ipc),
    timeZone: {
      get: () => edge("getTimeZone"),
      setOverride: (timeZone: string | null) => edge("setTimeZoneOverride", { timeZone }),
    },
    autoReviewInstructions: {
      get: () => edge("getAutoReviewInstructions"),
      set: (instructions: unknown) => edge("setAutoReviewInstructions", { instructions }),
    },
    localToolPermission: {
      get: () => edge("getLocalToolPermission"),
      set: (permission: unknown) => edge("setLocalToolPermission", { permission }),
      ceiling: () => edge("getLocalToolPermissionCeiling"),
      async recordApproval(approvalId: string, action: unknown, target: unknown) { await edge("recordLocalToolApproval", { approvalId, action, target }); },
      async clearApprovals() { await edge("clearLocalToolApprovals"); },
    },
    theme: {
      initial: initialState.themeState,
      get: () => edge("getThemeState"),
      set: (preference: unknown) => edge("setThemePreference", { preference }),
      onChanged: (listener: (payload: unknown) => void) => subscribe("theme-changed", listener),
    },
    secrets: {
      list: () => ipc.invoke("sand:secrets-list"),
      reveal: (key: string) => ipc.invoke("sand:secrets-reveal", { key }),
      upsert: (entries: Record<string, string>) => ipc.invoke("sand:secrets-upsert", { entries }),
      remove: (keys: readonly string[]) => ipc.invoke("sand:secrets-delete", { keys }),
    },
    agent: {
      getPinnedAgents: () => edge("getHostPinnedAgents"),
      setPinnedAgents: (pinnedAgentIds: readonly string[]) => edge("setHostPinnedAgents", { pinnedAgentIds }),
      getSidebarSections: () => edge("getHostSidebarSections"),
      setSidebarSections: (sections: readonly unknown[]) => edge("setHostSidebarSections", { sections }),
      getDefaultModel: () => edge("getAgentDefaultModel"),
      setDefaultModel: (model: unknown) => edge("setAgentDefaultModel", { model }),
      getComputerUseModel: () => edge("getComputerUseModel"),
      setComputerUseModel: (model: unknown) => edge("setComputerUseModel", { model }),
      getAvailableModels: () => edge("getAvailableModels"),
      getInferenceRouter: () => edge("getInferenceRouter"),
      setInferenceRouter: (request: string | { provider?: string; openRouterModel?: string }) => edge(
        "setInferenceRouter",
        typeof request === "string" || request == null
          ? { provider: request }
          : {
            ...(typeof request.provider === "string" ? { provider: request.provider } : {}),
            ...(typeof request.openRouterModel === "string" ? { openRouterModel: request.openRouterModel } : {}),
          },
      ),
      setOpenRouterModel: (model: string) => edge("setInferenceRouter", { openRouterModel: `${model ?? ""}` }),
      startSubscriptionLogin: (provider: string) => edge("startSubscriptionLogin", { provider }),
      skipCursorLoginWall: (request?: { provider?: string | null }) => edge("skipCursorLoginWall", request ?? {}),
      getProviderComputers: () => edge("getProviderComputers"),
      setProviderComputer: (kind: string, enabled: boolean) => edge("setProviderComputer", { kind, enabled }),
      setComputerScreen: (screen: string) => edge("setComputerScreen", { screen }),
      getBoxRuntime: () => edge("getBoxRuntime"),
      setBoxRuntime: (mode: string) => edge("setBoxRuntime", { mode }),
      getOpenGrokServer: () => edge("getOpenGrokServer"),
      signInToOpenGrokServer: (gatewayUrl: string) => edge("signInToOpenGrokServer", { gatewayUrl }),
      signOutOfOpenGrokServer: () => edge("signOutOfOpenGrokServer"),
      listOpenGrokComputers: () => edge("listOpenGrokComputers"),
      resetOpenGrokComputer: () => edge("resetOpenGrokComputer"),
      stopOpenGrokAgentTurn: (agentId: string) => edge("stopOpenGrokAgentTurn", { agentId }),
      getOpenGrokAgentIssues: () => edge("getOpenGrokAgentIssues"),
      getRemoteControl: () => edge("getRemoteControl"),
      enrolRemoteControl: (label: string) => edge("enrolRemoteControl", { label }),
      revokeRemoteControl: () => edge("revokeRemoteControl"),
      setRemoteControlMode: (mode: string) => edge("setRemoteControlMode", { mode }),
      deleteRemoteControlRule: (kind: string, pattern: string) => edge("deleteRemoteControlRule", { kind, pattern }),
      getAgentAutoReview: (agentId: string) => edge("getAgentAutoReview", { agentId }),
      setAgentAutoReview: (agentId: string, policy: { enabled: boolean | null; allowInstructions: string[] | null; blockInstructions: string[] | null }) => edge("setAgentAutoReview", { agentId, ...policy }),
      deleteAgentAutoReview: (agentId: string) => edge("deleteAgentAutoReview", { agentId }),
      getLocalComputer: () => edge("getLocalComputer"),
      setLocalComputerName: (name: string) => edge("setLocalComputerName", { name }),
      setOpenGrokServer: (gatewayUrl: string, token?: string) => edge("setOpenGrokServer", { gatewayUrl, ...(token === undefined ? {} : { token }) }),
      getWindows365Settings: () => edge("getWindows365Settings"),
      setWindows365Settings: (settings: unknown) => edge("setWindows365Settings", settings),
      getWindows365Session: () => edge("getWindows365Session"),
      checkoutWindows365: () => edge("checkoutWindows365"),
      checkinWindows365: () => edge("checkinWindows365"),
      resetWindows365: () => edge("resetWindows365"),
      testWindows365: () => edge("testWindows365"),
      deleteTranscriptEntries: (args: { readonly agentId: string; readonly entryIds: readonly string[] }) => edge("deleteTranscriptEntries", args),
      clientPersistence: {
        read: (key: string) => ipc.invoke(CLIENT_PERSISTENCE_CHANNELS.read, { key }),
        async write(key: string, value: string) { await ipc.invoke(CLIENT_PERSISTENCE_CHANNELS.write, { key, value }); },
        async remove(key: string) { await ipc.invoke(CLIENT_PERSISTENCE_CHANNELS.remove, { key }); },
        listKeys: (prefix: string) => ipc.invoke(CLIENT_PERSISTENCE_CHANNELS.listKeys, { prefix }),
        migrateFromLocalStorage: (entries: readonly unknown[]) => ipc.invoke(CLIENT_PERSISTENCE_CHANNELS.migrate, { entries }),
      },
    },
    update: {
      getStatus: () => edge("getUpdateStatus"),
      check: () => edge("checkForUpdates"),
      setTrack: (track: unknown) => edge("setUpdateTrack", { track }),
      async quitAndInstall() { await edge("quitAndInstallUpdate"); },
      setAutoUpdateWhenIdleOptIn: (enabled: boolean) => edge("setAutoUpdateWhenIdleOptIn", { enabled }),
      onStatusEvent: (listener: (payload: unknown) => void) => subscribe("update-status", listener),
    },
  };
  if (isDevRestartEnabled) desktop.devRestart = async () => { await ipc.invoke("sand:dev-restart"); };
  desktop.attachProdBox = {
    getStatus: () => ipc.invoke("sand:attach-prod-box-status"),
    setEnabled: (enabled: boolean, attachOptions?: { readonly isRestartMainApp?: boolean }) => ipc.invoke("sand:attach-prod-box-set-enabled", {
      enabled,
      isRestartMainApp: attachOptions?.isRestartMainApp,
    }),
  };
  return desktop;
}

export function installPrimaryPreload(options: {
  readonly ipc: PreloadIpcRenderer;
  readonly webFrame: PreloadWebFrame;
  readonly contextBridge: PreloadContextBridge;
  readonly mainEdge: MainPreloadEdge;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly initialState?: PrimaryPreloadInitialState;
  readonly devRestartEnabled?: boolean;
  readonly coordinatorBroker?: ReturnType<typeof createCoordinatorPortBroker<any>>;
}): { readonly desktop: Record<string, any>; readonly coordinatorPort: { claim(consumer: CoordinatorPortConsumer<any>): any } } {
  const env = options.env ?? process.env;
  const devRestartEnabled = options.devRestartEnabled ?? hasDevRestart(env);
  const initialState = options.initialState ?? readPrimaryPreloadInitialState(options.ipc);
  const broker = options.coordinatorBroker ?? createCoordinatorPortBroker<any>({ invokeRequest: () => { void options.ipc.invoke("sand:coordinator-port-request"); } });
  const desktop = createDesktopPreloadBridge({ ...options, env, devRestartEnabled, initialState });
  options.contextBridge.exposeInMainWorld("desktop", desktop);
  options.contextBridge.exposeInMainWorld("coordinatorPort", broker.bridge);
  options.ipc.on("sand:coordinator-port", (event: { readonly ports: readonly any[] }) => {
    const port = event.ports[0];
    if (port != null) broker.deliver(wrapTransferredCoordinatorPort(port));
  });
  return { desktop, coordinatorPort: broker.bridge };
}

export interface PrimaryPreloadElectronRuntime {
  readonly ipcRenderer: PreloadIpcRenderer;
  readonly webFrame: PreloadWebFrame;
  readonly contextBridge: PreloadContextBridge;
}

export function installPrimaryPreloadEntrypoint(
  electron: PrimaryPreloadElectronRuntime,
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof installPrimaryPreload> {
  const devRestartEnabled = hasDevRestart(env);
  const initialState = readPrimaryPreloadInitialState(electron.ipcRenderer);
  const coordinatorBroker = createCoordinatorPortBroker<any>({ invokeRequest: () => { void electron.ipcRenderer.invoke("sand:coordinator-port-request"); } });
  const transport = createMainEdgeTransport(electron.ipcRenderer);
  const mainEdge = bridgeRpcEdge(MAIN_RPC_CONTRACT_NAME, MAIN_RPC_METHOD_TABLE, transport, true) as MainPreloadEdge;
  return installPrimaryPreload({
    ipc: electron.ipcRenderer,
    webFrame: electron.webFrame,
    contextBridge: electron.contextBridge,
    mainEdge,
    platform: process.platform,
    env,
    initialState,
    devRestartEnabled,
    coordinatorBroker,
  });
}

export function loadPrimaryPreloadElectron(
  electronModule: unknown,
): PrimaryPreloadElectronRuntime {
  const runtime = electronModule as Partial<PrimaryPreloadElectronRuntime> | null;
  if (runtime == null || typeof runtime !== "object") throw new Error("electron preload bindings are unavailable");
  const ipc = runtime.ipcRenderer as Partial<PreloadIpcRenderer> | null | undefined;
  const frame = runtime.webFrame as Partial<PreloadWebFrame> | null | undefined;
  const bridge = runtime.contextBridge as Partial<PreloadContextBridge> | null | undefined;
  if (ipc == null || typeof ipc.invoke !== "function" || typeof ipc.sendSync !== "function" || typeof ipc.send !== "function"
    || typeof ipc.on !== "function" || typeof ipc.off !== "function" || frame == null || typeof frame.getZoomFactor !== "function"
    || bridge == null || typeof bridge.exposeInMainWorld !== "function") {
    throw new Error("electron preload bindings are unavailable");
  }
  return runtime as PrimaryPreloadElectronRuntime;
}
