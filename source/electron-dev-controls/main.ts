import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDevControlsHandlers, createDevControlsTrust } from "../electron-main/dev/dev-controls-edge.js";
import { isDevControlsEnabled } from "../electron-main/dev/dev-controls-gate.js";
import {
  createDevControlsWindowRuntime,
  fetchGatewayOffline,
  fetchTheme,
  getAttachProdBoxStatus,
  openDevControlsWindow,
  postDevControl,
  writeAttachProdBoxPrefs,
  type DevBrowserWindow,
} from "../electron-main/dev/dev-controls-window.js";
import { createOnePasswordCliDevController } from "../electron-main/onepassword/onepassword-cli-dev-controls.js";
import { installProcessCrashGuards } from "../host/process-crash-guard.js";
import { DEV_CONTROLS_METHOD_TABLE } from "../shared/rpc/dev-controls.js";

export interface DevControlsApp {
  readonly isPackaged: boolean;
  quit(): void;
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance" | "window-all-closed", listener: () => void): void;
  whenReady(): Promise<unknown>;
}

export function startElectronDevControls(app: DevControlsApp, deps: {
  readonly openDevControlsWindow: () => void;
  readonly serveDevControlsEdge: () => void;
  readonly installCrashGuards?: typeof installProcessCrashGuards;
}): { readonly started: boolean } {
  (deps.installCrashGuards ?? installProcessCrashGuards)({ scope: "sand-dev-controls" });
  if (!isDevControlsEnabled({ isPackaged: app.isPackaged })) {
    app.quit();
    return { started: false };
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return { started: false };
  }
  app.on("second-instance", deps.openDevControlsWindow);
  void app.whenReady().then(() => {
    deps.serveDevControlsEdge();
    deps.openDevControlsWindow();
  });
  app.on("window-all-closed", () => app.quit());
  return { started: true };
}

interface DevControlsWebContents {}
interface ElectronBrowserWindow extends DevBrowserWindow { readonly webContents: DevControlsWebContents }
interface DevControlsIpcMain {
  handle(channel: string, listener: (event: { readonly sender: DevControlsWebContents }, payload: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}

export interface ElectronDevControlsRuntime {
  readonly app: DevControlsApp;
  readonly screen: { getPrimaryDisplay(): { workArea: { x: number; y: number; width: number; height: number } } };
  readonly ipcMain: DevControlsIpcMain;
  readonly shell: { openExternal(url: string): Promise<unknown> };
  readonly BrowserWindow: new (options: Record<string, unknown>) => ElectronBrowserWindow;
}

type DevControlsHandlerSet = ReturnType<typeof createDevControlsHandlers>;

export function serveDevControlsRpcEdge(options: {
  readonly ipcMain: DevControlsIpcMain;
  readonly handlers: DevControlsHandlerSet;
  readonly isPanelSender: (sender: DevControlsWebContents) => boolean;
}): { dispose(): void } {
  const trust = createDevControlsTrust().devControlsPanel;
  const channels: string[] = [];
  for (const method of Object.keys(DEV_CONTROLS_METHOD_TABLE) as Array<keyof typeof DEV_CONTROLS_METHOD_TABLE>) {
    const handler = options.handlers[method];
    if (handler == null) throw new Error(`serveEdge(dev-controls): missing handler ${method}`);
    const channel = `sand-rpc:dev-controls:m:${method}`;
    channels.push(channel);
    options.ipcMain.handle(channel, async (event, payload) => {
      if (!trust.test({ isDevControlsPanel: options.isPanelSender(event.sender) })) {
        return { ok: false, failure: { code: "edge/untrusted-sender", detail: trust.denial } };
      }
      try {
        return { ok: true, value: await handler.run(payload as never) };
      } catch (error) {
        return { ok: false, failure: { code: "edge/handler-failed", detail: error instanceof Error ? error.message : String(error) } };
      }
    });
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const channel of channels) options.ipcMain.removeHandler(channel);
    },
  };
}

export function resolveElectronDevControlsProjectDir(moduleUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..");
}

export function startElectronDevControlsEntrypoint(
  electron: ElectronDevControlsRuntime,
  options: { readonly moduleUrl?: string; readonly env?: NodeJS.ProcessEnv } = {},
): { readonly started: boolean } {
  const env = options.env ?? process.env;
  const moduleDirectory = path.dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
  const projectDir = resolveElectronDevControlsProjectDir(options.moduleUrl ?? import.meta.url);
  const windowRuntime = createDevControlsWindowRuntime({ projectDir, env });
  const onePasswordCli = createOnePasswordCliDevController();
  let panelWindow: ElectronBrowserWindow | undefined;
  const open = (): void => openDevControlsWindow({
    electron: {
      screen: electron.screen,
      createBrowserWindow(windowOptions) {
        panelWindow = new electron.BrowserWindow(windowOptions);
        return panelWindow;
      },
    },
    ...(env.VITE_DEV_SERVER_URL === undefined ? {} : { devServerUrl: env.VITE_DEV_SERVER_URL }),
    preloadPath: path.join(moduleDirectory, "..", "electron-preload", "preload-dev-controls.cjs"),
  });
  const serve = (): void => {
    const handlers = createDevControlsHandlers({
      postControl: (pathname) => postDevControl(pathname),
      fetchTheme: (search) => fetchTheme(search),
      fetchGatewayOffline: (search) => fetchGatewayOffline(search),
      onePasswordCli,
      getAttachProdBoxStatus: () => getAttachProdBoxStatus(),
      writeAttachProdBoxPrefs: (enabled) => writeAttachProdBoxPrefs(enabled),
      collectBoxStatus: () => windowRuntime.collectBoxStatus(),
      collectBoxHealth: () => windowRuntime.collectBoxHealth(),
      runDevBoxScript: (command) => windowRuntime.runDevBoxScript(command),
      pokeHostUpgrade: () => windowRuntime.pokeHostUpgrade(),
      tailBoxLogs: () => windowRuntime.tailBoxLogs(),
      nukeBox: () => windowRuntime.nukeBox(),
      openBoxDesktop: () => windowRuntime.openBoxDesktop((url) => electron.shell.openExternal(url)),
      collectBoxStoreStatus: () => windowRuntime.collectBoxStoreStatus(),
      snapshotBoxStoreNow: () => windowRuntime.snapshotBoxStoreNow(),
      boxStoreLogs: () => windowRuntime.boxStoreLogs(),
    });
    serveDevControlsRpcEdge({
      ipcMain: electron.ipcMain,
      handlers,
      isPanelSender: (sender) => panelWindow != null && !panelWindow.isDestroyed() && sender === panelWindow.webContents,
    });
  };
  return startElectronDevControls(electron.app, { openDevControlsWindow: open, serveDevControlsEdge: serve });
}

export function loadElectronDevControlsRuntime(
  requireModule: (id: string) => unknown = createRequire(import.meta.url),
): ElectronDevControlsRuntime {
  const runtime = requireModule("electron") as Partial<ElectronDevControlsRuntime>;
  if (runtime.app == null || runtime.screen == null || runtime.ipcMain == null || runtime.shell == null || runtime.BrowserWindow == null) {
    throw new Error("electron dev-controls bindings are unavailable");
  }
  return runtime as ElectronDevControlsRuntime;
}

if ((process as NodeJS.Process & { readonly type?: string }).type === "browser") {
  startElectronDevControlsEntrypoint(loadElectronDevControlsRuntime());
}
