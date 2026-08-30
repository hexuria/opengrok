import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApplicationMenuElectronPort, ApplicationMenuItem } from "./application-menu.js";
import { createCoordinatorMainLegs } from "./coordinator/coordinator-main-legs.js";
import { createEgressConnectionObserver } from "./box/remote-connector-egress.js";
import { createDesktopGatewayDescriptorFastPath } from "./box/gateway-descriptor-store.js";
import { createRemoteHostConnector, type SandRemoteHostConnector } from "./box/box-host-connector.js";
import { createSettingsRoutedHostConnector } from "./box/local-docker-host-connector.js";
import { createSandClientPauseControl } from "./box/box-client-pause.js";
import { createSandMigrationWatcher } from "./box/box-migration-watcher.js";
import type { RecreateResult } from "./box/box-recreate-commands.js";
import { createProductionBoxRecovery, type BoxRecovery } from "./box/box-recovery.js";
import { wrapRemoteHostConnectorWithDevBoxPlane } from "./dev/dev-box-recreate-plane.js";
import { createEgressTunnelWiring } from "./box/egress-tunnel-wiring.js";
import type { BoxConnectionInfo } from "../shared/node/egress-tunnel/box-connection.js";
import type { EgressTunnelController } from "../shared/node/egress-tunnel/egress-tunnel-controller.js";
import { SandDeepLinkController, extractDeepLinkCandidatesFromArgv } from "./deep-link/deep-link-controller.js";
import { electronCollectionsWindowPort, openCollectionsWindow } from "./collections/collections-window.js";
import { registerAuthCallbackProtocol } from "./auth/auth-callback-registration.js";
import { resolveAttachProdBoxPreferred } from "./dev/dev-attach-prod-box.js";
import { resolveSandMainWindowPreload } from "./dev/dev-capability.js";
import type { SandThemeController, SandThemeState } from "./prefs/theme-controller.js";
import type { DataRootSettlement } from "./startup/startup-data-root-migration.js";
import { createDesktopStartupTracker } from "./telemetry/desktop-startup-telemetry.js";
import { createDesktopLifecycleReporter, type TelemetryLevel, type TelemetryMetadata } from "./telemetry/desktop-lifecycle-telemetry.js";
import { installDesktopChildGoneTelemetry, installWindowResponsivenessTelemetry } from "./telemetry/renderer-lifecycle-telemetry.js";
import { installLocalExecLifecycleReporter } from "./local-exec/local-exec-lifecycle-telemetry.js";
import { createDesktopEventLoopTelemetry, desktopEventLoopPressureMetadata } from "./telemetry/desktop-event-loop-telemetry.js";
import { wireDesktopUncleanExitSettlement } from "./telemetry/desktop-unclean-exit-wiring.js";
import { settleUncleanExitOnSessionEnd } from "./telemetry/desktop-unclean-exit-telemetry.js";
import { COORDINATOR_SERVICE_NAME } from "./coordinator/coordinator-launcher.js";
import { localSubscriptionSlotFromStore } from "./coordinator/coordinator-account-runtime.js";
import { createWindowChromeEdgePort, type WindowChromeBrowserWindow } from "./window-chrome.js";
import { createProductionWindowBroadcaster } from "./window-broadcast.js";
import type { SandUpdateService } from "./update/sand-update-service.js";
import { createWindowStatePersistence, type WindowStatePersistenceScreen } from "./window-state-persistence.js";
import { submitFeedbackReport } from "./feedback/feedback-report.js";
import { createSecretsStores } from "./secrets/secrets-ipc.js";
import { desktopStructuredLogAccountSlot } from "./telemetry/desktop-structured-log-spill.js";
import { clientFailureReportToTelemetry } from "./telemetry/client-failure-telemetry.js";
import { createDesktopHostSettingsFields } from "./prefs/host-settings-fields.js";
import { createDesktopMetricsRuntime, type DesktopMetricsRuntime } from "./process-metrics/desktop-metrics-runtime.js";
import { createBoxVisibilitySink } from "./box/box-visibility-sink.js";
import { createBoxVisibilityReportHandler, installBoxVisibilityDocumentReset, SandBoxVisibilityTracker } from "./box/box-visibility-telemetry.js";
import { createDevGatewayOfflineControl } from "./dev/dev-gateway-offline.js";
import { createDevRestartExit, maybeDevLoginFromEnv, registerDevWiring, type IpcMainPort } from "./dev/dev-wiring.js";
import { SandProductAnalytics } from "../shared/node/analytics/product-analytics.js";
import { registerElectronProductionVncTrust, type ElectronProductionVncTrustDeps } from "./vnc/vnc-trust.js";
import { registerProductionTelemetryIpc } from "./telemetry/production-telemetry-ipc.js";
import type { SandAuthStatus } from "./account/cursor-auth.js";
import { shouldPreserveComputersAcrossAccountDeparture } from "./account/preserve-computers.js";
import { OPENGROK_GATEWAY_TOKEN_SECRET } from "../shared/box-runtime.js";
import { setBackendUrlResolver } from "../shared/node/cursor-token.js";
import { readSecret } from "./secrets/secret-store.js";
import type { SecureStorageCodec } from "./secrets/secret-store.js";
import { recordLocalToolApproval as persistLocalToolApproval, clearLocalToolApprovals as clearPersistedLocalToolApprovals } from "../host/local-exec/local-tool-approvals.js";
import { fetchSandAvailableModels } from "./models/cursor-model-catalog.js";
import type { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";
import type {
  ElectronMainDependencies,
  ElectronMainApp,
  ElectronMainRuntime,
  ElectronMainServices,
  ElectronMainServicesInitializationOptions,
  MainBrowserWindow,
  MainBrowserWindowOptions,
  MainEdge,
} from "./main.js";

export interface ElectronPackageMetadata {
  readonly version: string;
  readonly sandLab: boolean;
  readonly sandTrack?: string;
}

export interface ElectronProductionApp extends ElectronMainApp {
  getName(): string;
  getPath(name: "userData" | "temp"): string;
  exit(code: number): void;
  setAsDefaultProtocolClient?(protocol: string, path?: string, args?: readonly string[]): boolean;
  readonly runningUnderARM64Translation?: boolean;
}

export interface ElectronProductionNativeBindings {
  readonly app: ElectronProductionApp;
  readonly safeStorage: SecureStorageCodec;
  readonly ipcMain: IpcMainPort;
  readonly BrowserWindow: {
    new(options: MainBrowserWindowOptions): MainBrowserWindow;
    getAllWindows(): readonly MainBrowserWindow[];
  };
  readonly Menu: {
    buildFromTemplate(template: readonly ApplicationMenuItem[]): unknown;
    setApplicationMenu(menu: unknown): void;
  };
  readonly shell: { openExternal(url: string): Promise<unknown> };
  readonly screen: WindowStatePersistenceScreen;
}

export function createElectronProductionNativeBindings(electron: {
  readonly app: ElectronProductionApp;
  readonly safeStorage: SecureStorageCodec;
  readonly ipcMain: IpcMainPort;
  readonly BrowserWindow: ElectronProductionNativeBindings["BrowserWindow"];
  readonly Menu: ElectronProductionNativeBindings["Menu"];
  readonly shell: ElectronProductionNativeBindings["shell"];
  readonly screen: ElectronProductionNativeBindings["screen"];
}): ElectronProductionNativeBindings {
  const required = ["app", "safeStorage", "ipcMain", "BrowserWindow", "Menu", "shell", "screen"] as const;
  const missing = required.filter((name) => electron[name] == null);
  if (missing.length > 0) throw new Error(`Incomplete Electron production ABI: ${missing.join(", ")}.`);
  if (typeof electron.BrowserWindow !== "function" || typeof electron.BrowserWindow.getAllWindows !== "function") throw new Error("Electron production ABI requires BrowserWindow and BrowserWindow.getAllWindows().");
  if (typeof electron.ipcMain.handle !== "function") throw new Error("Electron production ABI requires ipcMain.handle().");
  if (typeof electron.Menu.buildFromTemplate !== "function" || typeof electron.Menu.setApplicationMenu !== "function") throw new Error("Electron production ABI requires Menu construction and installation.");
  if (typeof electron.shell.openExternal !== "function") throw new Error("Electron production ABI requires shell.openExternal().");
  if (typeof electron.safeStorage.isEncryptionAvailable !== "function" || typeof electron.safeStorage.encryptString !== "function" || typeof electron.safeStorage.decryptString !== "function") throw new Error("Electron production ABI requires safeStorage encryption methods.");
  return { app: electron.app, safeStorage: electron.safeStorage, ipcMain: electron.ipcMain, BrowserWindow: electron.BrowserWindow, Menu: electron.Menu, shell: electron.shell, screen: electron.screen };
}

export interface ElectronProductionResources {
  readonly metadata: ElectronPackageMetadata;
  readonly appName: string;
  readonly preloadPath: string;
  readonly rendererHtmlPath: string;
  /** Shipped Collections page and its narrow preload; both load from disk when packaged. */
  readonly collectionsHtmlPath: string;
  readonly collectionsPreloadPath: string;
  readonly devAppIcon?: string;
  readonly isAttachProdBox: boolean;
}

export function readElectronPackageMetadata(moduleDir: string, readText: (path: string) => string = (path) => readFileSync(path, "utf8")): ElectronPackageMetadata {
  const path = join(moduleDir, "..", "..", "package.json");
  let parsed: unknown;
  try { parsed = JSON.parse(readText(path)); }
  catch (error) { throw new Error(`Electron production metadata could not be read from ${path}.`, { cause: error }); }
  if (parsed == null || typeof parsed !== "object") throw new Error("Electron production metadata must be an object.");
  const record = parsed as Record<string, unknown>;
  if (typeof record.version !== "string" || record.version.trim().length === 0) throw new Error("Electron production metadata requires a version.");
  if (record.sandLab !== undefined && typeof record.sandLab !== "boolean") throw new Error("Electron production metadata sandLab must be boolean when present.");
  if (record.sandTrack !== undefined && typeof record.sandTrack !== "string") throw new Error("Electron production metadata sandTrack must be a string when present.");
  return { version: record.version, sandLab: record.sandLab === true, ...(typeof record.sandTrack === "string" ? { sandTrack: record.sandTrack } : {}) };
}

export function resolveElectronProductionResources(args: {
  readonly moduleDir: string;
  readonly app: Pick<ElectronProductionApp, "isPackaged" | "getName">;
  readonly env: NodeJS.ProcessEnv;
  readonly metadata: ElectronPackageMetadata;
  readonly attachProdBoxPreferencePath?: string;
}): ElectronProductionResources {
  const preloadName = resolveSandMainWindowPreload({ isPackaged: args.app.isPackaged, env: args.env });
  const isAttachProdBox = !args.app.isPackaged && resolveAttachProdBoxPreferred(args.env, args.attachProdBoxPreferencePath);
  return {
    metadata: args.metadata,
    appName: args.app.getName(),
    preloadPath: join(args.moduleDir, "..", "electron-preload", preloadName),
    rendererHtmlPath: join(args.moduleDir, "..", "renderer", "index.html"),
    collectionsHtmlPath: join(args.moduleDir, "..", "electron-collections", "page", "collections.html"),
    collectionsPreloadPath: join(args.moduleDir, "..", "electron-preload", "preload-collections.cjs"),
    ...(args.env.SAND_DEV_APP_ICON == null ? {} : { devAppIcon: args.env.SAND_DEV_APP_ICON }),
    isAttachProdBox,
  };
}

export function createElectronMenuAdapter(native: ElectronProductionNativeBindings): ApplicationMenuElectronPort {
  return { appName: native.app.getName(), buildFromTemplate: (template) => native.Menu.buildFromTemplate(template), setApplicationMenu: (menu) => native.Menu.setApplicationMenu(menu), openExternal: (url) => native.shell.openExternal(url) };
}

export interface ProductionDisposable { dispose(): void | Promise<void> }
export type ProductionAccountStatus = SandAuthStatus;
export interface ProductionAccountAuthService {
  getValidAccessToken(options?: { readonly backendUrl?: string }): Promise<string>;
  peekAccessToken?(): Promise<string | null>;
  revokeForAccountRefusal(): Promise<{ readonly kind: "completed"; readonly status: ProductionAccountStatus } | { readonly kind: "failed"; readonly status: ProductionAccountStatus; readonly error: unknown }>;
  getStatus(): Promise<ProductionAccountStatus>;
  subscribe(listener: (status: ProductionAccountStatus) => void): () => void;
  login(): Promise<ProductionAccountStatus>;
  cancelLogin(): Promise<ProductionAccountStatus>;
  logout(): Promise<ProductionAccountStatus>;
  updateDisplayName(name: string): Promise<ProductionAccountStatus>;
  /** Shipped startup-only development authentication hook. */
  devLogin?(options: { readonly tier?: string; readonly email?: string }): Promise<ProductionAccountStatus>;
}
export interface ProductionAccountService extends ProductionDisposable {
  getStatus(): Promise<ProductionAccountStatus>;
  subscribe(listener: () => void): () => void;
  currentAuthStatusFreshness(): number;
  /** Exact auth-wiring handoff used by coordinator account status delivery. */
  deliverCursorAuthStatus(status: ProductionAccountStatus): void;
  revokeForAccountRefusal(): Promise<{ readonly kind: "completed"; readonly status: ProductionAccountStatus } | { readonly kind: "failed"; readonly status: ProductionAccountStatus; readonly error: unknown }>;
  /** Exact authenticated service shared by experiments, MCP, telemetry, and coordinator joins. */
  getAuthService(): Promise<ProductionAccountAuthService>;
}
export interface ProductionSettingsService extends ProductionDisposable {
  readonly settingsStore: SandSettingsStore;
  initializeTheme(): void;
  getThemeController(): SandThemeController;
  getThemeBackgroundColor(): string;
}
export interface ProductionExperimentsService extends ProductionDisposable {
  /** Lazy service identity consumed by the immutable MainEdge experiment handlers. */
  ensureService(): Promise<{
    getSnapshot(): unknown;
    applyFeatureFlagOverrideCommand(command: unknown): void;
    refreshNow(): Promise<void>;
  }>;
  isTelemetryDisabled(): boolean;
  startRpcTraceWindow(): boolean;
  getComputerUseModelOverride(): unknown;
  subscribe(listener: () => void): () => void;
  getSnapshot(): unknown;
  getFeatureFlagOverridesRecord(): Record<string, unknown>;
  checkFeatureGate(name: string): boolean;
  getDynamicConfig(name: string): Record<string, unknown>;
  hasLiveStatsigBootstrap(): boolean;
  getFlagsAgeMs(): number | undefined;
}
export interface ProductionTelemetrySink {
  reportDesktopStartup(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportDesktopEventLoop(metadata: TelemetryMetadata): void;
  reportDesktopProcessCrash(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportDesktopRendererLifecycle(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportDesktopCoordinatorHandoff(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportDesktopLocalExecLifecycle(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportDesktopUncleanExit(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  setFlushTickListener(listener: (() => void) | undefined): void;
  reportUpdateOutcome(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportUpdateCheck(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportUpdateApply(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportSendLatency(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportSendAck(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportReactionAck(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportAgentLoad(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportAccessBlocked(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportVncSession(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportVncLiveness(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportOpenComputer(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportRenderTtfr(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportRenderStream(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportUpdatePrompt(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportDesktopSignin(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportClientFailure(failure: ReturnType<typeof clientFailureReportToTelemetry>): void;
  reportAttachmentEdgeFailure?(failure: { readonly leg: string; readonly errorClass: string }): void;
  reportImageEdgeFailure?(failure: { readonly leg: string; readonly errorClass: string }): void;
  reportBoxSetupVisible?(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportBoxRecreateVisible?(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportBoxRebuildStage?(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportBoxRebuildEscalation?(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportBoxRebuildPendingStall?(metadata: TelemetryMetadata): void;
  reportBoxMigrationWatch?(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportReplicaResync?(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportSendJournalRestore?(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportResyncCompleted?(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportBoxReachability?(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportBoxDnsDiagnostic?(metadata: TelemetryMetadata): void;
  reportAgentsUnreachable?(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportAccessBlocked(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportTransportStreamDown?(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportCoordinatorLifecycle?(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportRecoveryAction?(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportVncSession(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportVncLiveness(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportVncAssetFail?(metadata: TelemetryMetadata): void;
  reportOpenComputer(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportRenderTtfr(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportRenderStream(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportUpdatePrompt(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportDesktopSignin(level: TelemetryLevel, metadata: TelemetryMetadata): void;
  reportTelemetrySinkEdgeFailure?(failure: { readonly sink: string; readonly errorClass: string }): void;
}
export interface ProductionUpdateService extends ProductionDisposable {
  readonly updateService: SandUpdateService;
  noteBackendUpdateRequirement(required: boolean): void;
  attachExperiments(experiments: ProductionExperimentsService): void;
  attachTelemetry(telemetry: ProductionTelemetrySink): void;
  willRunStagedInstallerOnQuit(): boolean;
  applyStagedOnQuit(): void;
}
export interface ProductionMcpService extends ProductionDisposable {
  openExternalUrl(value: unknown): Promise<void>;
  refreshHostMcp(completion?: unknown): Promise<void>;
  resetMcpManager(): Promise<void>;
  listRoutedTools(): Promise<unknown>;
  executeRoutedTool(request: unknown): Promise<unknown>;
}
export interface ProductionCoordinatorResyncPort {
  pushHostSettings(update: unknown): Promise<Record<string, any> | null>;
  readHostSettings(): Promise<unknown>;
}
export interface ProductionMcpHostPort {
  refreshMcp(completion?: unknown): Promise<void>;
  syncHostSettings(settings: Record<string, unknown>): Promise<Record<string, any> | null>;
}
export interface ProductionCoordinatorService extends ProductionDisposable {
  start(status: ProductionAccountStatus): Promise<void>;
  setWindowFocused(state: { readonly isFocused: boolean }): Promise<unknown>;
  pushHostSettings(update: unknown): Promise<Record<string, any> | null>;
  readHostSettings(): Promise<unknown>;
  getAccountRuntime?(): unknown;
  restartCoordinator(): void;
  getTelemetryReportPipes?(): ProductionCoordinatorTelemetryReportPipes;
}
export interface ProductionCoordinatorTelemetryReportPipes {
  agentsUnreachable(report: unknown): void;
  recoveryAction(report: unknown): void;
  rebuildLifecycle(report: unknown): void;
  reconciliation(report: unknown): void;
  boxMigrationWatch(report: unknown): void;
  resyncCompleted(report: unknown): void;
}
export interface ProductionTelemetryService extends ProductionDisposable {
  readonly telemetry: ProductionTelemetrySink;
  flushBeforeQuit(): Promise<void>;
  spillPending?(): Promise<void>;
}
export interface ProductionNotificationsService extends ProductionDisposable {
  onAgentsEvent(payload: unknown): void;
  onAgentsRosterSeed(payload: unknown): void;
  resetAccountState(): void;
}
export interface ProductionServiceContext {
  readonly native: ElectronProductionNativeBindings;
  readonly resources: ElectronProductionResources;
  readonly env: NodeJS.ProcessEnv;
  readonly machineId: string;
  /** Root quit-state reader consumed by the coordinator telemetry join. */
  readonly isQuitting: () => boolean;
  /** Root-owned callback re-applied after the coordinator adopts its main-data port. */
  readonly onCoordinatorLaunched: () => void;
  readonly coordinatorLegs: ReturnType<typeof createCoordinatorMainLegs>;
  /** Root-owned connector observer shared by the coordinator gateway and egress tunnel. */
  readonly connectorEgress: ReturnType<typeof createEgressConnectionObserver<BoxConnectionInfo>>;
  /** Process-lifetime egress controller; the immutable root does not unregister it. */
  readonly requireEgressTunnelController: () => EgressTunnelController;
  /** Root-owned coordinator settings/resync closures; the service remains lazy until coordinator creation. */
  readonly coordinatorResync: ProductionCoordinatorResyncPort;
  /** Exact host-settings field mirrors, including the onboarding field used by MainEdge. */
  readonly hostSettingsFields: ReturnType<typeof createDesktopHostSettingsFields>;
  /** Root-owned MCP refresh/settings closures; refresh is a no-op until desktop IPC registration. */
  readonly mcpHost: ProductionMcpHostPort;
  /** Exact descriptor-cache cleanup used before replacing an account session. */
  readonly clearGatewayDescriptor: () => Promise<void>;
  readonly shouldPreserveComputers?: () => boolean;
  /** Root diagnostics consumed by the coordinator provider; failures retain their original error. */
  readonly reportFailure: (area: string, leg: string, error: unknown) => void;
  readonly reportProblem: (area: string, detail: string) => void;
  /** Exact BrowserWindow webContents broadcast carrier used by MCP auth completion. */
  readonly broadcast: (channel: string, payload: unknown) => void;
  /** Re-enters the shipped deep-link controller; used by Collections' "Open original". */
  readonly handleDeepLink: (url: string) => void;
  /** Trusted current main-window sender used by coordinator/IPC registration. */
  readonly getTrustedContents: () => MainBrowserWindow["webContents"] | undefined;
  readonly settings: ProductionSettingsService;
  /** Root-owned encrypted stores and serialized account-scope pushes. */
  readonly secretsStores: ReturnType<typeof createSecretsStores>;
  /** Root-owned broker/migration/recreate/restart/update lifecycle. */
  readonly boxRecovery: BoxRecovery;
  /** Root-local account slot/departure latches consumed by secrets and coordinator joins. */
  readonly accountLifecycle: ProductionAccountLifecycle;
  /** Exact private MainEdge shell port: MCP forwarding, native browser open, feedback, and deep-link readiness. */
  readonly shell: {
    readonly openExternalUrl: (url: string) => Promise<unknown>;
    readonly openInSystemBrowser: (url: string) => Promise<unknown>;
    readonly submitFeedback: (request: unknown) => Promise<{ ok: true } | { ok: false; code: string }>;
    readonly markDeepLinksReady: () => void;
  };
  /** Exact window-control edge collaborator shared by MainEdge and preload. */
  readonly windowChrome: ReturnType<typeof createWindowChromeEdgePort>;
  readonly attachments: unknown;
  readonly avatarImages: unknown;
  /** Exact account RPC edge installed beside the generated MainEdge handlers. */
  readonly cursorAccount: unknown;
  /** Lazy generated AiService transcription manager installed by the root. */
  readonly ensureTranscriptionManager: () => Promise<unknown>;
  readonly fetchAvailableModels: () => Promise<unknown>;
  readonly recordLocalToolApproval: (approval: { readonly id: string; readonly action: string; readonly target: string }) => Promise<void>;
  readonly clearLocalToolApprovals: () => Promise<void>;
  readonly getMainWindow: () => MainBrowserWindow | undefined;
  readonly requireMainEdge: () => MainEdge;
  readonly requireAccount: () => ProductionAccountService;
  readonly requireExperiments: () => ProductionExperimentsService;
  readonly requireUpdate: () => ProductionUpdateService;
  readonly requireMcp: () => ProductionMcpService;
  readonly requireTelemetry: () => ProductionTelemetryService;
  readonly readTelemetry: () => ProductionTelemetryService | undefined;
  readonly requireNotifications: () => ProductionNotificationsService;
  readonly requireCoordinator: () => ProductionCoordinatorService;
  /** Coordinator report-pipe subset shared with the process-owned telemetry registrar. */
  readonly requireCoordinatorTelemetry: () => ProductionCoordinatorTelemetryReportPipes;
  /** Process-owned numeric/process metrics runtime; it is not an IPC disposable. */
  readonly desktopMetricsRuntime: DesktopMetricsRuntime;
  /** Product analytics owner shared by renderer report pipes and lifecycle flush. */
  readonly productAnalytics: SandProductAnalytics;
  /** Exact process-owned VNC carrier factory; routeHostInput remains a main-root port. */
  readonly createVncTrust: (routeHostInput: ElectronProductionVncTrustDeps["routeHostInput"]) => ReturnType<typeof registerElectronProductionVncTrust>;
  /** Renderer box-visibility state machine and its exact trusted-report projection. */
  readonly boxVisibilityTracker: SandBoxVisibilityTracker;
  readonly handleBoxVisibilityReport: Parameters<ReturnType<typeof createBoxVisibilityReportHandler>>[0] extends infer T ? (report: T) => void : never;
}

export interface ProductionAccountLifecycle {
  readonly getAccountScope: () => string | undefined;
  readonly isSignedIn: () => boolean;
  readonly isAccountDeparting: () => boolean;
  readonly beginTransition: () => void;
  readonly deliverStatus: (status: ProductionAccountStatus) => void;
}

export interface ElectronProductionServiceFactories {
  initializeSecureStorage(): void;
  getMachineId(): Promise<string>;
  createSettings(args: { readonly native: ElectronProductionNativeBindings; readonly resources: ElectronProductionResources; readonly env: NodeJS.ProcessEnv; readonly emitThemeChanged: (state: SandThemeState) => void }): ProductionSettingsService;
  createAttachments(context: Omit<ProductionServiceContext, "attachments" | "avatarImages" | "cursorAccount" | "ensureTranscriptionManager">): unknown;
  createAvatarImages(context: Omit<ProductionServiceContext, "attachments" | "avatarImages" | "cursorAccount" | "ensureTranscriptionManager">): unknown;
  createCursorAccount(context: Omit<ProductionServiceContext, "attachments" | "avatarImages" | "cursorAccount" | "ensureTranscriptionManager">): unknown;
  createTranscriptionManager(context: Omit<ProductionServiceContext, "attachments" | "avatarImages" | "cursorAccount" | "ensureTranscriptionManager">): () => Promise<unknown>;
  createMainEdge(context: ProductionServiceContext): MainEdge & Partial<ProductionDisposable>;
  createUpdate(context: ProductionServiceContext): Promise<ProductionUpdateService> | ProductionUpdateService;
  registerMediaScheme(): void;
  registerMedia(context: ProductionServiceContext): ProductionDisposable;
  createAccount(context: ProductionServiceContext): Promise<ProductionAccountService> | ProductionAccountService;
  createExperiments(context: ProductionServiceContext): Promise<ProductionExperimentsService> | ProductionExperimentsService;
  createMcp(context: ProductionServiceContext): Promise<ProductionMcpService> | ProductionMcpService;
  createTelemetry(context: ProductionServiceContext): Promise<ProductionTelemetryService> | ProductionTelemetryService;
  createNotifications(context: ProductionServiceContext): ProductionNotificationsService;
  createCoordinator(context: ProductionServiceContext): Promise<ProductionCoordinatorService> | ProductionCoordinatorService;
  registerIpc(context: ProductionServiceContext): ProductionDisposable;
  /** Artifact-order process-lifetime registration after the application menu. */
  registerImageContextMenu?(deps: { readonly openExternalUrl: (url: string) => Promise<unknown>; readonly onEdgeFailure: (failure: { readonly leg: string; readonly errorClass: string }) => void }): void;
  killLocalExecDaemon?(): Promise<void>;
  onWindowCreated?(window: MainBrowserWindow, context: ProductionServiceContext): void;
}

export interface ElectronProductionStartupBindings {
  readonly bootstrapUserData: (input: { readonly isLabBuild: boolean; readonly env: NodeJS.ProcessEnv }) => string | null;
  readonly bootstrapDataRoot: (input: { readonly isPrimaryInstance: boolean; readonly isLabBuild: boolean; readonly hasIsolatedUserData: boolean; readonly env: NodeJS.ProcessEnv }) => DataRootSettlement | null;
  readonly runMoveCheck: (input: { readonly dataRootSettlement: DataRootSettlement | null; readonly isLabBuild: boolean; readonly hasPendingActivation: () => boolean; readonly beforeExit: () => void }) => Promise<"continue-bootstrap" | "stop-bootstrap">;
  readonly checkFullDiskAccess: () => Promise<string>;
  readonly report: Parameters<typeof createDesktopStartupTracker>[0]["report"];
  readonly captureFailure: Parameters<typeof createDesktopStartupTracker>[0]["captureFailure"];
  readonly scheduleStuck: Parameters<typeof createDesktopStartupTracker>[0]["scheduleStuck"];
  readonly monotonicNow?: () => number;
  readonly attachTelemetry: (telemetry: ProductionTelemetrySink) => void;
}

export interface ElectronMainProductionBindings {
  readonly native: ElectronProductionNativeBindings;
  readonly moduleDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly metadata?: ElectronPackageMetadata;
  readonly readPackageText?: (path: string) => string;
  readonly attachProdBoxPreferencePath?: string;
  readonly startup: ElectronProductionStartupBindings;
  readonly services: ElectronProductionServiceFactories;
  readonly parseAllowedExternalUrl: (value: unknown) => string | null;
  readonly reportFailure: (area: string, leg: string, error: unknown) => void;
}

export interface ElectronMainProductionComposition {
  readonly dependencies: ElectronMainDependencies;
  bindRuntime(runtime: ElectronMainRuntime): void;
}

function requireFactoryBindings(factories: ElectronProductionServiceFactories): void {
  const required = ["initializeSecureStorage", "getMachineId", "createSettings", "createAttachments", "createAvatarImages", "createCursorAccount", "createTranscriptionManager", "createMainEdge", "createUpdate", "registerMediaScheme", "registerMedia", "createAccount", "createExperiments", "createMcp", "createTelemetry", "createNotifications", "createCoordinator", "registerIpc"] as const;
  const missing = required.filter((name) => typeof factories[name] !== "function");
  if (missing.length > 0) throw new Error(`Incomplete Electron production service graph: ${missing.join(", ")}.`);
}

export function createElectronMainProductionComposition(bindings: ElectronMainProductionBindings): ElectronMainProductionComposition {
  requireFactoryBindings(bindings.services);
  const env = bindings.env ?? process.env, platform = bindings.platform ?? process.platform;
  const metadata = bindings.metadata ?? readElectronPackageMetadata(bindings.moduleDir, bindings.readPackageText);
  const resources = resolveElectronProductionResources({ moduleDir: bindings.moduleDir, app: bindings.native.app, env, metadata, ...(bindings.attachProdBoxPreferencePath == null ? {} : { attachProdBoxPreferencePath: bindings.attachProdBoxPreferencePath }) });
  const startupTracker = createDesktopStartupTracker({ monotonicNow: bindings.startup.monotonicNow ?? (() => performance.now()), translated: platform === "darwin" ? bindings.native.app.runningUnderARM64Translation === true ? "true" : "false" : "unknown", report: bindings.startup.report, scheduleStuck: bindings.startup.scheduleStuck, captureFailure: bindings.startup.captureFailure });
  bindings.services.registerMediaScheme();
  const authCallbackRegistration = registerAuthCallbackProtocol({ app: bindings.native.app, isPackaged: bindings.native.app.isPackaged, isLabBuild: metadata.sandLab, env });
  if (!authCallbackRegistration.skipped && !authCallbackRegistration.registered) {
    bindings.reportFailure("cursor-auth", "protocol-registration", new Error(`Unable to register ${authCallbackRegistration.protocolScheme}:${authCallbackRegistration.redirectTarget}.`));
  }
  const windowStatePersistence = createWindowStatePersistence({ app: bindings.native.app, screen: bindings.native.screen, env, captureWarning: (message) => bindings.reportFailure("window-state", "persistence", new Error(message)) });
  const coordinatorLegs = createCoordinatorMainLegs({ onProblem: (problem) => bindings.reportFailure("coordinator", "main-legs", new Error(problem)), reportFailure: (leg, error) => bindings.reportFailure("coordinator", leg, error) });
  const connectorEgress = createEgressConnectionObserver<BoxConnectionInfo>();
  const devGatewayOfflineControl = createDevGatewayOfflineControl(async (induced) => {
    const result: unknown = await coordinatorLegs.legs.setDevGatewayOffline!({ induced });
    if (typeof result !== "object" || result == null || typeof Reflect.get(result, "induced") !== "boolean") {
      throw new Error("Electron production coordinator returned an invalid dev gateway-offline state.");
    }
    return { induced: Reflect.get(result, "induced") as boolean };
  });
  type ProductionClientPauseControl = ReturnType<typeof createSandClientPauseControl<BoxConnectionInfo, { readonly preserveData: boolean; readonly force?: boolean }, RecreateResult, { readonly credential: string; readonly backendUrl: string; readonly expiresAtMs?: number }>>;
  let runtime: ElectronMainRuntime | undefined, settings: ProductionSettingsService | undefined, mainEdge: (MainEdge & Partial<ProductionDisposable>) | undefined, account: ProductionAccountService | undefined, cursorAccount: unknown, ensureTranscriptionManager: (() => Promise<unknown>) | undefined, experiments: ProductionExperimentsService | undefined, update: ProductionUpdateService | undefined, mcp: ProductionMcpService | undefined, telemetry: ProductionTelemetryService | undefined, notifications: ProductionNotificationsService | undefined, coordinator: ProductionCoordinatorService | undefined, egressTunnelController: EgressTunnelController | undefined, context: ProductionServiceContext | undefined, secretsStores: ReturnType<typeof createSecretsStores> | undefined, boxRecovery: ReturnType<typeof createProductionBoxRecovery> | undefined, clientPauseControl: ProductionClientPauseControl | undefined, boxVisibilityTracker: SandBoxVisibilityTracker | undefined, desktopMetricsRuntime: DesktopMetricsRuntime | undefined, productAnalytics: SandProductAnalytics | undefined, vncTrust: ReturnType<typeof registerElectronProductionVncTrust> | undefined;
  let sessionDeathSettlement: ReturnType<typeof wireDesktopUncleanExitSettlement> | undefined;
  const desktopLifecycle = createDesktopLifecycleReporter();
  const disposeLocalExecLifecycleReporter = installLocalExecLifecycleReporter(desktopLifecycle.reportDesktopLocalExecLifecycle);
  let desktopEventLoopSampler: ReturnType<typeof createDesktopEventLoopTelemetry> | undefined;
  let accountStatusUnsubscribe: (() => void) | undefined;
  let accountStatusSequence = 0;
  let cursorAuthSignedIn = false;
  let accountTransitionDeparting = false;
  let dataRootSettlement: DataRootSettlement | null = null, hasIsolatedUserData = false, foundationInitialized = false, initialization: Promise<ElectronMainServices> | undefined, disposed = false, quitState: "idle" | "flushing" | "settled" = "idle";
  const disposables: ProductionDisposable[] = [];
  const disposedValues = new Set<object>();
  const requireValue = <T>(value: T | undefined, name: string): T => { if (value == null) throw new Error(`Electron production service ${name} was used before initialization.`); return value; };
  const focusWindow = (): void => { const window = runtime?.getMainWindow(); if (window == null || window.isDestroyed()) { runtime?.ensureMainWindow(); return; } if (window.isMinimized()) window.restore(); window.show(); window.focus(); };
  // A collection link never reaches the renderer: it belongs to the second
  // window, which owns its own page and preload.
  const openCollections = (collectionId?: string): void => openCollectionsWindow({
    port: electronCollectionsWindowPort(),
    htmlPath: resources.collectionsHtmlPath,
    preloadPath: resources.collectionsPreloadPath,
    ...(collectionId == null ? {} : { collectionId }),
    openExternalUrl: (url) => { void mcp?.openExternalUrl(url).catch((error: unknown) => bindings.reportFailure("collections", "open-external", error)); },
    reportFailure: (leg, error) => bindings.reportFailure("collections", leg, error),
  });
  const deepLinks = new SandDeepLinkController({
    dispatch: (parsed) => {
      if (parsed.link.route === "collection") { openCollections(parsed.link.collectionId); return; }
      requireValue(mainEdge, "main-edge").emit("deep-link", parsed.link);
    },
    focusWindow,
    log: (message) => console.log(`[sand] ${message}`),
  });
  const track = <T extends ProductionDisposable>(value: T): T => { disposables.push(value); return value; };
  const requireDisposable = <T extends ProductionDisposable>(value: T, name: string): T => { if (value == null || typeof value.dispose !== "function") throw new Error(`Electron production service ${name} did not provide dispose().`); return value; };
  const disposeOnce = async (value: ProductionDisposable | undefined): Promise<void> => {
    if (value == null || disposedValues.has(value)) return;
    disposedValues.add(value);
    await value.dispose();
  };
  const disposeDesktopEventLoopSampler = (): void => {
    desktopEventLoopSampler?.dispose();
    desktopEventLoopSampler = undefined;
  };
  const disposeGraph = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    disposeDesktopEventLoopSampler();
    accountStatusSequence += 1;
    try { accountStatusUnsubscribe?.(); } catch (error) { bindings.reportFailure("account", "status-unsubscribe", error); }
    accountStatusUnsubscribe = undefined;
    try { await disposeOnce(productAnalytics); } catch (error) { bindings.reportFailure("product-analytics", "dispose", error); }
    for (const disposable of [...disposables].reverse()) {
      try { await disposeOnce(disposable); } catch (error) { bindings.reportFailure("main", "dispose", error); }
    }
    try { coordinatorLegs.dispose(); } finally { disposeLocalExecLifecycleReporter(); }
  };
  const initializeFoundation = (): void => {
    if (foundationInitialized) return;
    foundationInitialized = true;
    settings = track(requireDisposable(bindings.services.createSettings({
      native: bindings.native,
      resources,
      env,
      emitThemeChanged: (state) => requireValue(mainEdge, "main-edge").emit("theme-changed", state),
    }), "settings"));
  };
  const initializeServices = (options?: ElectronMainServicesInitializationOptions): Promise<ElectronMainServices> => initialization ??= (async () => {
    try {
      initializeFoundation();
      installDesktopChildGoneTelemetry({
        app: bindings.native.app,
        report: desktopLifecycle.reportDesktopRendererLifecycle,
        isCoordinatorService: (serviceName) => serviceName === COORDINATOR_SERVICE_NAME,
      });
      sessionDeathSettlement = wireDesktopUncleanExitSettlement({
        app: bindings.native.app,
        report: (level, metadata) => telemetry?.telemetry.reportDesktopUncleanExit(level, metadata),
        reportEdgeFailure: (area, leg, error) => bindings.reportFailure(area, leg, error),
      });
      bindings.services.initializeSecureStorage();
      const machineId = await bindings.services.getMachineId();
      if (typeof machineId !== "string" || machineId.length === 0) throw new Error("Electron production machine id binding returned an empty value.");
      const shell = {
        openExternalUrl: async (url: string): Promise<unknown> => await requireValue(mcp, "mcp").openExternalUrl(url),
        openInSystemBrowser: async (url: string): Promise<unknown> => await bindings.native.shell.openExternal(url),
        submitFeedback: async (request: unknown): Promise<{ ok: true } | { ok: false; code: string }> => {
          const auth = await requireValue(account, "account").getAuthService();
          const getSystemVersion = (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion;
          if (typeof getSystemVersion !== "function") throw new Error("Electron production feedback requires process.getSystemVersion().");
          return await submitFeedbackReport({
            getAccessToken: ({ backendUrl }) => auth.getValidAccessToken({ backendUrl }),
            getMachineId: async () => machineId,
            appVersion: resources.metadata.version,
            platform: `${platform}-${process.arch}`,
            osVersion: getSystemVersion(),
          }, request);
        },
        markDeepLinksReady: (): void => { deepLinks.markReady(); },
      };
      const windowChrome = createWindowChromeEdgePort({
        getMainWindow: () => runtime?.getMainWindow() as WindowChromeBrowserWindow | undefined,
        workAreaFor: (window) => bindings.native.screen.getDisplayMatching(window.getBounds()).workArea,
        setTitleBarOverlayTone: (isOverlayTone) => { runtime?.setTitleBarOverlayTone(isOverlayTone); },
      });
      productAnalytics = new SandProductAnalytics({
        hostInBox: false,
        getAccessToken: async ({ backendUrl }) => (await requireValue(account, "account").getAuthService()).getValidAccessToken({ backendUrl }),
        getMachineId: async () => machineId,
      });
      const broadcast = createProductionWindowBroadcaster(bindings.native.BrowserWindow);
      const getTrustedContents = (): MainBrowserWindow["webContents"] | undefined => runtime?.getMainWindow()?.webContents;
      desktopMetricsRuntime = createDesktopMetricsRuntime({
        ensureCursorAuthService: async () => await requireValue(account, "account").getAuthService(),
        ensureExperimentService: async () => {
          const service = requireValue(experiments, "experiments");
          return {
            checkFeatureGate: (name: string) => service.checkFeatureGate(name),
            getDynamicConfig: (name: string) => service.getDynamicConfig(name),
            subscribe: (listener: () => void) => service.subscribe(listener),
          };
        },
        getMachineId: () => machineId,
        getClientVersion: () => resources.metadata.version,
        isQuitting: () => quitState !== "idle",
        reportFailure: (area, leg, error) => bindings.reportFailure(area, leg, error),
      });
      boxVisibilityTracker = new SandBoxVisibilityTracker(createBoxVisibilitySink(() => {
        const sink = telemetry?.telemetry;
        return sink == null || typeof sink.reportBoxSetupVisible !== "function" || typeof sink.reportBoxRecreateVisible !== "function" || typeof sink.reportBoxRebuildStage !== "function" ? undefined : sink as {
          reportBoxSetupVisible(level: "info" | "warn", metadata: Record<string, string | undefined>): void;
          reportBoxRecreateVisible(level: "info" | "warn", metadata: Record<string, string | undefined>): void;
          reportBoxRebuildStage(level: "info" | "warn", metadata: Record<string, string | undefined>): void;
        };
      }));
      // One account, and this decides whose. With an OpenGrok server configured it
        // becomes the account authority for everything the app already does - sign
        // in, GetMe, usage - rather than a second identity beside Cursor's.
        setBackendUrlResolver(() => {
          try {
            const store = requireValue(settings, "settings").settingsStore;
            return store.getBoxRuntime() === "opengrok" ? store.getOpenGrokGatewayUrl() : undefined;
          } catch { return undefined; }
        });
        const handleBoxVisibilityReport = createBoxVisibilityReportHandler(() => boxVisibilityTracker);
      const accountLifecycle: ProductionAccountLifecycle = {
        getAccountScope: () => {
          const store = requireValue(settings, "settings").settingsStore;
          return store.getMcpCustomInstructionsAccountScope() ?? localSubscriptionSlotFromStore(store) ?? undefined;
        },
        isSignedIn: () => cursorAuthSignedIn,
        isAccountDeparting: () => accountTransitionDeparting,
        beginTransition: () => { accountTransitionDeparting = true; connectorEgress.noteAccountDeparted(); },
        deliverStatus: (status) => {
          cursorAuthSignedIn = (desktopStructuredLogAccountSlot(status) ?? "logged-out") !== "logged-out";
          accountTransitionDeparting = false;
        },
      };
      secretsStores = createSecretsStores(
        join(bindings.native.app.getPath("userData"), "sand-client-persistence"),
        accountLifecycle.getAccountScope,
        {
          reportTelemetry: (level, metadata) => {
            const sink = telemetry?.telemetry;
            const report = sink == null ? undefined : Reflect.get(sink, "reportBoxSecretsPush");
            if (typeof report === "function") report.call(sink, level, metadata);
          },
          isSignedIn: accountLifecycle.isSignedIn,
          isAccountDeparting: accountLifecycle.isAccountDeparting,
          setBoxSecrets: async (request) => {
            const response: unknown = await coordinatorLegs.legs.setBoxSecrets!(request);
            if (typeof response !== "object" || response == null) return {};
            const applied = Reflect.get(response, "isApplied");
            return typeof applied === "boolean" ? { isApplied: applied } : {};
          },
        },
      );
      const backendClientOptions = {
        getAccessToken: async ({ backendUrl }: { readonly backendUrl: string }) => await (await requireValue(account, "account").getAuthService()).getValidAccessToken({ backendUrl }),
        getMachineId: () => machineId,
      };
      const gatewayFastPath = createDesktopGatewayDescriptorFastPath({
        app: bindings.native.app,
        safeStorage: bindings.native.safeStorage,
        getAccountScope: () => accountLifecycle.getAccountScope() ?? undefined,
      });
      const pauseControl = createSandClientPauseControl<BoxConnectionInfo, { readonly preserveData: boolean; readonly force?: boolean }, RecreateResult, { readonly credential: string; readonly backendUrl: string; readonly expiresAtMs?: number }>(
        { checkFeatureGate: (name) => requireValue(experiments, "experiments").checkFeatureGate(name) },
        {
          setGatewayPaused: async (args) => {
            const result = await coordinatorLegs.legs.setGatewayPaused?.(args);
            if (typeof result !== "object" || result == null || typeof Reflect.get(result, "paused") !== "boolean") throw new Error("Electron production coordinator did not return gateway pause state.");
            return { paused: Reflect.get(result, "paused") as boolean };
          },
        },
        connectorEgress,
      );
      clientPauseControl = pauseControl;
      const rawRemoteConnector: SandRemoteHostConnector = createSettingsRoutedHostConnector(createRemoteHostConnector(
          backendClientOptions,
          env,
          { noteBackendUpdateRequirement: (required) => requireValue(update, "update").noteBackendUpdateRequirement(required) },
          gatewayFastPath,
        ), requireValue(settings, "settings").settingsStore, async () => await readSecret(OPENGROK_GATEWAY_TOKEN_SECRET));
      const baseRemoteConnector = wrapRemoteHostConnectorWithDevBoxPlane(
        rawRemoteConnector,
        {
          isPackaged: bindings.native.app.isPackaged,
          emitMigration: (event) => { boxRecovery?.ingestMigration(event); },
          emitPullProgress: (percent) => requireValue(mainEdge, "main-edge").emit("dev-box-pull-progress", { percent }),
          log: (message) => console.log(`[sand][dev-box-recreate] ${message}`),
        },
      );
      const remoteConnector = connectorEgress.wrap(pauseControl.guard(baseRemoteConnector));
      boxRecovery = createProductionBoxRecovery({
        connector: remoteConnector,
        watch: createSandMigrationWatcher(backendClientOptions),
        broadcast: (event) => requireValue(mainEdge, "main-edge").emit("box-migration", event),
        onWatchTelemetry: (event) => {
          const pipes = requireValue(coordinator, "coordinator").getTelemetryReportPipes?.();
          if (pipes == null) throw new Error("Electron production coordinator telemetry pipes are unavailable.");
          pipes.boxMigrationWatch(event);
        },
        restartCoordinator: () => requireValue(coordinator, "coordinator").restartCoordinator(),
        updateForeverBox: (args) => coordinatorLegs.legs.updateForeverBox!(args),
      });
      track(boxRecovery);
      const prioritizeBoxRecoveryDisposal = (): void => {
        const recovery = requireValue(boxRecovery, "box-recovery");
        const index = disposables.indexOf(recovery);
        if (index < 0 || index === disposables.length - 1) return;
        disposables.splice(index, 1);
        disposables.push(recovery);
      };
      const coordinatorResync: ProductionCoordinatorResyncPort = {
        pushHostSettings: (update) => requireValue(coordinator, "coordinator").pushHostSettings(update),
        readHostSettings: () => requireValue(coordinator, "coordinator").readHostSettings(),
      };
      const hostSettingsFields = createDesktopHostSettingsFields({
        read: async () => {
          const settings = await coordinatorResync.readHostSettings();
          if (typeof settings !== "object" || settings == null || Array.isArray(settings)) return {};
          const hasSeenOnboarding = Reflect.get(settings, "hasSeenOnboarding");
          return typeof hasSeenOnboarding === "boolean" ? { hasSeenOnboarding } : {};
        },
        write: (update) => coordinatorResync.pushHostSettings(update),
        store: requireValue(settings, "settings").settingsStore,
        reportPersistence: (report) => {
          const sink = telemetry?.telemetry;
          sink?.reportClientFailure?.(clientFailureReportToTelemetry(report));
        },
      });
      const mcpHost: ProductionMcpHostPort = {
        refreshMcp: (completion) => requireValue(mcp, "mcp").refreshHostMcp(completion),
        syncHostSettings: (update) => coordinatorResync.pushHostSettings(update),
      };
      const base: Omit<ProductionServiceContext, "attachments" | "avatarImages" | "cursorAccount" | "ensureTranscriptionManager"> = {
        native: bindings.native, resources, env, machineId,
        isQuitting: () => quitState !== "idle",
        onCoordinatorLaunched: () => {
          requireValue(clientPauseControl, "client-pause").reapplyAfterCoordinatorLaunch();
          void devGatewayOfflineControl.reapplyAfterCoordinatorLaunch();
        },
        coordinatorLegs, connectorEgress,
        requireEgressTunnelController: () => requireValue(egressTunnelController, "egress-tunnel"),
        coordinatorResync, hostSettingsFields, mcpHost,
        clearGatewayDescriptor: () => gatewayFastPath.store.clear(),
        shouldPreserveComputers: () => shouldPreserveComputersAcrossAccountDeparture(),
        reportFailure: (area, leg, error) => bindings.reportFailure(area, leg, error),
        reportProblem: (area, detail) => bindings.reportFailure(area, "problem", new Error(`${area}: ${detail}`)),
        broadcast, getTrustedContents,
        handleDeepLink: (url) => { deepLinks.handleCandidate(url, "collections"); },
        settings: requireValue(settings, "settings"), secretsStores: requireValue(secretsStores, "secrets-stores"), accountLifecycle, boxRecovery: requireValue(boxRecovery, "box-recovery"),
        shell, windowChrome, getMainWindow: () => runtime?.getMainWindow(), requireMainEdge: () => requireValue(mainEdge, "main-edge"),
        fetchAvailableModels: async () => {
          const response = await fetchSandAvailableModels({
            getAccessToken: async ({ backendUrl }: { readonly backendUrl?: string }) => await (await requireValue(account, "account").getAuthService()).getValidAccessToken(backendUrl == null ? {} : { backendUrl }),
            getMachineId: async () => machineId,
          });
          return response.toJson();
        },
        recordLocalToolApproval: (approval) => persistLocalToolApproval(approval as Parameters<typeof persistLocalToolApproval>[0]),
        clearLocalToolApprovals: () => clearPersistedLocalToolApprovals(),
        requireAccount: () => requireValue(account, "account"), requireExperiments: () => requireValue(experiments, "experiments"),
        requireUpdate: () => requireValue(update, "update"), requireMcp: () => requireValue(mcp, "mcp"),
        requireTelemetry: () => requireValue(telemetry, "telemetry"), readTelemetry: () => telemetry,
        requireNotifications: () => requireValue(notifications, "notifications"), requireCoordinator: () => requireValue(coordinator, "coordinator"),
        requireCoordinatorTelemetry: () => {
          const pipes = requireValue(coordinator, "coordinator").getTelemetryReportPipes?.();
          if (pipes == null) throw new Error("Electron production coordinator telemetry pipes are unavailable.");
          return pipes;
        },
        desktopMetricsRuntime: requireValue(desktopMetricsRuntime, "desktop-metrics"),
        productAnalytics: requireValue(productAnalytics, "product-analytics"),
        createVncTrust: (routeHostInput) => {
          if (vncTrust != null) throw new Error("Electron production VNC trust was already registered.");
          vncTrust = registerElectronProductionVncTrust({
            preloadDistDir: join(resources.preloadPath, ".."),
            routeHostInput,
            onAssetFailure: (failure) => requireValue(telemetry, "telemetry").telemetry.reportVncAssetFail?.({
              vnc_host: failure.host,
              http_status: String(failure.statusCode),
              token_seeded: String(failure.tokenInfo.seeded),
              token_source: failure.tokenInfo.source,
              resource: failure.resource,
            }),
            onUserPresence: (isPresent) => requireValue(mainEdge, "main-edge").emit("vnc-user-presence", { isPresent }),
          });
          return vncTrust;
        },
        boxVisibilityTracker: requireValue(boxVisibilityTracker, "box-visibility"), handleBoxVisibilityReport,
      };
      const attachments = bindings.services.createAttachments(base);
      const avatarImages = bindings.services.createAvatarImages(base);
      cursorAccount = bindings.services.createCursorAccount(base);
      ensureTranscriptionManager = bindings.services.createTranscriptionManager(base);
      context = { ...base, attachments, avatarImages, cursorAccount, ensureTranscriptionManager };
      mainEdge = bindings.services.createMainEdge(context); if (typeof mainEdge.emit !== "function") throw new Error("Electron production main-edge binding did not provide emit()."); if (typeof mainEdge.dispose === "function") track(mainEdge as MainEdge & ProductionDisposable);
      update = track(requireDisposable(await bindings.services.createUpdate(context), "update"));
      track(requireDisposable(bindings.services.registerMedia(context), "media"));
      account = track(requireDisposable(await bindings.services.createAccount(context), "account"));
      accountLifecycle.deliverStatus(await account.getStatus());
      accountStatusUnsubscribe = account.subscribe(() => {
        const sequence = ++accountStatusSequence;
        void account!.getStatus().then((status) => {
          if (!disposed && sequence === accountStatusSequence) accountLifecycle.deliverStatus(status);
        }).catch((error) => bindings.reportFailure("account", "status-refresh", error));
      });
      const startupAuthService = await account.getAuthService();
      await maybeDevLoginFromEnv({
        devLogin: async (options) => {
          if (typeof startupAuthService.devLogin !== "function") throw new Error("Electron production auth service does not expose the shipped dev-login hook.");
          return await startupAuthService.devLogin(options);
        },
      }, env);
      experiments = track(requireDisposable(await bindings.services.createExperiments(context), "experiments"));
      update.attachExperiments(experiments);
      void requireValue(productAnalytics, "product-analytics").activate({
        checkGate: async (name) => requireValue(experiments, "experiments").checkFeatureGate(name),
        subscribe: (listener) => requireValue(experiments, "experiments").subscribe(listener),
      }).catch((error) => bindings.reportFailure("product-analytics", "activate", error));
      mcp = track(requireDisposable(await bindings.services.createMcp(context), "mcp"));
      notifications = track(requireDisposable(bindings.services.createNotifications(context), "notifications"));
      telemetry = track(requireDisposable(await bindings.services.createTelemetry(context), "telemetry"));
      update.attachTelemetry(telemetry.telemetry);
      bindings.startup.attachTelemetry(telemetry.telemetry);
      desktopLifecycle.attach(telemetry.telemetry);
      if (sessionDeathSettlement?.settlePriorSessionAndArm(metadata.version) === true) void telemetry.spillPending?.();
      if (env.SAND_DISABLE_TELEMETRY !== "1") {
        desktopEventLoopSampler = createDesktopEventLoopTelemetry({
          report: (summary, severity) => telemetry?.telemetry.reportDesktopEventLoop(desktopEventLoopPressureMetadata(summary, severity)),
        });
        telemetry.telemetry.setFlushTickListener(() => desktopEventLoopSampler?.onTick());
      }
      coordinator = track(requireDisposable(await bindings.services.createCoordinator(context), "coordinator"));
      prioritizeBoxRecoveryDisposal();
      await coordinator.start(await account.getStatus());
      await experiments.ensureService();
      requireValue(clientPauseControl, "client-pause").reapplyAfterCoordinatorLaunch();
      boxRecovery.start();
      requireValue(settings, "settings").initializeTheme();
      boxVisibilityTracker.noteAccountSlot(desktopStructuredLogAccountSlot(await account.getStatus()));
      if (options?.routeHostInput != null) {
        vncTrust = requireValue(context, "context").createVncTrust(options.routeHostInput);
        registerProductionTelemetryIpc({
          telemetry: () => telemetry?.telemetry,
          productAnalytics: () => productAnalytics,
          getVncTokenInfo: (host) => vncTrust?.getTokenInfo(host),
          coordinatorTelemetry: requireValue(coordinator, "coordinator").getTelemetryReportPipes?.() ?? (() => { throw new Error("Electron production coordinator telemetry pipes are unavailable."); })(),
          desktopMetricsRuntime: requireValue(desktopMetricsRuntime, "desktop-metrics"),
          boxVisibilityTracker: requireValue(boxVisibilityTracker, "box-visibility"),
          handleBoxVisibilityReport,
          isQuitting: () => quitState !== "idle",
          ensureExperimentService: async () => ({ checkFeatureGate: (name: string) => requireValue(experiments, "experiments").checkFeatureGate(name) }),
          reportTelemetrySinkFailure: (failure) => requireValue(telemetry, "telemetry").telemetry.reportTelemetrySinkEdgeFailure?.(failure),
        });
      }
      egressTunnelController = createEgressTunnelWiring({
        observer: connectorEgress,
        broadcastStatus: (status) => requireValue(mainEdge, "main-edge").emit("egress-tunnel-status-changed", status),
        isEnabled: () => requireValue(settings, "settings").settingsStore.getEgressTunnelEnabled(),
        env,
      });
      track(requireDisposable(bindings.services.registerIpc(context), "ipc"));
      registerDevWiring({
        ipcMain: bindings.native.ipcMain,
        isPackaged: bindings.native.app.isPackaged,
        env,
        legs: {
          listAgents: () => coordinatorLegs.legs.listAgents!(),
          createAgent: (request) => coordinatorLegs.legs.createAgent!(request),
          deleteAgents: (request) => coordinatorLegs.legs.deleteAgents!(request),
          getConversationOutline: (request) => coordinatorLegs.legs.getConversationOutline!(request),
          getSubagents: (request) => coordinatorLegs.legs.getSubagents!(request),
        },
        skipOnboarding: () => {
          requireValue(settings, "settings").settingsStore.setHasSeenOnboarding(true);
          requireValue(mainEdge, "main-edge").emit("skip-onboarding", {});
        },
        exitForDevRestart: createDevRestartExit((code) => bindings.native.app.exit(code)),
        reloadMainWindow: () => runtime?.getMainWindow()?.webContents.reload(),
        isGatewayOfflineInduced: () => devGatewayOfflineControl.isInduced(),
        applyGatewayOffline: (induced) => devGatewayOfflineControl.apply(induced),
        clearHasSeenOnboarding: () => requireValue(settings, "settings").settingsStore.clearHasSeenOnboarding(),
        emitForceOnboarding: () => requireValue(mainEdge, "main-edge").emit("force-onboarding", {}),
        themeController: requireValue(settings, "settings").getThemeController(),
        broadcast,
        emitDevBoxRebuild: () => requireValue(mainEdge, "main-edge").emit("dev-box-rebuild", { type: "start" }),
        onControlServerBindError: (port, error) => bindings.reportFailure("dev-controls", `bind:${port}`, error),
      });
      return {
        mainEdge,
        getDevToolsMembershipStatus: () => account!.getStatus(),
        subscribeDevToolsMembership: (listener) => account!.subscribe(listener),
        getThemeBackgroundColor: () => settings!.getThemeBackgroundColor(),
        openExternalUrl: async (value) => { const url = bindings.parseAllowedExternalUrl(value); if (url != null) await mcp!.openExternalUrl(url); },
        registerImageContextMenu: () => bindings.services.registerImageContextMenu?.({
          openExternalUrl: async (value) => { const url = bindings.parseAllowedExternalUrl(value); if (url != null) await mcp!.openExternalUrl(url); },
          onEdgeFailure: (failure) => telemetry?.telemetry.reportImageEdgeFailure?.(failure),
        }),
        configureVncTrust: () => vncTrust?.configureBoxVncSession(),
        hardenVncWebviewAttach: (contents) => vncTrust?.hardenWebviewAttach(contents),
        onWindowCreated: (window) => {
          installWindowResponsivenessTelemetry({
            contents: window.webContents,
            report: desktopLifecycle.reportDesktopRendererLifecycle,
            monotonicNow: () => performance.now(),
          });
          if (sessionDeathSettlement != null) settleUncleanExitOnSessionEnd(window, sessionDeathSettlement);
          installBoxVisibilityDocumentReset(window.webContents, () => boxVisibilityTracker?.abandonAll());
          bindings.services.onWindowCreated?.(window, context!);
        },
        dispose: () => void disposeGraph(),
      };
    } catch (error) { await disposeGraph(); throw error; }
  })();
  const beginBeforeQuit = (): "continue" | "prevent" => {
    if (quitState === "settled" || context == null || telemetry == null) return "continue";
    if (quitState === "flushing") return "prevent";
    quitState = "flushing";
    void (async () => {
      try {
        desktopMetricsRuntime?.disposeProcessMetricsCollector();
        const numericMetrics = desktopMetricsRuntime?.takeClientNumericMetricsManager();
        boxVisibilityTracker?.abandonAll();
        const disposeQuitPhase = async (value: ProductionDisposable | undefined, area: string): Promise<void> => {
          try { await disposeOnce(value); } catch (error) { bindings.reportFailure(area, "dispose", error); }
        };
        await disposeQuitPhase(coordinator, "coordinator");
        try { coordinatorLegs.dispose(); } catch (error) { bindings.reportFailure("coordinator", "legs-dispose", error); }
        await disposeQuitPhase(boxRecovery, "box-recovery");
        await secretsStores?.pushBoxSecrets.quiesce();
        await secretsStores?.pushTelemetry.settled();
        disposeDesktopEventLoopSampler();
        await Promise.all([telemetry!.flushBeforeQuit(), numericMetrics?.flush() ?? Promise.resolve()]);
        numericMetrics?.dispose();
        if (update?.willRunStagedInstallerOnQuit?.() === true) await bindings.services.killLocalExecDaemon?.();
        update?.applyStagedOnQuit?.();
        await disposeQuitPhase(telemetry, "telemetry");
        await disposeQuitPhase(productAnalytics, "product-analytics");
        await disposeQuitPhase(update, "update");
        await disposeQuitPhase(mcp, "mcp");
        await disposeQuitPhase(experiments, "experiments");
      } catch (error) { bindings.reportFailure("telemetry", "quit-flush-race", error); try { await telemetry?.spillPending?.(); } catch (spillError) { bindings.reportFailure("telemetry", "quit-preserve", spillError); } }
      finally { await disposeGraph(); quitState = "settled"; bindings.native.app.quit(); }
    })();
    return "prevent";
  };
  const dependencies: ElectronMainDependencies = {
    app: bindings.native.app,
    menu: createElectronMenuAdapter(bindings.native),
    platform,
    env,
    isLabBuild: metadata.sandLab,
    isAttachProdBox: resources.isAttachProdBox,
    appVersion: metadata.version,
    appName: resources.appName,
    ...(resources.devAppIcon == null ? {} : { devAppIcon: resources.devAppIcon }),
    preloadPath: resources.preloadPath,
    rendererHtmlPath: resources.rendererHtmlPath,
    createBrowserWindow: (options) => new bindings.native.BrowserWindow(options),
    getAllWindows: () => bindings.native.BrowserWindow.getAllWindows(),
    windowStatePersistence,
    deepLinks: { extractCandidatesFromArgv: extractDeepLinkCandidatesFromArgv, handleCandidate: (candidate, source) => { deepLinks.handleCandidate(candidate, source); }, handleArgv: (argv, source) => deepLinks.handleArgv(argv, source), hasPendingActivation: () => deepLinks.hasPendingActivation(), markNotReady: () => deepLinks.markNotReady() },
    startup: {
      bootstrapBeforeSingleInstance: () => { hasIsolatedUserData = bindings.startup.bootstrapUserData({ isLabBuild: metadata.sandLab, env }) != null; },
      bootstrapAfterSingleInstance: (isPrimaryInstance) => { dataRootSettlement = bindings.startup.bootstrapDataRoot({ isPrimaryInstance, isLabBuild: metadata.sandLab, hasIsolatedUserData, env }); },
      markPhase: startupTracker.markPhase,
      runMoveCheck: ({ hasPendingActivation }) => bindings.startup.runMoveCheck({ dataRootSettlement, isLabBuild: metadata.sandLab, hasPendingActivation, beforeExit: startupTracker.cancel }),
      checkFullDiskAccess: () => bindings.startup.checkFullDiskAccess(),
      armStuckWatchdog: startupTracker.armStuckWatchdog,
      noteReady: startupTracker.noteReady,
      noteFailed: startupTracker.noteFailed,
      cancel: startupTracker.cancel,
    },
    initializeFoundation,
    initializeServices,
    syncWindowFocused: (state) => coordinator?.setWindowFocused(state) ?? Promise.resolve(),
    beginBeforeQuit,
  };
  return { dependencies, bindRuntime(value) { runtime = value; } };
}
