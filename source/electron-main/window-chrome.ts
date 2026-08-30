export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowsTitleBarOverlay {
  readonly height: number;
  readonly color: string;
  readonly symbolColor: string;
}

export const MAC_TRAFFIC_LIGHT_POSITION = { x: 16, y: 15 } as const;
export const WINDOWS_TITLE_BAR_OVERLAY_HEIGHT_PX = 51;
export const WINDOWS_COMPUTER_TITLE_BAR_OVERLAY_HEIGHT_PX = 43;
export const SAND_MIN_WINDOW_SIZE = { width: 512, height: 520 } as const;

function parseHexRgb(backgroundHex: string): readonly [number, number, number] | undefined {
  if (!/^#[0-9A-Fa-f]{6}$/.test(backgroundHex)) return undefined;
  const hex = backgroundHex.slice(1);
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

function blendRgbaOverHex(
  rgb: readonly [number, number, number],
  alpha: number,
  backgroundHex: string,
): string {
  const background = parseHexRgb(backgroundHex) ?? [24, 24, 24];
  return `#${toHexByte(Math.round(rgb[0] * alpha + background[0] * (1 - alpha)))}${toHexByte(
    Math.round(rgb[1] * alpha + background[1] * (1 - alpha)),
  )}${toHexByte(Math.round(rgb[2] * alpha + background[2] * (1 - alpha)))}`;
}

function windowsTitleBarOverlayHeight(isOverlayTone: boolean): number {
  return isOverlayTone
    ? WINDOWS_COMPUTER_TITLE_BAR_OVERLAY_HEIGHT_PX
    : WINDOWS_TITLE_BAR_OVERLAY_HEIGHT_PX;
}

function windowsTitleBarOverlayBackground(themeBackground: string, isOverlayTone: boolean): string {
  if (!isOverlayTone) return themeBackground;
  const cover = blendRgbaOverHex([20, 20, 20], 0.95, themeBackground);
  return blendRgbaOverHex([0, 0, 0], 0.55, cover);
}

function titleBarOverlaySymbolColor(backgroundHex: string): string {
  const [r, g, b] = parseHexRgb(backgroundHex) ?? [24, 24, 24];
  return (r * 299 + g * 587 + b * 114) / 1_000 < 128 ? "#FFFFFF" : "#000000";
}

export function resolveWindowsTitleBarOverlay(
  backgroundColor: string,
  height = WINDOWS_TITLE_BAR_OVERLAY_HEIGHT_PX,
): WindowsTitleBarOverlay {
  return { height, color: backgroundColor, symbolColor: titleBarOverlaySymbolColor(backgroundColor) };
}

export function windowsTitleBarOverlayFor(
  themeBackground: string,
  isOverlayTone: boolean,
): WindowsTitleBarOverlay {
  return resolveWindowsTitleBarOverlay(
    windowsTitleBarOverlayBackground(themeBackground, isOverlayTone),
    windowsTitleBarOverlayHeight(isOverlayTone),
  );
}

export type WindowChromeOptions =
  | {
      readonly frame: true;
      readonly titleBarStyle: "hiddenInset";
      readonly trafficLightPosition: typeof MAC_TRAFFIC_LIGHT_POSITION;
    }
  | {
      readonly frame: false;
      readonly titleBarStyle: "hidden";
      readonly titleBarOverlay: WindowsTitleBarOverlay;
    }
  | { readonly frame: false; readonly titleBarStyle: "default" };

export function windowChromeOptions(input: {
  readonly isMac: boolean;
  readonly isWindows: boolean;
  readonly backgroundColor: string;
}): WindowChromeOptions {
  if (input.isMac) {
    return { frame: true, titleBarStyle: "hiddenInset", trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION };
  }
  if (input.isWindows) {
    return {
      frame: false,
      titleBarStyle: "hidden",
      titleBarOverlay: resolveWindowsTitleBarOverlay(input.backgroundColor),
    };
  }
  return { frame: false, titleBarStyle: "default" };
}

export interface TitleBarOverlayWindow {
  isDestroyed(): boolean;
  setTitleBarOverlay?(overlay: WindowsTitleBarOverlay): void;
}

export function syncWindowsTitleBarOverlay(
  window: TitleBarOverlayWindow | null | undefined,
  overlay: WindowsTitleBarOverlay,
  isWindows: boolean,
): void {
  if (!isWindows) return;
  if (window == null || window.isDestroyed()) return;
  if (typeof window.setTitleBarOverlay !== "function") return;
  window.setTitleBarOverlay(overlay);
}

export function createWindowsTitleBarOverlaySession(deps: {
  readonly isWindows: boolean;
  readonly getWindow: () => TitleBarOverlayWindow | null | undefined;
  readonly getThemeBackgroundColor: () => string;
}): { readonly setOverlayTone: (next: boolean) => void; readonly syncFromTheme: () => void } {
  let isOverlayTone = false;
  const apply = (): void => {
    syncWindowsTitleBarOverlay(
      deps.getWindow(),
      windowsTitleBarOverlayFor(deps.getThemeBackgroundColor(), isOverlayTone),
      deps.isWindows,
    );
  };
  return {
    setOverlayTone(next: boolean): void {
      isOverlayTone = next;
      apply();
    },
    syncFromTheme: apply,
  };
}

export interface WindowChromeWebContents {
  isDestroyed(): boolean;
  toggleDevTools(): void;
  isDevToolsOpened(): boolean;
  closeDevTools(): void;
  openDevTools(options: { readonly mode: "detach" }): void;
}

export function toggleHostDevTools(
  contents: WindowChromeWebContents,
  options: { readonly useWindowControlsOverlay: boolean },
): void {
  if (contents.isDestroyed()) return;
  if (!options.useWindowControlsOverlay) {
    contents.toggleDevTools();
    return;
  }
  if (contents.isDevToolsOpened()) {
    contents.closeDevTools();
    return;
  }
  contents.openDevTools({ mode: "detach" });
}

export interface WindowState {
  readonly isFullscreen: boolean;
  readonly isMaximized: boolean;
}

export interface WindowStateEventSource {
  isFullScreen(): boolean;
  isMaximized(): boolean;
  on(event: "enter-full-screen" | "leave-full-screen" | "maximize" | "unmaximize", listener: () => void): void;
}

export function readWindowState(window: Pick<WindowStateEventSource, "isFullScreen" | "isMaximized">): WindowState {
  return { isFullscreen: window.isFullScreen(), isMaximized: window.isMaximized() };
}

export function attachWindowStateBroadcast(
  window: WindowStateEventSource,
  emitWindowState: (state: WindowState) => void,
): void {
  const send = (): void => emitWindowState(readWindowState(window));
  window.on("enter-full-screen", send);
  window.on("leave-full-screen", send);
  window.on("maximize", send);
  window.on("unmaximize", send);
}

export interface WindowFocusEventSource {
  on(event: "focus" | "blur" | "closed", listener: () => void): void;
}

export function attachWindowFocusForwarding(
  window: WindowFocusEventSource,
  syncWindowFocused: () => Promise<unknown> | unknown,
): void {
  const forward = (): void => {
    void syncWindowFocused();
  };
  window.on("focus", forward);
  window.on("blur", forward);
  window.on("closed", forward);
  forward();
}

export function resolveWindowWidthResize(input: {
  readonly contentBounds: Rectangle;
  readonly workArea: Rectangle;
  readonly deltaWidthDip: number;
  readonly minWidth: number;
}): { readonly contentBounds: Rectangle; readonly appliedDeltaDip: number } {
  const width = Math.min(
    Math.max(input.contentBounds.width + input.deltaWidthDip, input.minWidth),
    input.workArea.width,
  );
  const x = Math.min(
    Math.max(input.contentBounds.x, input.workArea.x),
    input.workArea.x + input.workArea.width - width,
  );
  return {
    contentBounds: { ...input.contentBounds, x, width },
    appliedDeltaDip: width - input.contentBounds.width,
  };
}

export interface WindowChromeBrowserWindow extends TitleBarOverlayWindow {
  readonly webContents: Pick<WindowChromeWebContents, "isDestroyed"> & {
    getZoomFactor(): number;
  };
  getBounds(): Rectangle;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  close(): void;
  getContentBounds(): Rectangle;
  setContentBounds(bounds: Rectangle): void;
}

export function createWindowChromeEdgePort(deps: {
  readonly getMainWindow: () => WindowChromeBrowserWindow | null | undefined;
  readonly workAreaFor: (window: WindowChromeBrowserWindow) => Rectangle;
  readonly setTitleBarOverlayTone: (isOverlayTone: boolean) => void;
}): {
  readonly getWindowState: () => WindowState;
  readonly minimize: () => void;
  readonly toggleMaximize: () => void;
  readonly close: () => void;
  readonly setTitleBarOverlayTone: (isOverlayTone: boolean) => void;
  readonly resizeWidth: (deltaWidth: number) => number;
} {
  return {
    getWindowState: () => {
      const window = deps.getMainWindow();
      if (window == null) return { isFullscreen: false, isMaximized: false };
      return readWindowState(window);
    },
    minimize: () => deps.getMainWindow()?.minimize(),
    toggleMaximize: () => {
      const window = deps.getMainWindow();
      if (window == null) return;
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    },
    close: () => deps.getMainWindow()?.close(),
    setTitleBarOverlayTone: (isOverlayTone) => {
      if (deps.getMainWindow() == null) return;
      deps.setTitleBarOverlayTone(isOverlayTone);
    },
    resizeWidth: (deltaWidth) => {
      const window = deps.getMainWindow();
      if (window == null) return 0;
      if (window.isMaximized() || window.isFullScreen()) return 0;
      const zoomFactor = window.webContents.getZoomFactor();
      const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
      const resolved = resolveWindowWidthResize({
        contentBounds: window.getContentBounds(),
        workArea: deps.workAreaFor(window),
        deltaWidthDip: Math.round(deltaWidth * scale),
        minWidth: Math.round(SAND_MIN_WINDOW_SIZE.width * scale),
      });
      if (resolved.appliedDeltaDip !== 0) window.setContentBounds(resolved.contentBounds);
      return resolved.appliedDeltaDip / scale;
    },
  };
}

export function createWindowFocusSync(deps: {
  readonly getMainWindow: () =>
    | { readonly isDestroyed: () => boolean; readonly isFocused: () => boolean }
    | null
    | undefined;
  readonly setWindowFocused: (state: { readonly isFocused: boolean }) => Promise<unknown>;
  readonly reportFailure: (error: unknown) => void;
}): () => Promise<void> {
  let windowFocusPushChain: Promise<void> = Promise.resolve();
  return () => {
    const push = windowFocusPushChain.then(async () => {
      try {
        const window = deps.getMainWindow();
        await deps.setWindowFocused({
          isFocused: window != null && !window.isDestroyed() && window.isFocused(),
        });
      } catch (error) {
        deps.reportFailure(error);
      }
    });
    windowFocusPushChain = push;
    return push;
  };
}
