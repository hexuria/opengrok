import { join } from "node:path";

import { installApplicationMenu, type ApplicationMenuElectronPort } from "./application-menu.js";
import { getSandRootDir } from "../host/host-paths.js";
import { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";
import { trustSystemCertificateAuthorities } from "../shared/node/trust-system-ca.js";
import { reportDesktopEdgeFailure } from "./desktop-edge-failures.js";
import { createDevToolsGate, createDevToolsMembershipResolver } from "./devtools-gate.js";
import {
  createHostWindowChords,
  type HostInputEvent,
  type HostWindowInput,
} from "./host-window-chords.js";
import {
  attachWindowFocusForwarding,
  attachWindowStateBroadcast,
  createWindowFocusSync,
  createWindowsTitleBarOverlaySession,
  windowChromeOptions,
  type Rectangle,
  type WindowState,
  type WindowsTitleBarOverlay,
} from "./window-chrome.js";
import type { SandWindowPlacement, WindowStatePersistenceWindow } from "./window-state-persistence.js";
import { createElectronMainProductionComposition, type ElectronMainProductionBindings } from "./main-production-services.js";

export interface PreventableEvent {
  preventDefault(): void;
}

export interface MainWebContents {
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  isDevToolsOpened(): boolean;
  closeDevTools(): void;
  openDevTools(options: { readonly mode: "detach" }): void;
  toggleDevTools(): void;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  reload(): void;
  executeJavaScript(script: string, userGesture: boolean): Promise<unknown>;
  getURL(): string;
  setWindowOpenHandler(
    handler: (details: { readonly url: string }) => { readonly action: "deny" },
  ): void;
  on(
    event: "before-input-event",
    listener: (event: HostInputEvent, input: HostWindowInput) => void,
  ): void;
  on(event: "will-navigate", listener: (event: PreventableEvent, url: string) => void): void;
  on(
    event: "will-frame-navigate",
    listener: (details: PreventableEvent & { readonly isMainFrame: boolean; readonly url: string }) => void,
  ): void;
  on(event: "did-start-loading", listener: () => void): void;
  on(event: "unresponsive" | "responsive", listener: () => void): void;
}

export interface MainBrowserWindow extends WindowStatePersistenceWindow {
  readonly webContents: MainWebContents;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  isFocused(): boolean;
  setFullScreen(fullscreen: boolean): void;
  setTitleBarOverlay?(overlay: WindowsTitleBarOverlay): void;
  loadURL(url: string): Promise<unknown>;
  loadFile(file: string): Promise<unknown>;
  on(
    event:
      | "resize"
      | "move"
      | "maximize"
      | "unmaximize"
      | "close"
      | "enter-full-screen"
      | "leave-full-screen"
      | "focus"
      | "blur"
      | "session-end"
      | "closed",
    listener: () => void,
  ): void;
}

export interface ElectronMainApp {
  readonly isPackaged: boolean;
  disableHardwareAcceleration(): void;
  readonly commandLine: { readonly appendSwitch: (name: string) => void };
  requestSingleInstanceLock(): boolean;
  quit(): void;
  isReady(): boolean;
  whenReady(): Promise<unknown>;
  on(event: "second-instance", listener: (event: unknown, argv: readonly string[]) => void): void;
  on(event: "open-url", listener: (event: PreventableEvent, url: string) => void): void;
  on(event: "activate" | "window-all-closed", listener: () => void): void;
  on(event: "before-quit", listener: (event: PreventableEvent) => void): void;
  on(event: "will-quit", listener: () => void): void;
  on(
    event: "render-process-gone",
    listener: (event: unknown, contents: MainWebContents, details: { readonly reason: string; readonly exitCode?: number }) => void,
  ): void;
  on(
    event: "child-process-gone",
    listener: (event: unknown, details: { readonly type: string; readonly serviceName?: string; readonly reason: string; readonly exitCode?: number }) => void,
  ): void;
}

export interface MainEdge {
  emit(event: string, payload: unknown): void;
}

export interface ElectronMainServices {
  readonly mainEdge: MainEdge;
  readonly getDevToolsMembershipStatus: () => Promise<{
    readonly kind: string;
    readonly isAnysphereUser?: boolean;
  }>;
  readonly subscribeDevToolsMembership: (listener: () => void) => () => void;
  readonly getThemeBackgroundColor: () => string;
  readonly openExternalUrl: (url: string) => Promise<unknown>;
  readonly configureVncTrust?: () => void;
  readonly hardenVncWebviewAttach?: (contents: MainWebContents) => void;
  readonly onWindowCreated?: (window: MainBrowserWindow) => void;
  /** Process-lifetime image context-menu listener installed after the application menu. */
  readonly registerImageContextMenu?: () => void;
  readonly dispose?: () => void | Promise<void>;
}

export interface ElectronMainServicesInitializationOptions {
  readonly routeHostInput: (input: HostWindowInput) => boolean;
}

export interface MainWindowStatePersistence {
  readonly resolveSandWindowPlacement: () => SandWindowPlacement;
  readonly applySandWindowPlacement: (
    window: WindowStatePersistenceWindow,
    placement: SandWindowPlacement,
  ) => void;
}

export interface ElectronMainDependencies {
  readonly app: ElectronMainApp;
  readonly menu: ApplicationMenuElectronPort;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly isLabBuild?: boolean;
  readonly isAttachProdBox?: boolean;
  readonly appVersion?: string;
  readonly appName: string;
  readonly devAppIcon?: string;
  readonly preloadPath: string;
  readonly rendererHtmlPath: string;
  readonly createBrowserWindow: (options: MainBrowserWindowOptions) => MainBrowserWindow;
  readonly getAllWindows: () => readonly MainBrowserWindow[];
  readonly windowStatePersistence: MainWindowStatePersistence;
  readonly deepLinks: {
    readonly extractCandidatesFromArgv: (argv: readonly string[]) => readonly string[];
    readonly handleCandidate: (candidate: string, source: "second-instance" | "open-url") => void;
    readonly handleArgv: (argv: readonly string[], source: "initial-argv") => void;
    readonly hasPendingActivation: () => boolean;
    readonly markNotReady: () => void;
  };
  readonly startup: {
    readonly bootstrapBeforeSingleInstance: () => void;
    readonly bootstrapAfterSingleInstance: (isPrimaryInstance: boolean) => void;
    readonly markPhase: (phase: "move_check" | "services" | "window") => void;
    readonly runMoveCheck: (input: { readonly hasPendingActivation: () => boolean }) => Promise<"continue-bootstrap" | "stop-bootstrap">;
    readonly checkFullDiskAccess: () => Promise<string>;
    readonly armStuckWatchdog: () => void;
    readonly noteReady: () => void;
    readonly noteFailed: (error: unknown) => void;
    readonly cancel: () => void;
  };
  readonly initializeFoundation: () => void;
  readonly initializeServices: (options?: ElectronMainServicesInitializationOptions) => Promise<ElectronMainServices>;
  readonly syncWindowFocused: (state: { readonly isFocused: boolean }) => Promise<unknown>;
  readonly beginBeforeQuit?: () => "continue" | "prevent";
}

export interface MainBrowserWindowOptions {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly title: string;
  readonly icon?: string;
  readonly backgroundColor: string;
  readonly frame: boolean;
  readonly titleBarStyle: "hiddenInset" | "hidden" | "default";
  readonly trafficLightPosition?: { readonly x: number; readonly y: number };
  readonly titleBarOverlay?: WindowsTitleBarOverlay;
  readonly webPreferences: {
    readonly contextIsolation: true;
    readonly nodeIntegration: false;
    readonly preload: string;
    readonly sandbox: false;
    readonly webviewTag: true;
  };
}

export interface ElectronMainRuntime {
  readonly isPrimaryInstance: boolean;
  readonly isQuitting: () => boolean;
  readonly getMainWindow: () => MainBrowserWindow | undefined;
  readonly ensureMainWindow: () => void;
  readonly setTitleBarOverlayTone: (isOverlayTone: boolean) => void;
  readonly syncWindowsTitleBarOverlay: () => void;
}

export function configureDesktopEnvironment(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly isPackaged: boolean;
  readonly isAttachProdBox: boolean;
  readonly isLabBuild: boolean;
  readonly appVersion?: string;
}): void {
  if (input.isAttachProdBox) input.env.SAND_ATTACH_PROD_BOX = "1";
  else if (!input.isPackaged) input.env.SAND_ATTACH_PROD_BOX = "0";
  input.env.SAND_PACKAGED = input.isAttachProdBox || input.isPackaged ? "1" : "0";
  input.env.SAND_LAB = input.isLabBuild ? "1" : "0";
  if (input.appVersion != null) input.env.SAND_CLIENT_APP_VERSION = input.appVersion;
}

export function isSameDocumentNavigation(target: string, current: string): boolean {
  try {
    const next = new URL(target);
    const here = new URL(current);
    return next.origin === here.origin && next.pathname === here.pathname;
  } catch {
    return false;
  }
}

export function startElectronMain(deps: ElectronMainDependencies): ElectronMainRuntime {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  configureDesktopEnvironment({
    env,
    isPackaged: deps.app.isPackaged,
    isAttachProdBox: deps.isAttachProdBox ?? false,
    isLabBuild: deps.isLabBuild ?? false,
    ...(deps.appVersion == null ? {} : { appVersion: deps.appVersion }),
  });
  deps.startup.bootstrapBeforeSingleInstance();

  // 0.18 disabled the GPU unconditionally; official 0.29 enables hardware
  // acceleration by default on macOS (storedPreference ?? platform==="darwin")
  // and the difference is the bulk of its scrolling smoothness. Mirror that
  // policy: keep the GPU on for darwin unless SAND_DISABLE_GPU=1 opts out.
  // storedPreference ?? platform default, like official 0.29. Must resolve
  // before app ready — Chromium's GPU decision is fixed at startup.
  let storedHardwareAcceleration: boolean | undefined;
  try { storedHardwareAcceleration = new SandSettingsStore(join(getSandRootDir(), "settings.json")).getHardwareAccelerationEnabled(); } catch { /* first launch */ }
  const hardwareAccelerationEnabled = process.env.SAND_DISABLE_GPU !== "1" && (storedHardwareAcceleration ?? process.platform === "darwin");
  if (!hardwareAccelerationEnabled) {
    deps.app.disableHardwareAcceleration();
    deps.app.commandLine.appendSwitch("disable-gpu");
  }
  deps.app.commandLine.appendSwitch("no-sandbox");

  const isPrimaryInstance = !deps.app.isPackaged || deps.app.requestSingleInstanceLock();
  if (!isPrimaryInstance) deps.app.quit();
  deps.startup.bootstrapAfterSingleInstance(isPrimaryInstance);

  let mainWindow: MainBrowserWindow | undefined;
  let mainWindowCreation: Promise<void> | undefined;
  let isMainWindowCreationReady = false;
  let appIsQuitting = false;
  let services: ElectronMainServices | undefined;
  let overlaySession: ReturnType<typeof createWindowsTitleBarOverlaySession> | undefined;

  const syncWindowFocused = createWindowFocusSync({
    getMainWindow: () => mainWindow,
    setWindowFocused: deps.syncWindowFocused,
    reportFailure: (error) => reportDesktopEdgeFailure("window-focus", "push", error),
  });

  const devToolsGate = createDevToolsGate({ isDevBuild: !deps.app.isPackaged });
  const hostChords = createHostWindowChords({
    getMainWindow: () => mainWindow,
    emitZoomFactorChanged: (factor) => services?.mainEdge.emit("zoom-factor-changed", { factor }),
    quitApp: () => deps.app.quit(),
    canUseDevTools: () => devToolsGate.isAllowed(),
    shouldCloseOpenDevTools: () => devToolsGate.shouldCloseOpenDevTools(),
    platform,
  });
  devToolsGate.subscribe(() => hostChords.enforceDevToolsGate());

  const focusMainWindow = (): void => {
    const window = mainWindow;
    if (window != null && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return;
    }
    if (deps.app.isReady() && isMainWindowCreationReady) ensureMainWindow();
  };

  const createWindow = async (): Promise<void> => {
    if (services == null) throw new Error("Electron main services were not initialized");
    services.configureVncTrust?.();
    const placement = deps.windowStatePersistence.resolveSandWindowPlacement();
    const backgroundColor = services.getThemeBackgroundColor();
    const chrome = windowChromeOptions({
      isMac: platform === "darwin",
      isWindows: platform === "win32",
      backgroundColor,
    });
    const icon = deps.app.isPackaged ? undefined : deps.devAppIcon;
    const window = deps.createBrowserWindow({
      ...placement.windowOptions,
      title: deps.appName,
      ...(icon == null ? {} : { icon }),
      backgroundColor,
      ...chrome,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: deps.preloadPath,
        sandbox: false,
        webviewTag: true,
      },
    });
    services.hardenVncWebviewAttach?.(window.webContents);
    mainWindow = window;
    overlaySession = createWindowsTitleBarOverlaySession({
      isWindows: platform === "win32",
      getWindow: () => mainWindow,
      getThemeBackgroundColor: services.getThemeBackgroundColor,
    });
    attachWindowStateBroadcast(window, (state: WindowState) => {
      services?.mainEdge.emit("window-state", state);
    });
    deps.windowStatePersistence.applySandWindowPlacement(window, placement);
    attachWindowFocusForwarding(window, syncWindowFocused);
    services.onWindowCreated?.(window);
    hostChords.attachChordForwarding(window.webContents);
    window.webContents.setWindowOpenHandler(({ url }) => {
      void services?.openExternalUrl(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (isSameDocumentNavigation(url, window.webContents.getURL())) return;
      event.preventDefault();
      void services?.openExternalUrl(url);
    });
    window.webContents.on("will-frame-navigate", (details) => {
      if (details.isMainFrame) return;
      if (isSameDocumentNavigation(details.url, window.webContents.getURL())) return;
      details.preventDefault();
    });
    window.webContents.on("did-start-loading", () => deps.deepLinks.markNotReady());
    window.on("closed", () => deps.deepLinks.markNotReady());
    if (env.VITE_DEV_SERVER_URL != null) await window.loadURL(env.VITE_DEV_SERVER_URL);
    else await window.loadFile(deps.rendererHtmlPath);
  };

  const ensureMainWindow = (): void => {
    if (mainWindow != null && !mainWindow.isDestroyed()) return;
    if (mainWindowCreation != null || !isMainWindowCreationReady) return;
    mainWindowCreation = createWindow().finally(() => {
      mainWindowCreation = undefined;
    });
  };

  deps.app.on("second-instance", (_event, argv) => {
    const candidates = deps.deepLinks.extractCandidatesFromArgv(argv);
    if (candidates.length === 0) {
      const window = mainWindow;
      if (window == null || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.focus();
      return;
    }
    for (const candidate of candidates) deps.deepLinks.handleCandidate(candidate, "second-instance");
  });
  deps.app.on("open-url", (event, url) => {
    event.preventDefault();
    if (!isPrimaryInstance) return;
    deps.deepLinks.handleCandidate(url, "open-url");
  });
  if (isPrimaryInstance) deps.deepLinks.handleArgv(process.argv, "initial-argv");
  deps.initializeFoundation();

  void deps.app
    .whenReady()
    .then(async () => {
      if (!isPrimaryInstance) {
        deps.startup.cancel();
        return;
      }
      deps.startup.markPhase("move_check");
      const moveDisposition = await deps.startup.runMoveCheck({
        hasPendingActivation: deps.deepLinks.hasPendingActivation,
      });
      if (moveDisposition === "stop-bootstrap") return;
      deps.startup.armStuckWatchdog();
      deps.startup.markPhase("services");
      services = await deps.initializeServices({ routeHostInput: hostChords.routeHostInput });

      const membership = createDevToolsMembershipResolver({
        getStatus: services.getDevToolsMembershipStatus,
        setMembership: devToolsGate.setMembership,
        onError: (error) => reportDesktopEdgeFailure("cursor-auth", "anysphere-membership", error),
      });
      services.subscribeDevToolsMembership(() => void membership.refresh());
      void membership.refresh();

      const installMenu = (): void =>
        installApplicationMenu(
          {
            applyWindowShortcut: hostChords.applyWindowShortcut,
            canUseDevTools: devToolsGate.isAllowed,
            emitOpenAbout: () => services?.mainEdge.emit("open-about", {}),
            emitOpenFeedback: () => services?.mainEdge.emit("open-feedback", {}),
            platform,
          },
          deps.menu,
        );
      installMenu();
      services.registerImageContextMenu?.();
      devToolsGate.subscribe(installMenu);

      deps.startup.markPhase("window");
      isMainWindowCreationReady = true;
      await createWindow();
      deps.startup.noteReady();
      // Full Disk Access has no system prompt; surface the manual grant once,
      // after the window is up so it never delays or blocks startup.
      void deps.startup.checkFullDiskAccess();
      deps.app.on("activate", () => {
        if (deps.getAllWindows().length === 0) ensureMainWindow();
      });
    })
    .catch((error: unknown) => deps.startup.noteFailed(error));

  deps.app.on("window-all-closed", () => {
    if (platform !== "darwin") deps.app.quit();
  });
  deps.app.on("before-quit", (event) => {
    appIsQuitting = true;
    deps.startup.cancel();
    if (deps.beginBeforeQuit?.() === "prevent") {
      event.preventDefault();
      return;
    }
    void services?.dispose?.();
    mainWindow = undefined;
  });

  return {
    isPrimaryInstance,
    isQuitting: () => appIsQuitting,
    getMainWindow: () => mainWindow,
    ensureMainWindow,
    setTitleBarOverlayTone: (isOverlayTone) => overlaySession?.setOverlayTone(isOverlayTone),
    syncWindowsTitleBarOverlay: () => overlaySession?.syncFromTheme(),
  };
}

export function startElectronMainProduction(bindings: ElectronMainProductionBindings): ElectronMainRuntime {
  // The main process talks to the gateway too (account refresh, box status); trust the OS roots first.
  trustSystemCertificateAuthorities();
  const composition = createElectronMainProductionComposition(bindings);
  const runtime = startElectronMain(composition.dependencies);
  composition.bindRuntime(runtime);
  return runtime;
}
