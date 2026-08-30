import {
  installSandBrowserPreload,
  type BrowserCredentialsPort,
  type BrowserLocation,
  type BrowserPreloadFrame,
  type BrowserPreloadRenderer,
  type BrowserWindowPort,
} from "./preload-browser-base.js";

export function runWebviewPreload(install: typeof installSandBrowserPreload, options: Parameters<typeof install>[0]): void {
  install(options);
}

export interface BrowserPreloadElectronRuntime {
  readonly ipcRenderer: BrowserPreloadRenderer;
  readonly webFrame: BrowserPreloadFrame;
}

function browserGlobal<T>(value: T | undefined): T | null {
  return value ?? null;
}

export function installWebviewPreloadEntrypoint(electron: BrowserPreloadElectronRuntime): void {
  runWebviewPreload(installSandBrowserPreload, {
    renderer: electron.ipcRenderer,
    frame: electron.webFrame,
    window: browserGlobal(typeof window === "undefined" ? undefined : window as unknown as BrowserWindowPort),
    location: browserGlobal(typeof location === "undefined" ? undefined : location as unknown as BrowserLocation),
    credentials: browserGlobal(typeof navigator === "undefined" ? undefined : navigator.credentials as unknown as BrowserCredentialsPort),
  });
}

export function loadBrowserPreloadElectron(
  electronModule: unknown,
): BrowserPreloadElectronRuntime {
  const runtime = electronModule as Partial<BrowserPreloadElectronRuntime> | null;
  if (runtime == null || typeof runtime !== "object") throw new Error("electron browser preload bindings are unavailable");
  const renderer = runtime.ipcRenderer as Partial<BrowserPreloadRenderer> | null | undefined;
  const frame = runtime.webFrame as Partial<BrowserPreloadFrame> | null | undefined;
  if (renderer == null || typeof renderer.sendToHost !== "function" || frame == null || typeof frame.executeJavaScript !== "function") {
    throw new Error("electron browser preload bindings are unavailable");
  }
  return runtime as BrowserPreloadElectronRuntime;
}
