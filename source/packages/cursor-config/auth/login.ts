import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createLocalCliModeHeaders } from "../request.js";
import { mdmSignInPolicyHeaders, SignInPolicyViolationError, SIGN_IN_POLICY_VIOLATION_ERROR } from "./mdm-sign-in-policy.js";
import { proxyFetch } from "./proxy-fetch.js";

export interface LoginMetadata { readonly uuid: string; readonly verifier: string }
export interface CursorTokens { readonly accessToken: string; readonly refreshToken: string }
export interface LoginManagerOptions { readonly redirectTarget?: string; readonly apiUrl?: string; readonly websiteUrl?: string }
export interface LoginLinkHandler { openUrl(url: string): Promise<void> }

function stripTrailingSlashes(url: string): string { return url.replace(/\/+$/, ""); }
function resolveWebsiteUrl(url?: string): string { return stripTrailingSlashes(url ?? process.env.CURSOR_WEBSITE_URL ?? "https://cursor.com"); }
function resolveApiBaseUrl(url?: string): string { return stripTrailingSlashes(url ?? process.env.CURSOR_API_BASE_URL ?? "https://api2.cursor.sh"); }
function base64UrlEncode(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64url"); }
function sha256(data: string): Buffer { return createHash("sha256").update(data).digest(); }

export function generateAuthParams(redirectTarget = "cli", websiteUrl = resolveWebsiteUrl()): { uuid: string; challenge: string; verifier: string; loginUrl: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(sha256(verifier));
  const uuid = randomUUID();
  return { uuid, challenge, verifier, loginUrl: `${websiteUrl}/loginDeepControl?challenge=${challenge}&uuid=${uuid}&mode=login&redirectTarget=${redirectTarget}` };
}
function isAborted(signal?: AbortSignal): boolean { return signal?.aborted === true; }
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (isAborted(signal)) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function validTokens(value: unknown): value is CursorTokens {
  return typeof value === "object" && value !== null && "accessToken" in value && typeof value.accessToken === "string" && "refreshToken" in value && typeof value.refreshToken === "string";
}
export async function pollAuthenticationStatus(args: { readonly uuid: string; readonly verifier: string; readonly apiBaseUrl?: string; readonly signal?: AbortSignal }): Promise<CursorTokens | null> {
  const endpoint = `${resolveApiBaseUrl(args.apiBaseUrl)}/auth/poll`;
  const policyHeaders = await mdmSignInPolicyHeaders();
  let consecutiveErrors = 0;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (isAborted(args.signal)) return null;
    try {
      const request: RequestInit = { headers: createLocalCliModeHeaders({ "Content-Type": "application/json", ...policyHeaders }) };
      if (args.signal !== undefined) request.signal = args.signal;
      const response = await proxyFetch(`${endpoint}?uuid=${args.uuid}&verifier=${args.verifier}`, request);
      if (response.status === 403) {
        const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
        if (body?.error === SIGN_IN_POLICY_VIOLATION_ERROR) throw new SignInPolicyViolationError();
      }
      if (response.status === 404) { consecutiveErrors = 0; await sleep(Math.min(1_000 * 1.2 ** attempt, 10_000), args.signal); continue; }
      if (!response.ok) { consecutiveErrors += 1; if (consecutiveErrors >= 3) return null; await sleep(Math.min(1_000 * 1.2 ** attempt, 10_000), args.signal); continue; }
      consecutiveErrors = 0;
      const result: unknown = await response.json();
      return validTokens(result) ? result : null;
    } catch (error) {
      if (error instanceof SignInPolicyViolationError) throw error;
      if (isAborted(args.signal)) return null;
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) return null;
      await sleep(Math.min(1_000 * 1.2 ** attempt, 10_000), args.signal);
    }
  }
  return null;
}

export class AuthNetworkError extends Error {
  constructor(cause: unknown) {
    const rawProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    let safeProxy = "[proxy URL redacted]";
    if (rawProxy) {
      try {
        const proxy = new URL(rawProxy);
        proxy.username = "";
        proxy.password = "";
        safeProxy = proxy.toString();
      } catch { /* keep the redacted fallback */ }
    }
    super(`Failed to reach the Cursor API. ${rawProxy ? `Check that your proxy (${safeProxy}) is reachable.` : "If you are behind a corporate proxy, set the HTTPS_PROXY environment variable."}`);
    this.name = "AuthNetworkError";
    this.cause = cause;
  }
}

export interface ExchangeApiKeyOptions { readonly endpoint?: string }
export async function exchangeApiKeyForTokens(apiKey: string, options?: ExchangeApiKeyOptions): Promise<CursorTokens | null> {
  const baseUrl = resolveApiBaseUrl(options?.endpoint);
  const policyHeaders = await mdmSignInPolicyHeaders();
  try {
    const headers = createLocalCliModeHeaders({ "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...policyHeaders });
    const response = await proxyFetch(`${baseUrl}/auth/exchange_user_api_key`, { method: "POST", headers, body: JSON.stringify({}) });
    if (response.status === 403) {
      const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
      if (body?.error === SIGN_IN_POLICY_VIOLATION_ERROR) throw new SignInPolicyViolationError();
      return null;
    }
    if (response.status >= 500) throw new AuthNetworkError(new Error(`exchange_user_api_key returned HTTP ${response.status}`));
    if (!response.ok) return null;
    const result: unknown = await response.json();
    return validTokens(result) ? result : null;
  } catch (error) {
    if (error instanceof SignInPolicyViolationError || error instanceof AuthNetworkError) throw error;
    throw new AuthNetworkError(error);
  }
}

export class LoginManager {
  readonly redirectTarget: string;
  readonly apiUrl: string;
  readonly websiteUrl: string;
  constructor(options: LoginManagerOptions = {}) {
    this.redirectTarget = options.redirectTarget ?? "cli";
    this.apiUrl = resolveApiBaseUrl(options.apiUrl);
    this.websiteUrl = resolveWebsiteUrl(options.websiteUrl);
  }
  startLogin(): { metadata: LoginMetadata; loginUrl: string } {
    const auth = generateAuthParams(this.redirectTarget, this.websiteUrl);
    return { metadata: { uuid: auth.uuid, verifier: auth.verifier }, loginUrl: auth.loginUrl };
  }
  async waitForResult(metadata: LoginMetadata, signal?: AbortSignal): Promise<CursorTokens | null> {
    return await pollAuthenticationStatus({ uuid: metadata.uuid, verifier: metadata.verifier, apiBaseUrl: this.apiUrl, ...(signal === undefined ? {} : { signal }) });
  }
  async loginWithApiKey(apiKey: string, options?: ExchangeApiKeyOptions): Promise<CursorTokens | null> {
    return await exchangeApiKeyForTokens(apiKey, { endpoint: options?.endpoint ?? this.apiUrl });
  }
  async login(linkHandler: LoginLinkHandler, signal?: AbortSignal): Promise<CursorTokens | null> {
    const { metadata, loginUrl } = this.startLogin();
    await linkHandler.openUrl(loginUrl);
    return await this.waitForResult(metadata, signal);
  }
}
