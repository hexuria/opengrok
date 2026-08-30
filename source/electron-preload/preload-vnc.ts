import { createRealPollingPolicy } from "../internal/scheduling.js";
import { BOX_VNC_METHOD_TABLE } from "../shared/rpc/vnc.js";
import { buildHostClipboardPasteScript, resolveHostToBoxSync } from "./box-vnc-clipboard-paste.js";
import {
  buildVncLivenessBeaconReadExpression,
  buildVncLivenessBeaconScript,
  createVncLivenessDetector,
  parseVncLivenessBeaconCounters,
} from "./box-vnc-liveness.js";
import { createViewerVisibilityGate } from "./box-vnc-visibility-gate.js";
import { VNC_LIVENESS_CHANNEL } from "../shared/vnc-liveness.js";
import { VNC_VIEWER_VISIBLE_CHANNEL } from "../shared/vnc-viewer-visibility.js";
import {
  installSandBrowserPreload,
  type BrowserCredentialsPort,
  type BrowserLocation,
  type BrowserPreloadFrame,
  type BrowserPreloadRenderer,
  type BrowserWindowPort,
} from "./preload-browser-base.js";
import { bridgeRpcEdge } from "./rpc-edge-runtime.js";

export const VNC_CLIPBOARD_POLL_MS = 500;
export const VNC_CLIPBOARD_GESTURE_THROTTLE_MS = 200;
export const VNC_LIVENESS_POLL_MS = 1_000;

export const NO_VNC_CHROME_HIDER_CSS = `
    #noVNC_control_bar,
    #noVNC_control_bar_handle,
    #noVNC_control_bar_anchor,
    #noVNC_status,
    .noVNC_logo {
      display: none !important;
      pointer-events: none !important;
      visibility: hidden !important;
    }
  `;

export interface VncLocationPort {
  readonly pathname: string;
  readonly search: string;
}

export interface VncEventTargetPort {
  addEventListener(type: string, listener: (event: any) => void, options?: unknown): void;
}

export interface VncClassListPort {
  contains(name: string): boolean;
  remove(name: string): void;
}

export interface VncElementPort extends VncEventTargetPort {
  readonly classList: VncClassListPort;
}

export interface VncTextareaPort { value: string }

export interface VncDocumentPort extends VncEventTargetPort {
  readonly documentElement: VncElementPort | null;
  readonly visibilityState?: string;
  getElementById(id: string): unknown;
}

export interface VncFramePort {
  insertCSS?(css: string): unknown;
  executeJavaScript(script: string): Promise<unknown>;
}

export interface VncRendererPort {
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  sendToHost(channel: string, payload: unknown): void;
}

export interface BoxVncEdge {
  readClipboard(): Promise<string>;
  writeClipboard(input: { readonly text: string }): Promise<unknown>;
  reportUserPresence(input: { readonly isPresent: boolean }): Promise<unknown>;
}

export interface PollingHandle { dispose(): void }
export type StartPolling = (options: {
  readonly name: string;
  readonly intervalMs: number;
  readonly task: () => void | Promise<void>;
}) => PollingHandle;

export type VncWarn = (...values: unknown[]) => void;

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export function isInteractiveVncPage(location: VncLocationPort | null | undefined): boolean {
  if (location == null || !location.pathname.endsWith("/vnc.html")) return false;
  try {
    return new URLSearchParams(location.search).get("sandInteractive") === "1";
  } catch {
    return false;
  }
}

export function getVncClipboardTextarea(
  document: VncDocumentPort | null,
  isTextarea: (value: unknown) => value is VncTextareaPort,
): VncTextareaPort | null {
  if (document == null) return null;
  const element = document.getElementById("noVNC_clipboard_text");
  return isTextarea(element) ? element : null;
}

export function installNoVncChromeHider(options: {
  readonly location: VncLocationPort | null;
  readonly frame: VncFramePort | null;
  readonly document: VncDocumentPort | null;
  readonly window: VncEventTargetPort | null;
  readonly warn?: VncWarn;
}): void {
  if (options.location == null || !options.location.pathname.endsWith("/vnc.html")) return;
  try {
    options.frame?.insertCSS?.(NO_VNC_CHROME_HIDER_CSS);
  } catch (error) {
    options.warn?.("noVNC CSS injection failed", errorMessage(error));
  }
  const apply = (): void => {
    const controlBar = options.document?.getElementById("noVNC_control_bar") as { classList?: VncClassListPort } | null;
    controlBar?.classList?.remove("noVNC_open");
  };
  if (options.document == null) return;
  apply();
  options.document.addEventListener("DOMContentLoaded", apply, { once: true });
  options.window?.addEventListener("load", apply, { once: true });
}

export function installVncClipboardBridge(options: {
  readonly renderer: VncRendererPort | null;
  readonly edge: BoxVncEdge | null;
  readonly frame: VncFramePort | null;
  readonly window: VncEventTargetPort | null;
  readonly document: VncDocumentPort | null;
  readonly location: VncLocationPort | null;
  readonly startPolling: StartPolling;
  readonly isTextarea: (value: unknown) => value is VncTextareaPort;
  readonly now?: () => number;
  readonly warn?: VncWarn;
}): void {
  if (options.renderer == null || options.edge == null || options.window == null || options.document == null) return;
  if (!isInteractiveVncPage(options.location)) return;
  const renderer = options.renderer;
  const edge = options.edge;
  const document = options.document;
  let lastBoxTextSentToHost = "";
  let lastHostTextSentToBox = "";
  let lastGestureAt = 0;
  const visibility = createViewerVisibilityGate();
  const textarea = (): VncTextareaPort | null => getVncClipboardTextarea(document, options.isTextarea);
  function mirrorBoxClipboardToHost(): void {
    if (!visibility.isVisible()) return;
    const element = textarea();
    if (element == null) return;
    const text = element.value;
    if (text.length === 0 || text === lastHostTextSentToBox || text === lastBoxTextSentToHost) return;
    lastBoxTextSentToHost = text;
    void edge.writeClipboard({ text }).catch((error: unknown) => {
      options.warn?.("vnc clipboard write failed", errorMessage(error));
    });
  }
  function mirrorHostClipboardToBox(): void {
    if (!visibility.isVisible()) return;
    const now = (options.now ?? Date.now)();
    if (now - lastGestureAt < VNC_CLIPBOARD_GESTURE_THROTTLE_MS) return;
    lastGestureAt = now;
    edge.readClipboard().then((text) => {
      if (text.length === 0 || options.frame == null) return;
      options.frame.executeJavaScript(buildHostClipboardPasteScript(text)).then((didPaste) => {
        const synced = resolveHostToBoxSync(text, didPaste === true);
        if (synced == null) return;
        lastHostTextSentToBox = synced;
        const element = textarea();
        if (element != null) element.value = synced;
      }).catch((error: unknown) => {
        options.warn?.("vnc clipboard paste failed", errorMessage(error));
      });
    }).catch((error: unknown) => {
      options.warn?.("vnc clipboard read failed", errorMessage(error));
    });
  }
  options.renderer.on(VNC_VIEWER_VISIBLE_CHANNEL, (_event, value) => {
    if (visibility.update(value)) mirrorHostClipboardToBox();
  });
  const polling = options.startPolling({
    name: "vnc-clipboard-mirror",
    intervalMs: VNC_CLIPBOARD_POLL_MS,
    task: mirrorBoxClipboardToHost,
  });
  options.window.addEventListener("focus", mirrorHostClipboardToBox);
  document.addEventListener("mousedown", mirrorHostClipboardToBox, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") mirrorHostClipboardToBox();
  });
  options.window.addEventListener("pagehide", () => polling.dispose(), { once: true });
}

export function installVncUserPresenceReporter(options: {
  readonly edge: BoxVncEdge | null;
  readonly window: VncEventTargetPort | null;
  readonly document: VncDocumentPort | null;
  readonly location: VncLocationPort | null;
  readonly warn?: VncWarn;
}): void {
  if (options.edge == null || options.window == null || options.document == null) return;
  if (!isInteractiveVncPage(options.location)) return;
  if (options.document.documentElement == null) {
    options.document.addEventListener("DOMContentLoaded", () => installVncUserPresenceReporter(options), { once: true });
    return;
  }
  const edge = options.edge;
  let lastSent: boolean | null = null;
  function report(isPresent: boolean): void {
    if (isPresent === lastSent) return;
    lastSent = isPresent;
    void edge.reportUserPresence({ isPresent }).catch((error: unknown) => {
      options.warn?.("vnc user presence report failed", errorMessage(error));
    });
  }
  options.document.documentElement.addEventListener("mouseenter", () => report(true));
  options.document.documentElement.addEventListener("mouseleave", () => report(false));
  options.document.addEventListener("mousemove", () => report(true), { passive: true });
  options.window.addEventListener("blur", () => report(false));
  options.window.addEventListener("pagehide", () => report(false), { once: true });
}

export function installVncHostKeyForwarder(options: {
  readonly renderer: VncRendererPort | null;
  readonly document: VncDocumentPort | null;
  readonly location: VncLocationPort | null;
  readonly warn?: VncWarn;
}): void {
  if (options.renderer == null || options.document == null || !isInteractiveVncPage(options.location)) return;
  const forwardedArrows = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
  options.document.addEventListener("keydown", (event: { readonly key?: string }) => {
    if (event.key == null || !forwardedArrows.has(event.key)) return;
    try {
      options.renderer?.sendToHost("sand:vnc-host-key", event.key);
    } catch (error) {
      options.warn?.("vnc host key forward failed", errorMessage(error));
    }
  }, true);
}

export type VncRfbState = "connected" | "reconnecting" | "connecting" | "disconnecting" | "disconnected";

export function currentVncRfbState(classList: Pick<VncClassListPort, "contains">): VncRfbState {
  if (classList.contains("noVNC_connected")) return "connected";
  if (classList.contains("noVNC_reconnecting")) return "reconnecting";
  if (classList.contains("noVNC_connecting")) return "connecting";
  if (classList.contains("noVNC_disconnecting")) return "disconnecting";
  return "disconnected";
}

export function createVncRfbSessionTracker(report: (phase: "rfb_connect" | "reconnect" | "rfb_disconnect", clean: boolean) => void): {
  evaluate(state: VncRfbState): void;
} {
  let connectCount = 0;
  let reportedConnected = false;
  let last: VncRfbState | null = null;
  return {
    evaluate(state) {
      if (state === last) return;
      last = state;
      if (state === "connected") {
        connectCount += 1;
        report(connectCount > 1 ? "reconnect" : "rfb_connect", true);
        reportedConnected = true;
      } else if (reportedConnected && state !== "connecting") {
        report("rfb_disconnect", state === "disconnecting");
        reportedConnected = false;
      }
    },
  };
}

export function installVncRfbSessionReporter(options: {
  readonly renderer: VncRendererPort | null;
  readonly window: VncEventTargetPort | null;
  readonly document: VncDocumentPort | null;
  readonly location: VncLocationPort | null;
  readonly createMutationObserver: (listener: () => void) => { observe(target: unknown, options: unknown): void; disconnect(): void };
  readonly warn?: VncWarn;
}): void {
  if (options.renderer == null || options.window == null || options.document == null) return;
  if (options.location == null || !options.location.pathname.endsWith("/vnc.html")) return;
  const tracker = createVncRfbSessionTracker((phase, clean) => {
    try {
      options.renderer?.sendToHost("sand:vnc-session", JSON.stringify({ phase, clean }));
    } catch (error) {
      options.warn?.("vnc session report failed", errorMessage(error));
    }
  });
  const start = (): void => {
    const root = options.document?.documentElement;
    if (root == null) return;
    const evaluate = (): void => tracker.evaluate(currentVncRfbState(root.classList));
    const observer = options.createMutationObserver(evaluate);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    evaluate();
    options.window?.addEventListener("pagehide", () => observer.disconnect(), { once: true });
  };
  if (options.document.documentElement == null) options.document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

export function installVncLivenessTripwire(options: {
  readonly renderer: VncRendererPort | null;
  readonly frame: VncFramePort | null;
  readonly window: VncEventTargetPort | null;
  readonly document: VncDocumentPort | null;
  readonly location: VncLocationPort | null;
  readonly startPolling: StartPolling;
  readonly performanceNow?: () => number;
  readonly warn?: VncWarn;
}): void {
  if (options.renderer == null || options.frame == null || options.window == null || options.document == null) return;
  if (!isInteractiveVncPage(options.location)) return;
  const frame = options.frame;
  const renderer = options.renderer;
  const document = options.document;
  frame.executeJavaScript(buildVncLivenessBeaconScript()).catch((error: unknown) => {
    options.warn?.("vnc liveness beacon install failed", errorMessage(error));
  });
  const detector = createVncLivenessDetector();
  const readExpression = buildVncLivenessBeaconReadExpression();
  const polling = options.startPolling({
    name: "vnc-liveness-sampler",
    intervalMs: VNC_LIVENESS_POLL_MS,
    task: async () => {
      if (document.documentElement?.classList.contains("noVNC_connected") !== true) {
        detector.reset();
        return;
      }
      try {
        const raw = await frame.executeJavaScript(readExpression);
        const counters = parseVncLivenessBeaconCounters(raw);
        if (counters == null) return;
        const report = detector.sample((options.performanceNow ?? (() => performance.now()))(), counters);
        if (report != null) renderer.sendToHost(VNC_LIVENESS_CHANNEL, report);
      } catch (error) {
        options.warn?.("vnc liveness sample failed", errorMessage(error));
      }
    },
  });
  options.window.addEventListener("pagehide", () => polling.dispose(), { once: true });
}

export function buildVncMacKeyMappingScript(): string {
  return `
    (function () {
      if (window.__sandVncMacKeysInstalled) return;
      if (!/Mac/i.test((navigator && navigator.platform) || "")) return;
      window.__sandVncMacKeysInstalled = true;

      var SHORTCUTS = { KeyA: 0x61, KeyC: 0x63, KeyV: 0x76, KeyX: 0x78, KeyZ: 0x7a };
      var CONTROL_L = 0xffe3;
      var SHIFT_L = 0xffe1;
      var HELD_MODIFIERS = [
        [0xffe7, "MetaLeft"], [0xffe8, "MetaRight"],
        [0xffe9, "AltLeft"], [0xffea, "AltRight"],
        [0xffeb, "SuperLeft"], [0xffec, "SuperRight"]
      ];

      var ui = null;
      import("./app/ui.js")
        .then(function (m) { ui = m && m.default; })
        .catch(function () {});

      document.addEventListener("keydown", function (e) {
        if (!e.metaKey) return;
        var keysym = SHORTCUTS[e.code];
        if (keysym === undefined) return;
        var rfb = ui && ui.rfb;
        if (!rfb || typeof rfb.sendKey !== "function") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        for (var i = 0; i < HELD_MODIFIERS.length; i++) {
          try { rfb.sendKey(HELD_MODIFIERS[i][0], HELD_MODIFIERS[i][1], false); } catch (_e) {}
        }
        rfb.sendKey(CONTROL_L, "ControlLeft", true);
        if (e.shiftKey) rfb.sendKey(SHIFT_L, "ShiftLeft", true);
        rfb.sendKey(keysym, e.code, true);
        rfb.sendKey(keysym, e.code, false);
        if (e.shiftKey) rfb.sendKey(SHIFT_L, "ShiftLeft", false);
        rfb.sendKey(CONTROL_L, "ControlLeft", false);
      }, true);
    })();
  `;
}

export function installVncMacKeyMapping(options: {
  readonly frame: VncFramePort | null;
  readonly location: VncLocationPort | null;
  readonly warn?: VncWarn;
}): void {
  if (options.frame == null || !isInteractiveVncPage(options.location)) return;
  options.frame.executeJavaScript(buildVncMacKeyMappingScript()).catch((error: unknown) => {
    options.warn?.("vnc mac key mapping injection failed", errorMessage(error));
  });
}

export function installVncPreload(options: {
  readonly installBrowserPreload: () => void;
  readonly chromeHider: Parameters<typeof installNoVncChromeHider>[0];
  readonly clipboard: Parameters<typeof installVncClipboardBridge>[0];
  readonly presence: Parameters<typeof installVncUserPresenceReporter>[0];
  readonly hostKeys: Parameters<typeof installVncHostKeyForwarder>[0];
  readonly session: Parameters<typeof installVncRfbSessionReporter>[0];
  readonly macKeys: Parameters<typeof installVncMacKeyMapping>[0];
  readonly liveness: Parameters<typeof installVncLivenessTripwire>[0];
  readonly warn?: VncWarn;
}): void {
  options.installBrowserPreload();
  const warn = options.warn ?? (() => undefined);
  const install = (name: string, operation: () => void): void => {
    try { operation(); } catch (error) { warn(`${name} install failed`, errorMessage(error)); }
  };
  install("noVNC chrome hider", () => installNoVncChromeHider(options.chromeHider));
  install("vnc clipboard bridge", () => installVncClipboardBridge(options.clipboard));
  install("vnc user presence reporter", () => installVncUserPresenceReporter(options.presence));
  install("vnc host key forwarder", () => installVncHostKeyForwarder(options.hostKeys));
  install("vnc rfb session reporter", () => installVncRfbSessionReporter(options.session));
  install("vnc mac key mapping", () => installVncMacKeyMapping(options.macKeys));
  install("vnc liveness tripwire", () => installVncLivenessTripwire(options.liveness));
}

export interface VncPreloadElectronRuntime extends BrowserPreloadRenderer, VncRendererPort {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  off(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

export interface VncPreloadElectronBindings {
  readonly ipcRenderer: VncPreloadElectronRuntime;
  readonly webFrame: BrowserPreloadFrame & VncFramePort;
}

export function installVncPreloadEntrypoint(electron: VncPreloadElectronBindings): void {
  const windowPort = typeof window === "undefined" ? null : window as unknown as BrowserWindowPort & VncEventTargetPort;
  const documentPort = typeof document === "undefined" ? null : document as unknown as VncDocumentPort;
  const locationPort = typeof location === "undefined" ? null : location as unknown as BrowserLocation & VncLocationPort;
  const credentials = typeof navigator === "undefined" ? null : navigator.credentials as unknown as BrowserCredentialsPort;
  const warn: VncWarn = (...values) => console.warn("[sand-webview-preload]", ...values);
  const edge = bridgeRpcEdge("box-vnc", BOX_VNC_METHOD_TABLE, {
    invoke: (channel, payload) => electron.ipcRenderer.invoke(channel, payload),
    on: (channel, listener) => {
      const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
      electron.ipcRenderer.on(channel, wrapped);
      return () => electron.ipcRenderer.off(channel, wrapped);
    },
  }) as BoxVncEdge;
  const startPolling: StartPolling = ({ name, intervalMs, task }) => createRealPollingPolicy({ name, intervalMs }).start(async () => { await task(); });
  installVncPreload({
    installBrowserPreload: () => installSandBrowserPreload({
      renderer: electron.ipcRenderer,
      frame: electron.webFrame,
      window: windowPort,
      location: locationPort,
      credentials,
      warn,
    }),
    chromeHider: { location: locationPort, frame: electron.webFrame, document: documentPort, window: windowPort, warn },
    clipboard: {
      renderer: electron.ipcRenderer,
      edge,
      frame: electron.webFrame,
      window: windowPort,
      document: documentPort,
      location: locationPort,
      startPolling,
      isTextarea: (value): value is VncTextareaPort => typeof HTMLTextAreaElement !== "undefined" && value instanceof HTMLTextAreaElement,
      warn,
    },
    presence: { edge, window: windowPort, document: documentPort, location: locationPort, warn },
    hostKeys: { renderer: electron.ipcRenderer, document: documentPort, location: locationPort, warn },
    session: {
      renderer: electron.ipcRenderer,
      window: windowPort,
      document: documentPort,
      location: locationPort,
      createMutationObserver: (listener) => new MutationObserver(listener),
      warn,
    },
    macKeys: { frame: electron.webFrame, location: locationPort, warn },
    liveness: { renderer: electron.ipcRenderer, frame: electron.webFrame, window: windowPort, document: documentPort, location: locationPort, startPolling, warn },
    warn,
  });
}

export function loadVncPreloadElectron(
  electronModule: unknown,
): VncPreloadElectronBindings {
  const runtime = electronModule as Partial<VncPreloadElectronBindings> | null;
  if (runtime == null || typeof runtime !== "object") throw new Error("electron VNC preload bindings are unavailable");
  const renderer = runtime.ipcRenderer as Partial<VncPreloadElectronRuntime> | null | undefined;
  const frame = runtime.webFrame as Partial<BrowserPreloadFrame & VncFramePort> | null | undefined;
  if (renderer == null || typeof renderer.invoke !== "function" || typeof renderer.on !== "function" || typeof renderer.off !== "function"
    || typeof renderer.sendToHost !== "function" || frame == null || typeof frame.executeJavaScript !== "function") {
    throw new Error("electron VNC preload bindings are unavailable");
  }
  return runtime as VncPreloadElectronBindings;
}
