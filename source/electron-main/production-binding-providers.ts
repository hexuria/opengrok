import { join } from "node:path";

import { createGetOrCreateMachineId } from "./account/cursor-machine-id.js";
import {
  getLocalExecDaemonDiscoveryPath,
  readLocalExecDaemonDiscovery,
} from "../host/local-exec/local-exec-daemon-protocol.js";
import { getSandRootDir } from "../host/host-paths.js";
import type {
  ElectronProductionAdapterBindings,
} from "./production-adapters.js";
import type {
  ElectronProductionStartupBindings,
  ProductionServiceContext,
  ProductionTelemetrySink,
} from "./main-production-services.js";
import {
  reportDesktopEdgeFailure,
  reportDesktopEdgeFailureClass,
} from "./desktop-edge-failures.js";
import {
  isLocalExecDaemonProcess,
  isProcessAlive,
  killLocalExecDaemon,
  terminateProcess,
} from "./local-exec/local-exec-native.js";
import { createAgentsControlFeed } from "./notifications/agents-control-feed.js";
import { SandDockBadgeManager } from "./notifications/dock-badge-manager.js";
import {
  SandOsNotificationManager,
  type DesktopNotificationPort,
} from "./notifications/os-notification-manager.js";
import {
  SandThemeController,
  type NativeThemePort,
} from "./prefs/theme-controller.js";
import {
  DesktopSecretStore,
  SECRETS_FILENAME,
  type SecureStorageCodec,
} from "./secrets/secret-store.js";
import {
  bootstrapDesktopDataRoot,
  bootstrapDesktopUserData,
  type DesktopBootstrapApp,
} from "./startup/desktop-user-data-bootstrap.js";
import { runStartupMoveCheck } from "./startup/startup-move-check.js";
import { runFullDiskAccessCheck } from "./startup/full-disk-access-check.js";
import { existsSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { PRE_ATTACH_BUFFER_LIMIT } from "./telemetry/desktop-lifecycle-telemetry.js";
import { DESKTOP_STARTUP_STUCK_MS } from "./telemetry/desktop-startup-telemetry.js";
import {
  captureSandDesktopStartupFailure,
  captureSandSentryWarning,
} from "./telemetry/sentry.js";
import { computeUpdateDisabledReason } from "./update/update-gate.js";
import { createUpdateTelemetryRelay } from "./update/update-telemetry.js";
import { createUpdateServiceWiring } from "./update/update-wiring.js";
import { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";
import { SAND_NOTIFICATION_SOUNDS_GATE } from "../shared/notification-sound.js";
import { isSandUpdateTrack } from "../shared/update-track.js";
import { delay } from "../shared/node/async.js";
import {
  registerSandMediaProtocol,
  registerSandMediaScheme,
  setSandMediaRemoteReader,
} from "./media/media-protocol.js";

/** Where the "Don't ask again" choice for the Full Disk Access nudge is remembered. */
function fullDiskAccessMarkerPath(): string { return join(getSandRootDir(), "full-disk-access-prompt.json"); }

type SecureStorageBinding = ElectronProductionAdapterBindings["secureStorage"];
type SettingsBinding = ElectronProductionAdapterBindings["settings"];
type UpdaterInstallerBinding = ElectronProductionAdapterBindings["updaterInstaller"];
type MediaProtocolBinding = ElectronProductionAdapterBindings["mediaProtocol"];
type NotificationsBinding = ElectronProductionAdapterBindings["notifications"];

export interface ElectronSecureStorageProviderPorts {
  readonly app: {
    readonly isPackaged: boolean;
    getPath(name: "userData"): string;
  };
  readonly safeStorage: SecureStorageCodec;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly warn?: (message: string) => void;
  readonly reportFailure?: (
    operation: "linux-backend" | "write",
    error: unknown,
  ) => void;
}

export interface ElectronMediaProtocolProviderPorts {
  readonly protocol: {
    registerSchemesAsPrivileged(schemes: unknown[]): void;
    handle(
      scheme: string,
      handler: (request: Request) => Promise<Response>,
    ): void;
  };
}

export interface ElectronSettingsProviderPorts {
  readonly nativeTheme: NativeThemePort;
  readonly getSandRootDir?: () => string;
}

export interface ElectronUpdaterInstallerProviderPorts {
  readonly electron: Parameters<typeof createUpdateServiceWiring>[0]["electron"];
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export interface ElectronNotificationsProviderPorts {
  readonly Notification: {
    new(options: {
      readonly title: string;
      readonly body: string;
      readonly silent: boolean;
      readonly urgency: "critical" | "normal";
    }): DesktopNotificationPort;
    isSupported(): boolean;
  };
  readonly app: { setBadgeCount(count: number): unknown };
}

export interface ElectronStartupProviderPorts {
  readonly app: DesktopBootstrapApp & {
    isInApplicationsFolder(): boolean;
    moveToApplicationsFolder(): boolean;
    relaunch(options: { readonly args: readonly string[] }): void;
    exit(code: number): void;
  };
  readonly dialog: {
    showMessageBox(options: Record<string, unknown>): Promise<{ readonly response: number }>;
  };
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly readDiscovery?: () => Promise<{ readonly pid: number; readonly entryRealpath?: string; readonly generationToken?: string; readonly inflightCount?: number } | null>;
  readonly isDaemonProcess?: (pid: number, discovery: { readonly entryRealpath?: string; readonly generationToken?: string }) => boolean;
  readonly terminate?: (pid: number) => Promise<void>;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly scheduleStuck?: (listener: () => void) => void;
  readonly monotonicNow?: () => number;
  readonly captureFailure?: (error: unknown, phase: string) => void;
}

function requireFunction(
  value: unknown,
  label: string,
): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") {
    throw new Error(`Electron production binding requires ${label}.`);
  }
}

/**
 * Exact secret-store/machine-id composition from the emitted main process.
 * Construction stays lazy so a startup-owned userData override, when supplied,
 * is resolved before the immutable `sand-secrets.json` path is captured.
 */
export function createProductionSecureStorageBinding(
  ports: ElectronSecureStorageProviderPorts,
): SecureStorageBinding {
  requireFunction(ports?.app?.getPath, "electron.app.getPath().");
  requireFunction(
    ports?.safeStorage?.isEncryptionAvailable,
    "electron.safeStorage.isEncryptionAvailable().",
  );
  requireFunction(
    ports?.safeStorage?.encryptString,
    "electron.safeStorage.encryptString().",
  );
  requireFunction(
    ports?.safeStorage?.decryptString,
    "electron.safeStorage.decryptString().",
  );

  let store: DesktopSecretStore | undefined;
  let getMachineId: (() => Promise<string>) | undefined;
  const requireStore = (): DesktopSecretStore => {
    store ??= new DesktopSecretStore({
      filePath: join(ports.app.getPath("userData"), SECRETS_FILENAME),
      safeStorage: ports.safeStorage,
      isPackaged: ports.app.isPackaged,
      ...(ports.env === undefined ? {} : { env: ports.env }),
      ...(ports.platform === undefined ? {} : { platform: ports.platform }),
      ...(ports.warn === undefined ? {} : { warn: ports.warn }),
      ...(ports.reportFailure === undefined
        ? {}
        : { reportFailure: ports.reportFailure }),
    });
    return store;
  };

  return {
    initialize(): void {
      requireStore().initializeSecureStorage();
    },
    getMachineId(): Promise<string> {
      const secrets = requireStore();
      getMachineId ??= createGetOrCreateMachineId({
        readSecret: (key) => secrets.readSecret(key),
        writeSecret: (key, value) => secrets.writeSecret(key, value),
        waitForEncryptedStorage: async () => {
          await secrets.waitForEncryptedStorage();
        },
      });
      return getMachineId();
    },
  };
}

/** Manifest-call export. Electron remains a real bare runtime dependency. */
export function createElectronProductionSecureStorageBinding(): SecureStorageBinding {
  const electron = require("electron") as {
    readonly app: ElectronSecureStorageProviderPorts["app"];
    readonly safeStorage: SecureStorageCodec;
  };
  return createProductionSecureStorageBinding({
    app: electron.app,
    safeStorage: electron.safeStorage,
    env: process.env,
    platform: process.platform,
    warn: captureSandSentryWarning,
    reportFailure: (operation, error) =>
      reportDesktopEdgeFailure("secret-store", operation, error),
  });
}

/**
 * The settings store is created at the pre-ready foundation phase. Theme
 * observation is activated later, after the coordinator has started and the
 * main edge exists, matching the emitted constructor order.
 */
export function createProductionSettingsBinding(
  ports: ElectronSettingsProviderPorts,
): SettingsBinding {
  requireFunction(ports?.nativeTheme?.on, "electron.nativeTheme.on().");
  requireFunction(
    ports?.nativeTheme?.removeListener,
    "electron.nativeTheme.removeListener().",
  );
  const resolveRoot = ports.getSandRootDir ?? getSandRootDir;
  requireFunction(resolveRoot, "Sand data-root resolver.");

  let created = false;
  return {
    create(args) {
      if (created) throw new Error("Electron production settings service was created more than once.");
      created = true;
      const settingsStore = new SandSettingsStore(join(resolveRoot(), "settings.json"));
      let themeController: SandThemeController | undefined;
      let disposed = false;
      const requireThemeController = (): SandThemeController => {
        if (disposed) throw new Error("Electron production settings service is disposed.");
        if (themeController == null) throw new Error("Electron production theme controller was used before initialization.");
        return themeController;
      };
      return {
        settingsStore,
        initializeTheme(): void {
          if (disposed) throw new Error("Electron production settings service is disposed.");
          if (themeController != null) return;
          themeController = new SandThemeController(
            settingsStore,
            args.emitThemeChanged,
            ports.nativeTheme,
          );
        },
        getThemeController: requireThemeController,
        getThemeBackgroundColor(): string {
          return requireThemeController().getWindowBackgroundColor();
        },
        dispose(): void {
          if (disposed) return;
          disposed = true;
          themeController?.dispose();
          themeController = undefined;
        },
      };
    },
  };
}

/** Manifest-call export. Electron remains a real bare runtime dependency. */
export function createElectronProductionSettingsBinding(): SettingsBinding {
  const electron = require("electron") as {
    readonly nativeTheme: NativeThemePort;
  };
  return createProductionSettingsBinding({
    nativeTheme: electron.nativeTheme,
    getSandRootDir,
  });
}

function coordinatorHostStatus(context: ProductionServiceContext): () => Promise<{ isBusy: boolean }> {
  const value = context.coordinatorLegs.legs.getHostStatus;
  requireFunction(value, "coordinator getHostStatus().");
  return value as unknown as () => Promise<{ isBusy: boolean }>;
}

/**
 * Exact update-service wiring with the two later lifecycle joins present in the
 * artifact: experiment gate subscription and buffered telemetry attachment.
 */
export function createProductionUpdaterInstallerBinding(
  ports: ElectronUpdaterInstallerProviderPorts,
): UpdaterInstallerBinding {
  requireFunction(ports?.electron?.app?.getPath, "electron.app.getPath().");
  requireFunction(ports?.electron?.app?.quit, "electron.app.quit().");
  requireFunction(ports?.electron?.powerMonitor?.getSystemIdleState, "electron.powerMonitor.getSystemIdleState().");
  requireFunction(ports?.electron?.powerMonitor?.getSystemIdleTime, "electron.powerMonitor.getSystemIdleTime().");
  const env = ports.env ?? process.env;
  const platform = ports.platform ?? process.platform;
  let created = false;
  return {
    async create(context) {
      if (created) throw new Error("Electron production updater service was created more than once.");
      created = true;
      const relay = createUpdateTelemetryRelay();
      const getHostStatus = coordinatorHostStatus(context);
      const updateService = createUpdateServiceWiring({
        currentVersion: context.resources.metadata.version,
        buildDefaultTrack: isSandUpdateTrack(context.resources.metadata.sandTrack)
          ? context.resources.metadata.sandTrack
          : null,
        disabledReason: computeUpdateDisabledReason({
          envDisabled: env.SAND_DISABLE_UPDATES === "1",
          isLabBuild: context.resources.metadata.sandLab,
          hasDevFeedOverride: (env.SAND_UPDATE_FEED_BASE_URL?.length ?? 0) > 0,
          isPackaged: context.native.app.isPackaged,
          platform,
        }),
        machineId: context.machineId,
        electron: ports.electron,
        settingsStore: context.settings.settingsStore,
        getExperimentService: () => {
          try { return context.requireExperiments(); }
          catch { return null; }
        },
        getHostStatus,
        emitStatus: (status) => context.requireMainEdge().emit("update-status", status),
        reportOutcome: relay.reportOutcome,
        reportCheck: relay.reportCheck,
        reportApply: relay.reportApply,
        env,
        platform,
      });
      let experimentUnsubscribe: (() => void) | undefined;
      let experimentsAttached = false;
      let telemetryAttached = false;
      let disposed = false;
      return {
        updateService,
        attachExperiments(experiments): void {
          if (disposed) throw new Error("Electron production updater service is disposed.");
          if (experimentsAttached) throw new Error("Electron production updater experiments were attached more than once.");
          experimentsAttached = true;
          experimentUnsubscribe = experiments.subscribe(() => {
            updateService.noteMinimumVersionMayHaveChanged();
            updateService.noteReleaseTrackGateMayHaveChanged();
          });
          updateService.noteMinimumVersionMayHaveChanged();
          updateService.noteReleaseTrackGateMayHaveChanged();
        },
        attachTelemetry(telemetry): void {
          if (disposed) throw new Error("Electron production updater service is disposed.");
          if (telemetryAttached) throw new Error("Electron production updater telemetry was attached more than once.");
          telemetryAttached = true;
          relay.attach(telemetry);
        },
        noteBackendUpdateRequirement: (required) => updateService.noteBackendUpdateRequirement(required),
        willRunStagedInstallerOnQuit: () => updateService.willRunStagedInstallerOnQuit(),
        applyStagedOnQuit: () => updateService.applyStagedOnQuit(),
        dispose(): void {
          if (disposed) return;
          disposed = true;
          experimentUnsubscribe?.();
          experimentUnsubscribe = undefined;
          updateService.dispose();
        },
      };
    },
    killLocalExecDaemon: () => killLocalExecDaemon(getLocalExecDaemonDiscoveryPath()),
  };
}

/** Manifest-call export. Electron remains a real bare runtime dependency. */
export function createElectronProductionUpdaterInstallerBinding(): UpdaterInstallerBinding {
  const electron = require("electron") as {
    readonly app: ElectronUpdaterInstallerProviderPorts["electron"]["app"];
    readonly autoUpdater: ElectronUpdaterInstallerProviderPorts["electron"]["autoUpdater"];
    readonly powerMonitor: ElectronUpdaterInstallerProviderPorts["electron"]["powerMonitor"];
  };
  return createProductionUpdaterInstallerBinding({
    electron: {
      app: electron.app,
      autoUpdater: electron.autoUpdater,
      powerMonitor: electron.powerMonitor,
    },
    env: process.env,
    platform: process.platform,
  });
}

/**
 * Native notification managers plus the exact coordinator event/reset join.
 * The service itself is created before coordinator/telemetry in the production
 * composition, as in the emitted main bundle.
 */
export function createProductionNotificationsBinding(
  ports: ElectronNotificationsProviderPorts,
): NotificationsBinding {
  requireFunction(ports?.Notification, "electron.Notification constructor.");
  requireFunction(ports?.Notification?.isSupported, "electron.Notification.isSupported().");
  requireFunction(ports?.app?.setBadgeCount, "electron.app.setBadgeCount().");
  let created = false;
  return {
    create(context) {
      if (created) throw new Error("Electron production notifications service was created more than once.");
      created = true;
      const osNotifications = new SandOsNotificationManager({
        getWindow: () => context.getMainWindow() ?? null,
        isSupported: () => ports.Notification.isSupported(),
        createNotification: (options) => new ports.Notification(options),
        openAgent: (agentId) => context.requireMainEdge().emit("focus-agent", { id: agentId }),
        // Main decides that a notification is due; the renderer owns the audio
        // element, so the tone leaves over the same edge as focus-agent.
        playSound: (sound) => context.requireMainEdge().emit("notification-sound", { sound }),
        getPreferences: () => context.settings.settingsStore.getDesktopNotificationPreferences(),
        isSoundsFeatureEnabled: () => context.requireExperiments().checkFeatureGate(SAND_NOTIFICATION_SOUNDS_GATE),
      });
      const dockBadge = new SandDockBadgeManager({
        setBadgeCount: (count) => { ports.app.setBadgeCount(count); },
        reportFailure: (operation, error) => reportDesktopEdgeFailure("dock-badge", operation, error),
      });
      const feed = createAgentsControlFeed({ osNotifications, dockBadge });
      let disposed = false;
      const reset = (): void => {
        osNotifications.reset();
        dockBadge.reset();
      };
      return {
        onAgentsEvent: feed["agents-event"],
        onAgentsRosterSeed: feed["agents-roster-seed"],
        resetAccountState: reset,
        dispose(): void {
          if (disposed) return;
          disposed = true;
          reset();
        },
      };
    },
  };
}

/** Manifest-call export. Electron remains a real bare runtime dependency. */
export function createElectronProductionNotificationsBinding(): NotificationsBinding {
  const electron = require("electron") as ElectronNotificationsProviderPorts;
  return createProductionNotificationsBinding({
    Notification: electron.Notification,
    app: electron.app,
  });
}

/**
 * Startup owns both sides of the single-instance boundary. Its telemetry relay
 * buffers the tracker start/ready/failure records until structured logging is
 * constructed later in the ready chain.
 */
export function createProductionStartupBinding(
  ports: ElectronStartupProviderPorts,
): ElectronProductionStartupBindings {
  for (const [value, label] of [
    [ports?.app?.setPath, "electron.app.setPath()."],
    [ports?.app?.getPath, "electron.app.getPath()."],
    [ports?.app?.isInApplicationsFolder, "electron.app.isInApplicationsFolder()."],
    [ports?.app?.moveToApplicationsFolder, "electron.app.moveToApplicationsFolder()."],
    [ports?.app?.relaunch, "electron.app.relaunch()."],
    [ports?.app?.exit, "electron.app.exit()."],
    [ports?.dialog?.showMessageBox, "electron.dialog.showMessageBox()."],
  ] as const) requireFunction(value, label);
  const argv = ports.argv ?? process.argv;
  const env = ports.env ?? process.env;
  const platform = ports.platform ?? process.platform;
  const buffered: Array<{ readonly level: Parameters<ProductionTelemetrySink["reportDesktopStartup"]>[0]; readonly metadata: Parameters<ProductionTelemetrySink["reportDesktopStartup"]>[1] }> = [];
  let telemetry: ProductionTelemetrySink | undefined;
  const report: ElectronProductionStartupBindings["report"] = (level, metadata) => {
    if (telemetry != null) {
      telemetry.reportDesktopStartup(level, metadata);
      return;
    }
    if (buffered.length >= PRE_ATTACH_BUFFER_LIMIT) buffered.shift();
    buffered.push({ level, metadata });
  };
  return {
    bootstrapUserData: ({ isLabBuild, env: bootstrapEnv }) => bootstrapDesktopUserData({
      isLabBuild,
      app: ports.app,
      argv,
      env: bootstrapEnv,
      platform,
      ...(ports.cwd === undefined ? {} : { cwd: ports.cwd }),
      reportFailureClass: reportDesktopEdgeFailureClass,
    }),
    bootstrapDataRoot: ({ isPrimaryInstance, isLabBuild, hasIsolatedUserData, env: bootstrapEnv }) => bootstrapDesktopDataRoot({
      isPrimaryInstance,
      isLabBuild,
      hasIsolatedUserData,
      app: ports.app,
      env: bootstrapEnv,
      ...(ports.homeDir === undefined ? {} : { homeDir: ports.homeDir }),
      reportFailureClass: reportDesktopEdgeFailureClass,
    }),
    runMoveCheck: (args) => runStartupMoveCheck(args, {
      platform,
      argv,
      env,
      app: ports.app,
      dialog: ports.dialog,
      readDiscovery: ports.readDiscovery ?? (() => readLocalExecDaemonDiscovery()),
      isDaemonProcess: ports.isDaemonProcess ?? ((pid, discovery) => isLocalExecDaemonProcess(pid, discovery.entryRealpath, discovery.generationToken)),
      terminate: ports.terminate ?? terminateProcess,
      isProcessAlive: ports.isProcessAlive ?? isProcessAlive,
      reportFailure: reportDesktopEdgeFailure,
      reportFailureClass: reportDesktopEdgeFailureClass,
    }),
    checkFullDiskAccess: () => runFullDiskAccessCheck({
      platform,
      dialog: ports.dialog,
      openExternal: (url) => promisify(execFile)("/usr/bin/open", [url]),
      relaunch: async () => {
        // macOS fixes a process's file access when it starts. The helper that
        // actually opens the database outlives an app relaunch and would be
        // adopted with its old, denied decision still cached, so it has to be
        // stopped too or the freshly granted permission appears to do nothing.
        try {
          const discovery = await readLocalExecDaemonDiscovery();
          if (discovery != null && isLocalExecDaemonProcess(discovery.pid, discovery.entryRealpath, discovery.generationToken)) {
            await terminateProcess(discovery.pid);
          }
        } catch { /* never let helper cleanup block the restart */ }
        ports.app.relaunch({ args: [] });
        ports.app.exit(0);
      },
      hasAsked: () => existsSync(fullDiskAccessMarkerPath()),
      markAsked: () => { try { writeFileSync(fullDiskAccessMarkerPath(), `${JSON.stringify({ dismissed: true })}\n`); } catch { /* a nudge must never break startup */ } },
      reportFailure: reportDesktopEdgeFailure,
    }),
    report,
    captureFailure: ports.captureFailure ?? captureSandDesktopStartupFailure,
    scheduleStuck: ports.scheduleStuck ?? ((listener) => { void delay(DESKTOP_STARTUP_STUCK_MS).then(listener); }),
    monotonicNow: ports.monotonicNow ?? (() => performance.now()),
    attachTelemetry(next): void {
      if (telemetry != null) throw new Error("Electron production startup telemetry was attached more than once.");
      telemetry = next;
      for (const record of buffered.splice(0)) telemetry.reportDesktopStartup(record.level, record.metadata);
    },
  };
}

/** Manifest-call export. Electron remains a real bare runtime dependency. */
export function createElectronProductionStartupBinding(): ElectronProductionStartupBindings {
  const electron = require("electron") as {
    readonly app: ElectronStartupProviderPorts["app"];
    readonly dialog: ElectronStartupProviderPorts["dialog"];
  };
  return createProductionStartupBinding({
    app: electron.app,
    dialog: electron.dialog,
    argv: process.argv,
    env: process.env,
    platform: process.platform,
  });
}

function coordinatorAttachmentReader(context: ProductionServiceContext): {
  readAttachmentChunk(args: {
    readonly path: string;
    readonly offset: number;
    readonly length: number;
    readonly videoPlayback: boolean;
  }): Promise<{
    readonly bytesBase64: string;
    readonly totalSize: number;
    readonly mime?: string | null;
  } | null>;
} {
  const value = context.coordinatorLegs.legs.readAttachmentChunk;
  requireFunction(value, "coordinator readAttachmentChunk().");
  return {
    readAttachmentChunk: value as unknown as ReturnType<
      typeof coordinatorAttachmentReader
    >["readAttachmentChunk"],
  };
}

/**
 * Exact privileged-scheme and protocol registration. The disposable only
 * revokes the process-global remote reader owned by this adapter; Electron's
 * protocol handler itself has the same application lifetime as in the artifact.
 */
export function createProductionMediaProtocolBinding(
  ports: ElectronMediaProtocolProviderPorts,
): MediaProtocolBinding {
  requireFunction(
    ports?.protocol?.registerSchemesAsPrivileged,
    "electron.protocol.registerSchemesAsPrivileged().",
  );
  requireFunction(ports?.protocol?.handle, "electron.protocol.handle().");

  let schemeRegistered = false;
  let protocolRegistered = false;
  return {
    registerScheme(): void {
      if (schemeRegistered) {
        throw new Error("Electron production media scheme is already registered.");
      }
      registerSandMediaScheme(ports.protocol);
      schemeRegistered = true;
    },
    register(context: ProductionServiceContext) {
      if (protocolRegistered) {
        throw new Error("Electron production media protocol is already registered.");
      }
      const reader = coordinatorAttachmentReader(context);
      setSandMediaRemoteReader({
        async readChunk(path, offset, length, videoPlayback) {
          const chunk = await reader.readAttachmentChunk({
            path,
            offset,
            length,
            videoPlayback,
          });
          if (chunk == null) return null;
          return {
            data: Buffer.from(chunk.bytesBase64, "base64"),
            totalSize: chunk.totalSize,
            ...(chunk.mime == null ? {} : { mime: chunk.mime }),
          };
        },
      });
      try {
        registerSandMediaProtocol(ports.protocol);
        protocolRegistered = true;
      } catch (error) {
        setSandMediaRemoteReader(null);
        throw error;
      }
      let disposed = false;
      return {
        dispose(): void {
          if (disposed) return;
          disposed = true;
          setSandMediaRemoteReader(null);
        },
      };
    },
  };
}

/** Manifest-call export. Electron remains a real bare runtime dependency. */
export function createElectronProductionMediaProtocolBinding(): MediaProtocolBinding {
  const electron = require("electron") as {
    readonly protocol: ElectronMediaProtocolProviderPorts["protocol"];
  };
  return createProductionMediaProtocolBinding({ protocol: electron.protocol });
}
