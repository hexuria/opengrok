/**
 * The Collections window: a second BrowserWindow that loads the shipped
 * `dist/electron-collections/page/collections.html` from disk (so it works in
 * the packaged ASAR) behind its own narrow preload.
 *
 * Hardening mirrors the main window: window.open is denied and forwarded to the
 * OS browser, cross-document navigation is blocked outright, and subframes may
 * not navigate at all. The page is local-only; nothing it renders is allowed to
 * pull the window somewhere else.
 */

export const COLLECTIONS_NAVIGATE_CHANNEL = "sand:collections-navigate";

export interface CollectionsWindowContents {
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  getURL(): string;
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { readonly action: "deny" }): void;
  on(event: "will-navigate", listener: (event: { preventDefault(): void }, url: string) => void): void;
  on(
    event: "will-frame-navigate",
    listener: (details: { preventDefault(): void; readonly isMainFrame: boolean; readonly url: string }) => void,
  ): void;
}

export interface CollectionsBrowserWindow {
  readonly webContents: CollectionsWindowContents;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  setMenuBarVisibility(visible: boolean): void;
  loadFile(file: string): Promise<unknown>;
  on(event: "closed", listener: () => void): void;
}

export interface CollectionsWindowPort {
  createBrowserWindow(options: Record<string, unknown>): CollectionsBrowserWindow;
}

export interface OpenCollectionsWindowOptions {
  readonly port: CollectionsWindowPort;
  readonly htmlPath: string;
  readonly preloadPath: string;
  readonly collectionId?: string | undefined;
  readonly backgroundColor?: string;
  readonly openExternalUrl?: (url: string) => void;
  readonly reportFailure?: (leg: string, error: unknown) => void;
}

let collectionsWindow: CollectionsBrowserWindow | undefined;
let pendingCollectionId: string | null = null;

/**
 * The page reads its initial target here instead of racing a navigate event
 * against its own first paint.
 */
export function takePendingCollectionId(): string | null {
  const pending = pendingCollectionId;
  pendingCollectionId = null;
  return pending;
}

export function getCollectionsWindowContents(): CollectionsWindowContents | null {
  const window = collectionsWindow;
  if (window == null || window.isDestroyed()) return null;
  return window.webContents.isDestroyed() ? null : window.webContents;
}

export function closeCollectionsWindowReference(): void {
  collectionsWindow = undefined;
  pendingCollectionId = null;
}

export function openCollectionsWindow(options: OpenCollectionsWindowOptions): void {
  pendingCollectionId = options.collectionId ?? null;
  const existing = collectionsWindow;
  if (existing != null && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    if (options.collectionId != null && !existing.webContents.isDestroyed()) {
      existing.webContents.send(COLLECTIONS_NAVIGATE_CHANNEL, { collectionId: options.collectionId });
    }
    return;
  }
  const window = options.port.createBrowserWindow({
    width: 900,
    height: 700,
    minWidth: 620,
    minHeight: 420,
    title: "Collections",
    backgroundColor: options.backgroundColor ?? "#161619",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      preload: options.preloadPath,
    },
  });
  collectionsWindow = window;
  window.setMenuBarVisibility(false);
  window.on("closed", () => { if (collectionsWindow === window) collectionsWindow = undefined; });
  window.webContents.setWindowOpenHandler(({ url }) => {
    options.openExternalUrl?.(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    options.openExternalUrl?.(url);
  });
  window.webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return;
    details.preventDefault();
  });
  void window.loadFile(options.htmlPath).catch((error: unknown) => options.reportFailure?.("load", error));
}

/** Process-owned Electron carrier; the window module never imports Electron eagerly. */
export function electronCollectionsWindowPort(): CollectionsWindowPort {
  const electron = require("electron") as { readonly BrowserWindow: new (options: Record<string, unknown>) => CollectionsBrowserWindow };
  return { createBrowserWindow: (windowOptions) => new electron.BrowserWindow(windowOptions) };
}
