import { statSync } from "node:fs";

import type {
  ProductionCoordinatorService,
  ProductionDisposable,
  ProductionServiceContext,
} from "../main-production-services.js";
import {
  createCoordinatorAccountRuntime,
  LOCAL_SUBSCRIPTION_COORDINATOR_SLOT,
  localSubscriptionSlotFromStore,
  type CoordinatorAccountTransition,
  type CoordinatorAuthStatus,
  type CoordinatorRefusedAccountResult,
} from "./coordinator-account-runtime.js";
import {
  createCoordinatorControlExecutors,
  createWebAuthnPromptController,
  type CoordinatorGatewayConnector,
  type WebAuthnPromptWindow,
  type WebAuthnPromptWindowOptions,
} from "./coordinator-executors.js";
import { createCoordinatorHandoffTelemetry } from "./coordinator-handoff-telemetry.js";
import type {
  CoordinatorChildProcess,
  CoordinatorMessageChannel,
  CoordinatorMessagePort,
} from "./coordinator-launcher.js";
import {
  assertTrustedCoordinatorPortRequester,
  type CoordinatorPortRequesterContext,
} from "./coordinator-port-ipc-guard.js";
import {
  createCoordinatorResyncChain,
  type DisabledToolsByServer,
} from "./coordinator-resync.js";
import {
  COORDINATOR_PORT_CHANNEL,
  COORDINATOR_PORT_REQUEST_CHANNEL,
  createCoordinatorRuntime,
  resolveCoordinatorArtifactPath,
} from "./coordinator-runtime.js";
import {
  createCoordinatorRelaunchBackoff,
  createCoordinatorTelemetrySinks,
} from "./coordinator-telemetry.js";
import { createElectronDesktopConnectivity } from "./desktop-connectivity.js";
import type { BoxConnectionInfo } from "../../shared/node/egress-tunnel/box-connection.js";

export interface ProductionCoordinatorAuthStatus extends CoordinatorAuthStatus {
  readonly isAnysphereUser?: boolean;
}

export interface ProductionCoordinatorUtilityProcess {
  fork(
    modulePath: string,
    args: readonly string[],
    options: { readonly serviceName: string },
  ): CoordinatorChildProcess;
}

export interface ProductionCoordinatorMessageChannelConstructor {
  new(): CoordinatorMessageChannel;
}

export interface ProductionCoordinatorGatewayConnector
  extends CoordinatorGatewayConnector {
  issueLocalExecDaemonCredential(): unknown | Promise<unknown>;
}

export type ProductionCoordinatorTelemetryLevel =
  | "debug"
  | "info"
  | "warn"
  | "error";
export type ProductionCoordinatorTelemetryMetadata = Readonly<
  Record<string, string | undefined>
>;

export interface ProductionCoordinatorTelemetryUploader {
  reportBoxReachability(
    level: ProductionCoordinatorTelemetryLevel,
    metadata: ProductionCoordinatorTelemetryMetadata,
  ): void;
  reportBoxDnsDiagnostic(metadata: ProductionCoordinatorTelemetryMetadata): void;
  reportTransportStreamDown(
    level: ProductionCoordinatorTelemetryLevel,
    metadata: ProductionCoordinatorTelemetryMetadata,
  ): void;
  reportCoordinatorLifecycle(
    level: ProductionCoordinatorTelemetryLevel,
    metadata: ProductionCoordinatorTelemetryMetadata,
  ): void;
  reportRecoveryAction(
    level: ProductionCoordinatorTelemetryLevel,
    metadata: ProductionCoordinatorTelemetryMetadata,
  ): void;
  reportBoxMigrationWatch(
    level: ProductionCoordinatorTelemetryLevel,
    metadata: ProductionCoordinatorTelemetryMetadata,
  ): void;
  reportBoxRebuildEscalation(
    level: ProductionCoordinatorTelemetryLevel,
    metadata: ProductionCoordinatorTelemetryMetadata,
  ): void;
  reportBoxRebuildPendingStall(
    metadata: ProductionCoordinatorTelemetryMetadata,
  ): void;
  reportReplicaResync(
    level: ProductionCoordinatorTelemetryLevel,
    metadata: ProductionCoordinatorTelemetryMetadata,
  ): void;
  reportSendJournalRestore(
    level: ProductionCoordinatorTelemetryLevel,
    metadata: ProductionCoordinatorTelemetryMetadata,
  ): void;
  reportResyncCompleted(
    level: ProductionCoordinatorTelemetryLevel,
    metadata: ProductionCoordinatorTelemetryMetadata,
  ): void;
  reportAgentsUnreachable(
    level: ProductionCoordinatorTelemetryLevel,
    metadata: ProductionCoordinatorTelemetryMetadata,
  ): void;
}

export interface ProductionCoordinatorPorts<Status extends ProductionCoordinatorAuthStatus> {
  /** URL of the emitted Electron-main module that will sit under dist/electron-main. */
  readonly electronMainModuleUrl: string;
  readonly utilityProcess: ProductionCoordinatorUtilityProcess;
  readonly MessageChannelMain: ProductionCoordinatorMessageChannelConstructor;
  readonly net: { isOnline(): boolean };
  readonly powerMonitor: { on(event: "resume", listener: () => void): void };
  readonly createWebAuthnPromptWindow: (
    options: WebAuthnPromptWindowOptions,
  ) => WebAuthnPromptWindow;
  readonly localExecNative: NonNullable<
    Parameters<typeof createCoordinatorControlExecutors>[0]["native"]
  >;
  readonly createGatewayConnector: (
    context: ProductionServiceContext,
  ) => ProductionCoordinatorGatewayConnector;
  readonly getDataDir: (context: ProductionServiceContext) => string;
  readonly account: {
    authorizeAccount(
      slot: string,
      transition: CoordinatorAccountTransition,
      context: ProductionServiceContext,
    ): Promise<boolean>;
    revokeRefusedAccount(
      context: ProductionServiceContext,
    ): Promise<CoordinatorRefusedAccountResult<Status>>;
    prepareAccountTransition(
      transition: { readonly previousSlot: string; readonly nextSlot: string | null },
      context: ProductionServiceContext,
    ): Promise<void>;
    resetAccountState(context: ProductionServiceContext): void;
    deliverStatus(status: Status, context: ProductionServiceContext): void;
  };
  readonly resync: {
    getMcpCustomInstructionsAccountScope(): string | null | undefined;
    getMcpCustomInstructionsByServerId(): Record<string, string>;
    getMcpDisabledToolsByServerId(): DisabledToolsByServer;
    setMcpCustomInstructionsByServerId(value: Record<string, string>): void;
    setMcpDisabledToolsByServerId(value: DisabledToolsByServer): void;
    detectTimeZone(): string | null | undefined;
    getUserTimeZoneOverride(): string | null | undefined;
    getComputerUseModel(): unknown;
    getAutoReviewInstructions(): unknown;
    getLocalToolPermission(): unknown;
    getWebauthnProxyEnabled(): unknown;
    getFeatureFlagOverrides(): unknown;
    pushBoxSecrets(): Promise<unknown>;
    onHostSettingsTransportConnected(): void;
    onHostSettingsTransportDown(): void;
  };
  readonly events: {
    onAgentsEvent(payload: unknown): void;
    onAgentsRosterSeed(payload: unknown): void;
    onCoordinatorLaunched(): void;
  };
  readonly telemetry: {
    getUploader(): ProductionCoordinatorTelemetryUploader | null | undefined;
    isQuitting(): boolean;
    isRebuildInFlight(): boolean;
    reportHandoff(
      level: "info" | "warn" | "error",
      metadata: Readonly<Record<string, string | undefined>>,
    ): void;
    recordSendStage(
      report: {
        readonly name: string;
        readonly traceparent: string;
        readonly clientNonce: string;
        readonly startEpochMs: number;
        readonly durationMs: number;
        readonly attributes: { readonly "sand.attempt": number };
        readonly isError: boolean;
      },
    ): void;
    recordGatewayCommandSpan(report: unknown): void;
    reportProcessCrash(report: unknown): void;
    getRpcTraceWindowTraceparent(): string | undefined;
    flushNow(): void | Promise<void>;
  };
  readonly reportProblem: (area: string, detail: string) => void;
  readonly reportFailure: (area: string, leg: string, error: unknown) => void;
}

export interface ProductionCoordinatorAdapter {
  create(context: ProductionServiceContext): ProductionCoordinatorService;
  requestRendererPort(sink: (port: CoordinatorMessagePort) => void): void;
}

function requiredFunction(value: unknown, label: string): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") {
    throw new Error(`Production coordinator requires ${label}.`);
  }
}

function assertCoordinatorArtifact(artifactPath: string): void {
  let isFile = false;
  try {
    isFile = statSync(artifactPath).isFile();
  } catch {
    // The fail-closed error below intentionally does not expose a lower-level
    // asar/filesystem implementation detail as a launchable configuration.
  }
  if (!isFile) {
    throw new Error(
      `Production coordinator artifact is missing or is not a file: ${artifactPath}`,
    );
  }
}

function validateProductionPorts<Status extends ProductionCoordinatorAuthStatus>(
  ports: ProductionCoordinatorPorts<Status>,
): void {
  if (typeof ports.electronMainModuleUrl !== "string" || ports.electronMainModuleUrl.length === 0) {
    throw new Error("Production coordinator requires electronMainModuleUrl.");
  }
  requiredFunction(ports.utilityProcess?.fork, "electron.utilityProcess.fork");
  requiredFunction(ports.MessageChannelMain, "electron.MessageChannelMain");
  requiredFunction(ports.net?.isOnline, "electron.net.isOnline");
  requiredFunction(ports.powerMonitor?.on, "electron.powerMonitor.on");
  requiredFunction(ports.createWebAuthnPromptWindow, "electron BrowserWindow for WebAuthn prompts");
  requiredFunction(ports.localExecNative?.spawnLocalExecDaemon, "local-exec daemon spawn");
  requiredFunction(ports.localExecNative?.terminateProcess, "native process termination");
  requiredFunction(ports.localExecNative?.isProcessAlive, "native process liveness");
  requiredFunction(ports.localExecNative?.readProcessIdentity, "native process identity");
  requiredFunction(ports.createGatewayConnector, "generated gateway connector");
  requiredFunction(ports.getDataDir, "coordinator data-directory resolver");
  requiredFunction(ports.account?.authorizeAccount, "account authorization");
  requiredFunction(ports.account?.revokeRefusedAccount, "refused-account revocation");
  requiredFunction(ports.account?.prepareAccountTransition, "account transition preparation");
  requiredFunction(ports.account?.resetAccountState, "account-state reset");
  requiredFunction(ports.account?.deliverStatus, "account-status delivery");
  requiredFunction(
    ports.resync?.getMcpCustomInstructionsAccountScope,
    "MCP account-scope reader",
  );
  requiredFunction(
    ports.resync?.getMcpCustomInstructionsByServerId,
    "MCP custom-instruction reader",
  );
  requiredFunction(
    ports.resync?.getMcpDisabledToolsByServerId,
    "MCP disabled-tools reader",
  );
  requiredFunction(
    ports.resync?.setMcpCustomInstructionsByServerId,
    "MCP custom-instruction writer",
  );
  requiredFunction(
    ports.resync?.setMcpDisabledToolsByServerId,
    "MCP disabled-tools writer",
  );
  requiredFunction(ports.resync?.detectTimeZone, "desktop time-zone detector");
  requiredFunction(
    ports.resync?.getUserTimeZoneOverride,
    "user time-zone override reader",
  );
  requiredFunction(ports.resync?.getComputerUseModel, "computer-use model reader");
  requiredFunction(
    ports.resync?.getAutoReviewInstructions,
    "auto-review instruction reader",
  );
  requiredFunction(
    ports.resync?.getLocalToolPermission,
    "local-tool permission reader",
  );
  requiredFunction(
    ports.resync?.getWebauthnProxyEnabled,
    "WebAuthn proxy enablement reader",
  );
  requiredFunction(
    ports.resync?.getFeatureFlagOverrides,
    "feature-flag override reader",
  );
  requiredFunction(ports.resync?.pushBoxSecrets, "box-secret resync");
  requiredFunction(
    ports.resync?.onHostSettingsTransportConnected,
    "host-settings transport-connect observer",
  );
  requiredFunction(
    ports.resync?.onHostSettingsTransportDown,
    "host-settings transport-down observer",
  );
  requiredFunction(ports.events?.onAgentsEvent, "agents event consumer");
  requiredFunction(ports.events?.onAgentsRosterSeed, "agents roster seed consumer");
  requiredFunction(
    ports.events?.onCoordinatorLaunched,
    "coordinator-launch observer",
  );
  requiredFunction(ports.telemetry?.getUploader, "coordinator telemetry uploader access");
  requiredFunction(ports.telemetry?.isQuitting, "coordinator quit-state reader");
  requiredFunction(
    ports.telemetry?.isRebuildInFlight,
    "coordinator rebuild-state reader",
  );
  requiredFunction(ports.telemetry?.reportHandoff, "coordinator handoff telemetry");
  requiredFunction(ports.telemetry?.recordSendStage, "send-stage telemetry");
  requiredFunction(ports.telemetry?.recordGatewayCommandSpan, "gateway command telemetry");
  requiredFunction(ports.telemetry?.reportProcessCrash, "coordinator crash telemetry");
  requiredFunction(
    ports.telemetry?.getRpcTraceWindowTraceparent,
    "RPC trace-window reader",
  );
  requiredFunction(ports.telemetry?.flushNow, "coordinator-connect telemetry flush");
  requiredFunction(ports.reportProblem, "coordinator problem reporting");
  requiredFunction(ports.reportFailure, "coordinator edge-failure reporting");
}

/**
 * Composes the shipped Electron-main side of the coordinator boundary. Generated
 * gateway/account collaborators and Electron ABI values remain mandatory ports;
 * this provider never substitutes an in-memory or artifact-backed fallback.
 */
const FULL_DISK_ACCESS_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
let fullDiskAccessPaneOpened = false;
/** Opens the Full Disk Access settings pane at most once per app session. */
function openFullDiskAccessPaneOnce(): void {
  if (fullDiskAccessPaneOpened) return;
  fullDiskAccessPaneOpened = true;
  try { void (require("electron") as { shell: { openExternal(url: string): Promise<unknown> } }).shell.openExternal(FULL_DISK_ACCESS_PANE); }
  catch { /* opening settings is a convenience, never a failure path */ }
}

export function createProductionCoordinatorAdapter<
  Status extends ProductionCoordinatorAuthStatus = ProductionCoordinatorAuthStatus,
>(ports: ProductionCoordinatorPorts<Status>): ProductionCoordinatorAdapter {
  validateProductionPorts(ports);
  const artifactPath = resolveCoordinatorArtifactPath(ports.electronMainModuleUrl);
  assertCoordinatorArtifact(artifactPath);

  let created = false;
  let active:
    | ReturnType<typeof createCoordinatorAccountRuntime<Status>>
    | undefined;

  return {
    create(context) {
      if (created) throw new Error("Production coordinator service was created more than once.");
      created = true;

      const baseConnector = ports.createGatewayConnector(context);
      const connector = context.connectorEgress.wrap({
        ...baseConnector,
        connect: async () => await baseConnector.connect() as BoxConnectionInfo,
      }) as unknown as ProductionCoordinatorGatewayConnector;
      if (connector == null || typeof connector.connect !== "function") {
        throw new Error("Production coordinator gateway connector did not provide connect().");
      }
      requiredFunction(
        connector.issueLocalExecDaemonCredential,
        "generated local-exec credential issuer",
      );
      const dataDir = ports.getDataDir(context);
      if (typeof dataDir !== "string" || dataDir.length === 0) {
        throw new Error("Production coordinator data directory is empty.");
      }
      const accountService = context.requireAccount();
      requiredFunction(
        accountService?.getStatus,
        "production account status reader",
      );
      requiredFunction(
        accountService?.subscribe,
        "production account status subscription",
      );

      const now = () => performance.now();
      const handoff = createCoordinatorHandoffTelemetry(ports.telemetry.reportHandoff);
      const connectivity = createElectronDesktopConnectivity({
        net: ports.net,
        powerMonitor: ports.powerMonitor,
        monotonicNow: now,
      });
      const telemetry = createCoordinatorTelemetrySinks({
        getUploader: ports.telemetry.getUploader,
        connectivity,
        isQuitting: ports.telemetry.isQuitting,
        isRebuildInFlight: ports.telemetry.isRebuildInFlight,
        monotonicNow: now,
      });
      const prompt = createWebAuthnPromptController({
        createWindow: ports.createWebAuthnPromptWindow,
      });
      let focusedState = { isFocused: false };
      let disposed = false;
      let observationSequence = 0;

      const syncWindowFocused = () =>
        context.coordinatorLegs.legs.setWindowFocused!(focusedState);
      const resync = createCoordinatorResyncChain({
        legs: context.coordinatorLegs.legs as {
          getHostSettings(): Promise<any>;
          setHostSettings(update: any): Promise<any>;
        },
        ...ports.resync,
        syncWindowFocused,
        monotonicNow: now,
        onCompleted: telemetry.resyncCompleted,
        reportFailure: (step, error) =>
          ports.reportFailure("coordinator-resync", step, error),
      });
      const executors = createCoordinatorControlExecutors({
        connector,
        webauthnPrompt: prompt,
        recordSendStage: ports.telemetry.recordSendStage,
        recordGatewayCommandSpan: ports.telemetry.recordGatewayCommandSpan,
        onReachability: telemetry.reportBoxReachability,
        onDnsDiagnostic: telemetry.reportBoxDnsDiagnostic,
        onProcessCrash: ports.telemetry.reportProcessCrash,
        getRpcTraceWindowTraceparent: ports.telemetry.getRpcTraceWindowTraceparent,
        listRoutedMcpTools: () => context.requireMcp().listRoutedTools(),
        executeRoutedMcpTool: (request) => context.requireMcp().executeRoutedTool(request),
        runMessagesOp: async (op) => {
          const { runMessagesOp } = await import("../../host/local-exec/messages-op.js");
          const { MESSAGES_FULL_DISK_ACCESS_HINT } = await import("../../host/local-exec/messages-db.js");
          const result = await runMessagesOp(op as never);
          // A routed provider read cannot raise the startup Full Disk Access
          // nudge, so a denial would otherwise only appear as text in the chat.
          // Open the exact settings pane once, the first time a read is refused
          // for want of access, so the fix is one click rather than a hunt.
          if (result.ok === false && result.error === MESSAGES_FULL_DISK_ACCESS_HINT) {
            openFullDiskAccessPaneOnce();
          }
          return result;
        },
        native: ports.localExecNative,
      });
      const createRuntime = () =>
        createCoordinatorRuntime({
          fork: (path, options) =>
            ports.utilityProcess.fork(path, [], { serviceName: options.serviceName }),
          createChannel: () => new ports.MessageChannelMain(),
          executors: executors as unknown as Record<
            string,
            ((args: unknown) => unknown | Promise<unknown>) | undefined
          >,
          onEvent: {
            "agents-event": ports.events.onAgentsEvent,
            "agents-roster-seed": ports.events.onAgentsRosterSeed,
            "transport-connected": (payload) => {
              telemetry.transportStream.onConnected(payload);
              void Promise.resolve(ports.telemetry.flushNow()).catch((error) =>
                ports.reportFailure("coordinator", "connect-flush", error),
              );
              void resync.onTransportConnected();
              ports.resync.onHostSettingsTransportConnected();
              context.hostSettingsFields.onTransportConnected();
            },
            "transport-down": (payload) => {
              telemetry.transportStream.onDown(payload);
              ports.resync.onHostSettingsTransportDown();
              context.hostSettingsFields.setBoxStreamLive(false);
            },
          },
          onMainDataPort: (port) => {
            ports.resync.onHostSettingsTransportDown();
            context.hostSettingsFields.setBoxStreamLive(false);
            try {
              context.coordinatorLegs.adoptPort(
                port as Parameters<typeof context.coordinatorLegs.adoptPort>[0],
              );
            } catch (error) {
              handoff.invokeFailed("main_data_port");
              throw error;
            }
            if (!ports.telemetry.isQuitting()) handoff.adopted("main_data_port");
            ports.events.onCoordinatorLaunched();
          },
          onProblem: (detail) => ports.reportProblem("coordinator", detail),
          onLifecycle: telemetry.coordinatorLifecycle,
          relaunchBackoff: createCoordinatorRelaunchBackoff(),
          monotonicNow: now,
          processConfig: {
            appVersion: context.resources.metadata.version,
            isPackaged: context.native.app.isPackaged,
            dataDir,
          },
          artifactPath,
        });

      const accountRuntime = createCoordinatorAccountRuntime<Status>({
        createRuntime,
        localSlot: () => localSubscriptionSlotFromStore(context.settings.settingsStore),
        authorizeAccount: async (slot, transition) => {
          if (slot === LOCAL_SUBSCRIPTION_COORDINATOR_SLOT) return true;
          return await ports.account.authorizeAccount(slot, transition, context);
        },
        revokeRefusedAccount: () => ports.account.revokeRefusedAccount(context),
        prepareAccountTransition: (transition) => {
          context.accountLifecycle.beginTransition();
          context.hostSettingsFields.onAccountDeparted();
          return ports.account.prepareAccountTransition(transition, context);
        },
        resetAccountState: () => ports.account.resetAccountState(context),
        revokeMainDataPort: () => context.coordinatorLegs.revoke(),
        deliverStatus: (status) => ports.account.deliverStatus(status, context),
        onProblem: (detail) => ports.reportProblem("coordinator-account", detail),
        onExitTimeout: handoff.exitTimeout,
      });
      active = accountRuntime;

      let unsubscribe: () => void;
      try {
        unsubscribe = accountService.subscribe(() => {
          const sequence = ++observationSequence;
          void accountService.getStatus().then(
            (status) => {
              if (disposed || sequence !== observationSequence) return;
              accountRuntime.observe(status as Status);
            },
            (error) =>
              ports.reportFailure("coordinator-account", "status-refresh", error),
          );
        });
      } catch (error) {
        active = undefined;
        void accountRuntime.dispose();
        throw error;
      }
      if (typeof unsubscribe !== "function") {
        active = undefined;
        void accountRuntime.dispose();
        throw new Error(
          "Production account status subscription did not return an unsubscribe function.",
        );
      }

      return {
        start: (status) => accountRuntime.start(status as Status),
        getAccountRuntime: () => active,
        restartCoordinator: () => { void active?.restart(); },
        getTelemetryReportPipes: () => ({
          agentsUnreachable: telemetry.agentsUnreachable,
          recoveryAction: telemetry.recoveryAction,
          rebuildLifecycle: telemetry.rebuildLifecycle,
          reconciliation: telemetry.reconciliation,
          boxMigrationWatch: telemetry.boxMigrationWatch,
          resyncCompleted: telemetry.resyncCompleted,
        }),
        pushHostSettings: (update) => resync.pushHostSettings(update),
        readHostSettings: async () => {
          const getHostSettings = context.coordinatorLegs.legs.getHostSettings;
          requiredFunction(getHostSettings, "coordinator getHostSettings()");
          return await getHostSettings();
        },
        setWindowFocused(state) {
          focusedState = state;
          return syncWindowFocused();
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          observationSequence += 1;
          unsubscribe();
          prompt.finish();
          if (active === accountRuntime) active = undefined;
          await accountRuntime.dispose();
        },
      };
    },
    requestRendererPort(sink) {
      active?.requestRendererPort(sink as (port: unknown) => void);
    },
  };
}

export interface CoordinatorRendererWebContents {
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  postMessage(channel: string, message: unknown, transfer: readonly CoordinatorMessagePort[]): void;
}

export interface CoordinatorRendererPortIpcEvent<
  TContents extends CoordinatorRendererWebContents = CoordinatorRendererWebContents,
  TFrame = unknown,
> {
  readonly sender: TContents;
  readonly senderFrame: TFrame;
}

export interface CoordinatorRendererPortIpcPorts<
  TContents extends CoordinatorRendererWebContents = CoordinatorRendererWebContents,
  TFrame = unknown,
> {
  readonly ipcMain: {
    handle(
      channel: string,
      listener: (event: CoordinatorRendererPortIpcEvent<TContents, TFrame>) => unknown,
    ): void;
    removeHandler(channel: string): void;
  };
  readonly getTrustedContents: () => TContents | null | undefined;
  readonly requestRendererPort: (sink: (port: CoordinatorMessagePort) => void) => void;
  readonly reportHandoff: ProductionCoordinatorPorts<ProductionCoordinatorAuthStatus>["telemetry"]["reportHandoff"];
  readonly reportFailure: (area: string, leg: string, error: unknown) => void;
}

export interface CoordinatorRendererPortIpcRegistrar {
  register(context: ProductionServiceContext): ProductionDisposable;
}

/**
 * Coordinator-specific IPC registration is deliberately separate from service
 * construction so Electron main can preserve the shipped start-before-handle
 * ordering in its broader IPC registration phase.
 */
export function createCoordinatorRendererPortIpcRegistrar<
  TContents extends CoordinatorRendererWebContents = CoordinatorRendererWebContents,
  TFrame = unknown,
>(
  ports: CoordinatorRendererPortIpcPorts<TContents, TFrame>,
): CoordinatorRendererPortIpcRegistrar {
  requiredFunction(ports.ipcMain?.handle, "ipcMain.handle");
  requiredFunction(ports.ipcMain?.removeHandler, "ipcMain.removeHandler");
  requiredFunction(ports.getTrustedContents, "trusted coordinator webContents resolver");
  requiredFunction(ports.requestRendererPort, "coordinator renderer-port requester");
  requiredFunction(ports.reportHandoff, "coordinator renderer handoff telemetry");
  requiredFunction(ports.reportFailure, "coordinator renderer handoff failure reporting");

  let registered = false;
  return {
    register(_context) {
      if (registered) {
        throw new Error("Coordinator renderer-port IPC was registered more than once.");
      }
      registered = true;
      const handoff = createCoordinatorHandoffTelemetry(ports.reportHandoff);
      ports.ipcMain.handle(COORDINATOR_PORT_REQUEST_CHANNEL, (event) => {
        const trustedContents = ports.getTrustedContents();
        assertTrustedCoordinatorPortRequester({
          sender: event.sender,
          senderFrame: event.senderFrame,
          trustedContents,
          trustedMainFrame: trustedContents?.mainFrame as TFrame | null | undefined,
        } satisfies CoordinatorPortRequesterContext<TContents, TFrame>);
        handoff.requested();
        const requester = event.sender;
        ports.requestRendererPort((port) => {
          if (requester.isDestroyed()) return;
          try {
            requester.postMessage(COORDINATOR_PORT_CHANNEL, null, [port]);
          } catch (error) {
            handoff.invokeFailed("renderer_port");
            ports.reportFailure("coordinator", "renderer-port", error);
            throw error;
          }
          handoff.adopted("renderer_port");
        });
        return null;
      });
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          ports.ipcMain.removeHandler(COORDINATOR_PORT_REQUEST_CHANNEL);
          registered = false;
        },
      };
    },
  };
}
