import { createDeadlinePolicy, realClock, type DeadlinePolicy } from "../internal/scheduling.js";
import { PASSKEY_STALL_MS, raceWithPasskeyStallDeadline } from "./passkey-stall.js";

export const IDP_HOSTNAME_ALLOWLIST = [
  ".okta.com",
  ".okta-emea.com",
  ".oktapreview.com",
  ".duosecurity.com",
  ".login.microsoftonline.com",
  ".onelogin.com",
  ".auth0.com",
  ".pingidentity.com",
  ".rippling.com",
] as const;

export interface BrowserPreloadRenderer {
  sendToHost(channel: string, payload: unknown): void;
}

export interface BrowserPreloadFrame {
  executeJavaScript(script: string): Promise<unknown>;
}

export interface BrowserLocation {
  readonly hostname: string;
  readonly origin: string;
  readonly href: string;
}

export interface BrowserWindowPort {
  alert(...values: unknown[]): unknown;
  confirm(...values: unknown[]): unknown;
  prompt(...values: unknown[]): unknown;
  __sandDialogOverridesApplied?: boolean;
  addEventListener(type: string, listener: (event?: { readonly persisted?: boolean }) => void): void;
}

export interface BrowserCredentialsPort {
  create?: (...args: unknown[]) => unknown;
  get?: (...args: unknown[]) => unknown;
}

export function getErrorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export function isAllowlistedIdpHost(hostname: unknown): boolean {
  if (typeof hostname !== "string" || hostname.length === 0) return false;
  for (let index = 0; index < IDP_HOSTNAME_ALLOWLIST.length; index += 1) {
    if (hostname.endsWith(IDP_HOSTNAME_ALLOWLIST[index] as string)) return true;
  }
  return false;
}

export function buildLocalNetworkAccessPolyfillScript(): string {
  return `
    (function () {
      var permissions = navigator && navigator.permissions;
      if (!permissions || typeof permissions.query !== "function") return;
      if (permissions.__sandLocalNetworkPolyfill) return;
      permissions.__sandLocalNetworkPolyfill = true;
      var originalQuery = permissions.query.bind(permissions);
      permissions.query = function (descriptor) {
        var name = descriptor && descriptor.name;
        if (name === "local-network-access" || name === "local-network") {
          var status = new EventTarget();
          Object.defineProperties(status, {
            name: { value: name },
            state: { value: "granted" },
            onchange: { value: null, writable: true },
          });
          return Promise.resolve(status);
        }
        return originalQuery(descriptor);
      };
    })();
  `;
}

export function injectLocalNetworkAccessPolyfill(options: {
  readonly frame: BrowserPreloadFrame | null;
  readonly location: BrowserLocation | null;
  readonly warn?: (...values: unknown[]) => void;
}): void {
  if (options.frame == null || options.location == null || !isAllowlistedIdpHost(options.location.hostname)) return;
  options.frame.executeJavaScript(buildLocalNetworkAccessPolyfillScript()).catch((error: unknown) => {
    options.warn?.("local network polyfill injection failed", getErrorMessage(error));
  });
}

export function buildPasskeyStallError(): Error {
  try {
    return new DOMException("Passkey request stalled", "NotAllowedError");
  } catch {
    const fallback = new Error("Passkey request stalled");
    fallback.name = "NotAllowedError";
    return fallback;
  }
}

export function wrapCredentialMethod(
  renderer: BrowserPreloadRenderer,
  credentials: BrowserCredentialsPort,
  method: "create" | "get",
  originalFn: (...args: unknown[]) => unknown,
  options: {
    readonly deadline?: DeadlinePolicy;
    readonly now?: () => number;
    readonly warn?: (...values: unknown[]) => void;
  } = {},
): (...args: unknown[]) => Promise<unknown> {
  const deadline = options.deadline ?? createDeadlinePolicy(realClock, {
    name: "sand-webview-passkey-stall",
    timeoutMs: PASSKEY_STALL_MS,
  });
  return function patchedCredentialMethod(...args: unknown[]): Promise<unknown> {
    const since = (options.now ?? Date.now)();
    let callPromise: Promise<unknown>;
    try {
      callPromise = Promise.resolve(originalFn.apply(credentials, args));
    } catch (error) {
      return Promise.reject(error);
    }
    return raceWithPasskeyStallDeadline({
      policy: deadline,
      method,
      since,
      call: callPromise,
      reportStall: (report) => {
        try {
          renderer.sendToHost("sand:browser-passkey-stalled", report);
        } catch (error) {
          options.warn?.("passkey stall send failed", getErrorMessage(error));
        }
      },
      buildStallError: buildPasskeyStallError,
    });
  };
}

export function installWebAuthnPolyfill(options: {
  readonly renderer: BrowserPreloadRenderer | null;
  readonly credentials: BrowserCredentialsPort | null;
  readonly deadline?: DeadlinePolicy;
  readonly now?: () => number;
  readonly warn?: (...values: unknown[]) => void;
}): void {
  if (options.renderer == null || options.credentials == null) return;
  const wrapping = {
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.warn === undefined ? {} : { warn: options.warn }),
  };
  if (typeof options.credentials.create === "function") {
    const originalCreate = options.credentials.create.bind(options.credentials);
    options.credentials.create = wrapCredentialMethod(options.renderer, options.credentials, "create", originalCreate, wrapping);
  }
  if (typeof options.credentials.get === "function") {
    const originalGet = options.credentials.get.bind(options.credentials);
    options.credentials.get = wrapCredentialMethod(options.renderer, options.credentials, "get", originalGet, wrapping);
  }
}

export function installDialogStubs(windowPort: BrowserWindowPort | null): void {
  if (windowPort == null || windowPort.__sandDialogOverridesApplied === true) return;
  windowPort.alert = function sandAlertStub(): void {};
  windowPort.confirm = function sandConfirmStub(): true { return true; };
  windowPort.prompt = function sandPromptStub(): null { return null; };
  windowPort.__sandDialogOverridesApplied = true;
}

export function installIpcWiring(options: {
  readonly renderer: BrowserPreloadRenderer | null;
  readonly window: BrowserWindowPort | null;
  readonly location: BrowserLocation | null;
  readonly warn?: (...values: unknown[]) => void;
}): void {
  if (options.renderer == null || options.window == null || options.location == null) return;
  const { renderer, location } = options;
  const originalOrigin = location.origin;
  function sendPopupClosed(): void {
    try {
      renderer.sendToHost("sand:browser-popup-closed", { url: location.href });
    } catch (error) {
      options.warn?.("popup-closed send failed", getErrorMessage(error));
    }
  }
  options.window.addEventListener("beforeunload", sendPopupClosed);
  options.window.addEventListener("pagehide", sendPopupClosed);
  options.window.addEventListener("pageshow", (event) => {
    if (!event || event.persisted !== true || location.origin !== originalOrigin) return;
    try {
      renderer.sendToHost("sand:browser-origin-return", { origin: originalOrigin, currentUrl: location.href });
    } catch (error) {
      options.warn?.("origin-return send failed", getErrorMessage(error));
    }
  });
}

export function installSandBrowserPreload(options: {
  readonly renderer: BrowserPreloadRenderer | null;
  readonly frame: BrowserPreloadFrame | null;
  readonly window: BrowserWindowPort | null;
  readonly location: BrowserLocation | null;
  readonly credentials: BrowserCredentialsPort | null;
  readonly deadline?: DeadlinePolicy;
  readonly now?: () => number;
  readonly warn?: (...values: unknown[]) => void;
}): void {
  const warn = options.warn ?? ((...values: unknown[]) => console.warn("[sand-webview-preload]", ...values));
  try {
    injectLocalNetworkAccessPolyfill({ frame: options.frame, location: options.location, warn });
  } catch (error) {
    warn("local network polyfill install failed", getErrorMessage(error));
  }
  try {
    installWebAuthnPolyfill({
      renderer: options.renderer,
      credentials: options.credentials,
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
      ...(options.now === undefined ? {} : { now: options.now }),
      warn,
    });
  } catch (error) {
    warn("webauthn polyfill install failed", getErrorMessage(error));
  }
  try {
    installDialogStubs(options.window);
  } catch (error) {
    warn("dialog stubs install failed", getErrorMessage(error));
  }
  try {
    installIpcWiring({ renderer: options.renderer, window: options.window, location: options.location, warn });
  } catch (error) {
    warn("ipc wiring install failed", getErrorMessage(error));
  }
}
