import { join } from "node:path";
import { createRequire } from "node:module";
import { declareRpcContract, serveEdge } from "../generated/main-rpc.js";
import { BOX_VNC_METHOD_TABLE, BOX_VNC_RPC_CONTRACT_NAME } from "../../shared/rpc/vnc.js";
import { createBoxVncHandlers, createBoxVncTrust } from "./vnc-edge.js";
export const BOX_VNC_PARTITION = "persist:sand-forever-box";
export const isVncEntryPage = (url: URL): boolean => url.pathname.endsWith("/vnc.html");
export function isLoopbackBoxDesktopUrl(rawUrl: string): boolean { const parsed = URL.parse(rawUrl); return parsed != null && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && isVncEntryPage(parsed); }
export interface VncTrustDeps { preloadDistDir: string; onAssetFailure(report: { host: string; statusCode: number; tokenInfo: { seeded: boolean; source: string }; resource: "page" | "asset" }): void; routeHostInput(input: unknown): boolean }
export function createBoxVncTrustRegistry(deps: VncTrustDeps) {
  const previewWebviewPreloadPath = join(deps.preloadDistDir, "preload-webview.cjs"); const previewVncPreloadPath = join(deps.preloadDistDir, "preload-vnc.cjs");
  const trustedOrigins = new Set<string>(); const tokens = new Map<string, string>(); const tokenSources = new Map<string, string>(); const failingHosts = new Set<string>();
  const rememberNetworkToken = (rawUrl: string): void => { const url = URL.parse(rawUrl); const token = url?.searchParams.get("network_token"); if (url != null && token != null && token.length > 0) tokens.set(url.host, token); };
  const recordTokenSource = (rawUrl: string): void => { const url = URL.parse(rawUrl); if (url == null || !isVncEntryPage(url)) return; const token = url.searchParams.get("network_token"); tokenSources.set(url.host, token != null && token.length > 0 ? "url" : tokens.has(url.host) ? "cached" : "none"); };
  const getTokenInfo = (host: string) => ({ seeded: tokens.has(host), source: tokenSources.get(host) ?? (tokens.has(host) ? "cached" : "none") });
  const observeResponse = (rawUrl: string, statusCode: number): void => { const url = URL.parse(rawUrl); if (url == null) return; if (statusCode < 400) { failingHosts.delete(url.host); return; } if (statusCode >= 500 || failingHosts.has(url.host)) return; failingHosts.add(url.host); deps.onAssetFailure({ host: url.host, statusCode, tokenInfo: getTokenInfo(url.host), resource: isVncEntryPage(url) ? "page" : "asset" }); };
  const isTrustedBoxDesktopFrameUrl = (rawUrl: string): boolean => { if (isLoopbackBoxDesktopUrl(rawUrl)) return true; const parsed = URL.parse(rawUrl); return parsed != null && isVncEntryPage(parsed) && trustedOrigins.has(parsed.origin); };
  const hardenAttach = (webPreferences: Record<string, unknown>, params: Record<string, unknown>): void => { webPreferences.nodeIntegration = false; webPreferences.contextIsolation = true; const isBox = params.partition === BOX_VNC_PARTITION; webPreferences.sandbox = !isBox; webPreferences.preload = isBox ? previewVncPreloadPath : previewWebviewPreloadPath; if (isBox && typeof params.src === "string") { const origin = URL.parse(params.src)?.origin; if (origin != null) trustedOrigins.add(origin); rememberNetworkToken(params.src); recordTokenSource(params.src); } if (typeof params.src === "string") { const parsed = URL.parse(params.src); if (parsed == null || !["http:", "https:", "about:"].includes(parsed.protocol)) delete params.src; } };
  const beforeSendHeaders = (details: { url: string; requestHeaders: Record<string, string> }): Record<string, string> => { rememberNetworkToken(details.url); recordTokenSource(details.url); const host = URL.parse(details.url)?.host; const token = host == null ? undefined : tokens.get(host); if (token != null) details.requestHeaders["x-anyrun-network-token"] = token; return details.requestHeaders; };
  return { getTokenInfo, observeResponse, isTrustedBoxDesktopFrameUrl, hardenAttach, beforeSendHeaders, routeHostInput: deps.routeHostInput };
}
export function installGuestInputGuard(contents: { isDestroyed(): boolean; setVisualZoomLevelLimits(min: number, max: number): void; setZoomFactor(factor: number): void; on(event: string, listener: (...args: any[]) => void): void }, routeHostInput: (input: unknown) => boolean): void { const pinZoom = () => { if (!contents.isDestroyed()) { contents.setVisualZoomLevelLimits(1, 1); contents.setZoomFactor(1); } }; pinZoom(); contents.on("did-finish-load", pinZoom); contents.on("before-input-event", (event: { preventDefault(): void }, input: unknown) => { if (routeHostInput(input)) event.preventDefault(); }); }

export function registerBoxVncTrust(deps: VncTrustDeps & {
  app: { on(event: "web-contents-created", listener: (event: unknown, contents: any) => void): void };
  boxSession: { webRequest: { onBeforeSendHeaders(listener: (details: any, callback: (result: { requestHeaders: Record<string, string> }) => void) => void): void; onCompleted(listener: (details: { url: string; statusCode: number }) => void): void } };
  isBoxWebviewSession(contents: unknown): boolean;
  registerEdge?(isTrustedFrame: (url: string) => boolean): void;
}) {
  const registry = createBoxVncTrustRegistry(deps);
  deps.app.on("web-contents-created", (_event, contents) => { if (contents.getType() === "webview" && deps.isBoxWebviewSession(contents)) installGuestInputGuard(contents, deps.routeHostInput); });
  const configureBoxVncSession = (): void => { deps.boxSession.webRequest.onBeforeSendHeaders((details, callback) => callback({ requestHeaders: registry.beforeSendHeaders(details) })); deps.boxSession.webRequest.onCompleted((details) => registry.observeResponse(details.url, details.statusCode)); };
  const hardenWebviewAttach = (contents: { on(event: string, listener: (...args: any[]) => void): void }): void => { contents.on("will-attach-webview", (_event: unknown, webPreferences: Record<string, unknown>, params: Record<string, unknown>) => registry.hardenAttach(webPreferences, params)); };
  deps.registerEdge?.(registry.isTrustedBoxDesktopFrameUrl);
  return { configureBoxVncSession, hardenWebviewAttach, getTokenInfo: registry.getTokenInfo };
}

export interface ElectronProductionVncTrustDeps extends VncTrustDeps {
  readonly onUserPresence: (isPresent: boolean) => void;
}

/**
 * Exact Electron-main carrier for the process-owned box-vnc trust edge. The
 * immutable owner captures Electron's session/ipcMain/clipboard modules and
 * deliberately has no unregister phase.
 */
export function registerElectronProductionVncTrust(
  deps: ElectronProductionVncTrustDeps,
): { readonly configureBoxVncSession: () => void; readonly hardenWebviewAttach: (contents: { on(event: string, listener: (...args: any[]) => void): void }) => void; readonly getTokenInfo: (host: string) => { seeded: boolean; source: string }; } {
  let requireElectron: NodeRequire;
  try {
    requireElectron = eval("require") as NodeRequire;
  } catch {
    const requireFilename = typeof __filename === "string" ? __filename : import.meta.url;
    requireElectron = createRequire(requireFilename);
  }
  const electron = requireElectron("electron") as {
    readonly app: { on(event: "web-contents-created", listener: (event: unknown, contents: any) => void): void };
    readonly clipboard: { readText(): string; writeText(text: string): void };
    readonly ipcMain: { handle(channel: string, listener: (event: any, payload: unknown) => unknown): void; removeHandler(channel: string): void };
    readonly session: { fromPartition(partition: string): { webRequest: { onBeforeSendHeaders(listener: (details: any, callback: (result: { requestHeaders: Record<string, string> }) => void) => void): void; onCompleted(listener: (details: { url: string; statusCode: number }) => void): void } } };
  };
  if (electron?.app == null || typeof electron.app.on !== "function" || electron.clipboard == null || typeof electron.clipboard.readText !== "function" || typeof electron.clipboard.writeText !== "function" || electron.ipcMain == null || typeof electron.ipcMain.handle !== "function" || typeof electron.ipcMain.removeHandler !== "function" || electron.session == null || typeof electron.session.fromPartition !== "function") throw new TypeError("Incomplete Electron box-VNC trust ABI.");
  const registry = createBoxVncTrustRegistry(deps);
  const isBoxWebviewSession = (contentsSession: unknown): boolean => contentsSession === electron.session.fromPartition(BOX_VNC_PARTITION);
  electron.app.on("web-contents-created", (_event, contents) => { if (contents.getType() === "webview" && isBoxWebviewSession(contents.session)) installGuestInputGuard(contents, deps.routeHostInput); });
  const configureBoxVncSession = (): void => {
    const boxSession = electron.session.fromPartition(BOX_VNC_PARTITION);
    boxSession.webRequest.onBeforeSendHeaders((details, callback) => callback({ requestHeaders: registry.beforeSendHeaders(details) }));
    boxSession.webRequest.onCompleted((details) => registry.observeResponse(details.url, details.statusCode));
  };
  const hardenWebviewAttach = (contents: { on(event: string, listener: (...args: any[]) => void): void }): void => {
    contents.on("will-attach-webview", (_event: unknown, webPreferences: Record<string, unknown>, params: Record<string, unknown>) => registry.hardenAttach(webPreferences, params));
  };
  const handlers = createBoxVncHandlers({ readClipboardText: () => electron.clipboard.readText(), writeClipboardText: (text) => electron.clipboard.writeText(text), onUserPresence: deps.onUserPresence });
  const edge = serveEdge(declareRpcContract(BOX_VNC_RPC_CONTRACT_NAME), BOX_VNC_METHOD_TABLE, {
    transport: {
      handle(channel, run) { electron.ipcMain.handle(channel, (event, payload) => run({ isBoxVncPartition: event.sender.session === electron.session.fromPartition(BOX_VNC_PARTITION), frameUrl: event.senderFrame?.url ?? null }, payload)); },
      removeHandler(channel) { electron.ipcMain.removeHandler(channel); },
      broadcast() {},
    },
    trust: createBoxVncTrust(registry.isTrustedBoxDesktopFrameUrl) as unknown as Record<string, { readonly kind: string; readonly test: (sender: unknown) => boolean; readonly denial: string }>,
    handlers: {
      readClipboard: { trust: "boxDesktopWebview", run: () => handlers.boxDesktopWebview.readClipboard() },
      writeClipboard: { trust: "boxDesktopWebview", run: (payload) => handlers.boxDesktopWebview.writeClipboard(payload as { text?: unknown }) },
      reportUserPresence: { trust: "boxDesktopWebview", run: (payload) => handlers.boxDesktopWebview.reportUserPresence(payload as { isPresent?: unknown }) },
    },
  });
  void edge;
  return { configureBoxVncSession, hardenWebviewAttach, getTokenInfo: registry.getTokenInfo };
}
