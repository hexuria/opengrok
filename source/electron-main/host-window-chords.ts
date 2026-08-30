import { toggleHostDevTools, type WindowChromeWebContents } from "./window-chrome.js";
import {
  classifyWindowShortcut,
  type WindowShortcut,
  type WindowShortcutInput,
} from "./window-shortcuts.js";

export const ZOOM_FACTOR_MIN = 0.5;
export const ZOOM_FACTOR_MAX = 3;
export const ZOOM_FACTOR_STEP = 0.1;

export type HostZoomDirection = "in" | "out" | "reset";

export interface HostWindowInput extends WindowShortcutInput {}

export interface HostInputEvent {
  preventDefault(): void;
}

export interface HostWindowWebContents extends WindowChromeWebContents {
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  reload(): void;
  on(
    event: "before-input-event",
    listener: (event: HostInputEvent, input: HostWindowInput) => void,
  ): void;
}

export interface HostBrowserWindow {
  readonly webContents: HostWindowWebContents;
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setFullScreen(fullscreen: boolean): void;
}

export function classifyZoomInput(
  input: HostWindowInput,
  platform: NodeJS.Platform = process.platform,
): HostZoomDirection | null {
  if (input.type !== "keyDown") return null;
  const mod = platform === "darwin" ? input.meta : input.control;
  if (!mod || input.alt) return null;
  switch (input.key) {
    case "=":
    case "+":
      return "in";
    case "-":
      return "out";
    case "0":
      return "reset";
    default:
      return null;
  }
}

export function createHostWindowChords(deps: {
  readonly getMainWindow: () => HostBrowserWindow | null | undefined;
  readonly emitZoomFactorChanged: (factor: number) => void;
  readonly quitApp: () => void;
  readonly canUseDevTools: () => boolean;
  readonly shouldCloseOpenDevTools: () => boolean;
  readonly platform?: NodeJS.Platform;
}): {
  readonly applyHostZoom: (direction: HostZoomDirection) => void;
  readonly applyWindowShortcut: (shortcut: WindowShortcut) => void;
  readonly attachChordForwarding: (contents: HostWindowWebContents) => void;
  readonly enforceDevToolsGate: () => void;
  readonly routeHostInput: (input: HostWindowInput) => boolean;
} {
  const platform = deps.platform ?? process.platform;

  function applyHostZoom(direction: HostZoomDirection): void {
    const contents = deps.getMainWindow()?.webContents;
    if (contents == null || contents.isDestroyed()) return;
    let factor = 1;
    if (direction !== "reset") {
      const delta = direction === "in" ? ZOOM_FACTOR_STEP : -ZOOM_FACTOR_STEP;
      const next = Math.min(
        ZOOM_FACTOR_MAX,
        Math.max(ZOOM_FACTOR_MIN, contents.getZoomFactor() + delta),
      );
      factor = Math.round(next * 100) / 100;
    }
    contents.setZoomFactor(factor);
    deps.emitZoomFactorChanged(contents.getZoomFactor());
  }

  function applyWindowShortcut(shortcut: WindowShortcut): void {
    switch (shortcut) {
      case "reload": {
        const contents = deps.getMainWindow()?.webContents;
        if (contents != null && !contents.isDestroyed()) contents.reload();
        return;
      }
      case "fullscreen": {
        const window = deps.getMainWindow();
        if (window == null || window.isDestroyed()) return;
        window.setFullScreen(!window.isFullScreen());
        return;
      }
      case "toggledevtools": {
        if (!deps.canUseDevTools()) return;
        const contents = deps.getMainWindow()?.webContents;
        if (contents != null) {
          toggleHostDevTools(contents, { useWindowControlsOverlay: platform === "win32" });
        }
        return;
      }
      case "quit":
        deps.quitApp();
        return;
    }
  }

  function enforceDevToolsGate(): void {
    if (!deps.shouldCloseOpenDevTools()) return;
    const contents = deps.getMainWindow()?.webContents;
    if (contents == null || contents.isDestroyed()) return;
    if (contents.isDevToolsOpened()) contents.closeDevTools();
  }

  function attachChordForwarding(contents: HostWindowWebContents): void {
    contents.on("before-input-event", (event, input) => {
      const direction = classifyZoomInput(input, platform);
      if (direction != null) {
        event.preventDefault();
        applyHostZoom(direction);
        return;
      }
      const shortcut = classifyWindowShortcut(input, platform);
      if (shortcut != null) {
        event.preventDefault();
        applyWindowShortcut(shortcut);
      }
    });
  }

  function routeHostInput(input: HostWindowInput): boolean {
    const direction = classifyZoomInput(input, platform);
    if (direction != null) {
      applyHostZoom(direction);
      return true;
    }
    const shortcut = classifyWindowShortcut(input, platform);
    if (shortcut != null) {
      applyWindowShortcut(shortcut);
      return true;
    }
    return false;
  }

  return {
    applyHostZoom,
    applyWindowShortcut,
    attachChordForwarding,
    enforceDevToolsGate,
    routeHostInput,
  };
}
