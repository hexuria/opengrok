import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_CURSOR_BACKEND_URL,
  getAuthClientId,
  getConfiguredBackendUrl,
  isDevAuthBackend,
  parseJwtPayload,
  shouldRefreshAccessToken,
} from "../../shared/node/cursor-token.js";
import { findSystemErrno } from "../../shared/system-errno.js";
import { createLocalCliModeHeaders } from "../../packages/cursor-config/request.js";
import { LoginManager } from "../../packages/cursor-config/auth/login.js";
import { mdmSignInPolicyHeaders, SignInPolicyViolationError, SIGN_IN_POLICY_VIOLATION_ERROR, SIGN_IN_POLICY_VIOLATION_MESSAGE } from "../../packages/cursor-config/auth/mdm-sign-in-policy.js";
import { deleteSecret, isEncryptedStorageAvailable, readSecret, shouldPersistSecretsOnDisk, waitForEncryptedStorage, writeSecret } from "../secrets/secret-store.js";
import { reportSessionEvent, type SessionRefreshFailure, type SessionSignoutCause } from "./session-funnel-telemetry.js";
import { reportSigninLogin, reportSigninSignout, signinSignoutCause } from "./signin-funnel-telemetry.js";
import { resolveAuthRedirectTarget } from "../auth/auth-callback-registration.js";

export const ACCESS_TOKEN_SECRET_KEY = "cursor-access-token";
export const REFRESH_TOKEN_SECRET_KEY = "cursor-refresh-token";
export const DEFAULT_CURSOR_WEBSITE_URL = "https://cursor.com";
export const DEFAULT_LOCAL_CURSOR_WEBSITE_URL = "https://localhost:4443";
export const MAX_LOGIN_POLL_ATTEMPTS = 150;
export { SignInPolicyViolationError, SIGN_IN_POLICY_VIOLATION_ERROR, SIGN_IN_POLICY_VIOLATION_MESSAGE } from "../../packages/cursor-config/auth/mdm-sign-in-policy.js";
/**
 * Did the backend reject the credential, or merely fail to answer?
 *
 * A rejection is stated: 400/401/403, or a body carrying shouldLogout. The
 * body is read either way, so the backend's own words ("unknown refresh
 * token") can be reported instead of a bare status code.
 */
async function readRefreshRefusal(response: Response): Promise<{ rejectsCredential: boolean; detail?: string }> {
  let detail: string | undefined;
  let saidLogout = false;
  try {
    const body = (await response.clone().json()) as unknown;
    if (typeof body === "object" && body != null) {
      const record = body as Record<string, unknown>;
      if (typeof record.error === "string" && record.error.length > 0) detail = record.error.slice(0, 200);
      saidLogout = record.shouldLogout === true;
    }
  } catch { /* a body we cannot read tells us nothing either way */ }
  const statusRejects = response.status === 400 || response.status === 401 || response.status === 403;
  return { rejectsCredential: statusRejects || saidLogout, ...(detail == null ? {} : { detail }) };
}

export class SandAuthOperationSupersededError extends Error { constructor() { super("Authentication operation was superseded."); } }
export class SandAuthSignInRequiredError extends Error { constructor() { super("Sign in to Cursor to run Grok Bot."); } }
export class SandAuthSignInExpiredError extends Error { constructor() { super("Cursor sign-in expired. Sign in again to run Grok Bot."); } }
export class SandAuthLoginTimedOutError extends Error { constructor() { super("Cursor sign-in did not finish. Try again."); } }
export class SandDevLoginError extends Error {}
/**
 * The backend could not answer a refresh, but did not reject the credential.
 * Distinct from SandAuthSignInExpiredError because the session is still good:
 * a server restarting, overloaded or rate-limiting is a reason to try again
 * later, never a reason to sign somebody out.
 */
export class SandAuthRefreshUnavailableError extends Error {
  constructor(readonly httpStatus: number, detail?: string) {
    super(detail == null || detail.length === 0
      ? `The account server could not refresh the sign-in (HTTP ${httpStatus}).`
      : `The account server could not refresh the sign-in: ${detail}`);
  }
}

export type SandAuthStatus =
  | { readonly kind: "logging-in" }
  | { readonly kind: "logged-out"; readonly errorMessage?: string }
  | { readonly kind: "logged-in"; readonly authId?: string; readonly email?: string; readonly expiresAt?: number; readonly displayName?: string; readonly profilePictureUrl?: string; readonly isAnysphereUser?: boolean };
export interface CursorProfile { readonly email?: string; readonly displayName?: string; readonly profilePictureUrl?: string; readonly isAnysphereUser: boolean }
export interface CursorTokens { readonly accessToken: string; readonly refreshToken: string }
export interface CursorSecretStore {
  readSecret(key: string): Promise<string | null | undefined>;
  writeSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  isEncryptedStorageAvailable(): boolean;
}
export interface LoginMetadata { readonly uuid: string; readonly verifier: string }
export interface CursorLoginManager {
  startLogin(): { readonly metadata: LoginMetadata; readonly loginUrl: string };
  waitForResult(metadata: LoginMetadata, signal?: AbortSignal): Promise<CursorTokens | null>;
}
export type AccessTokenReader = (options?: { readonly backendUrl?: string }) => Promise<string>;
export type SessionSettlement =
  | { readonly kind: "signed_out"; readonly cause: SessionSignoutCause; readonly durable: boolean; readonly accessToken: string }
  | { readonly kind: "keychain_unavailable"; readonly accessToken: string };

/**
 * A signed-out message that names the backend the person actually used.
 *
 * These read "Grok Bot couldn't confirm your Cursor sign-in" whatever they
 * signed into, so someone signing in to their own OpenGrok server was told
 * about a Cursor account they had never had. The message is chosen when it is
 * read rather than when the module loads, because the backend can change while
 * the app is running.
 */
function loggedOut(cursorText: string, openGrokText: string): { readonly kind: "logged-out"; readonly errorMessage: string } {
  return {
    kind: "logged-out",
    get errorMessage(): string {
      try {
        return new URL(getConfiguredBackendUrl()).origin === new URL(DEFAULT_CURSOR_BACKEND_URL).origin ? cursorText : openGrokText;
      } catch {
        return cursorText;
      }
    },
  } as const;
}

const RETAINED_AFTER_FAILED_LOGOUT_STATUS = loggedOut(
  "Grok Bot couldn't remove the saved Cursor sign-in. The account may return after Grok Bot restarts. Sign in to try again.",
  "Open Grok couldn't remove the saved sign-in. The account may come back after a restart. Sign in to try again.",
);
const LOGGED_OUT_STATUS = { kind: "logged-out" } as const;
const SIGN_IN_CONFIRMATION_FAILED_STATUS = loggedOut(
  "Grok Bot couldn't confirm your Cursor sign-in. Restart Grok Bot or sign in again.",
  "Open Grok couldn't confirm your sign-in with your server. Sign in again.",
);
const SIGN_IN_EXPIRED_STATUS = loggedOut(
  "Cursor sign-in expired. Sign in again to run Grok Bot.",
  "Your sign-in expired. Sign in again to keep working.",
);
const SIGN_IN_POLICY_VIOLATION_STATUS = { kind: "logged-out", errorMessage: SIGN_IN_POLICY_VIOLATION_MESSAGE } as const;
const LOGIN_DID_NOT_FINISH_STATUS = loggedOut(
  "Cursor sign-in did not finish. Try again.",
  "Sign-in did not finish. Try again.",
);
const ACCOUNT_REFUSED_STATUS = loggedOut(
  "This computer is linked to another Cursor account. Sign in with that account to continue.",
  "This computer is linked to another account. Sign in with that account to continue.",
);
const ACCOUNT_REFUSED_CREDENTIALS_RETAINED_STATUS = loggedOut(
  "This computer is linked to another Cursor account. Grok Bot couldn't remove the saved Cursor sign-in, so the account may return after restart. Sign in with the linked account to continue.",
  "This computer is linked to another account, and the saved sign-in could not be removed, so it may come back after a restart. Sign in with that account to continue.",
);

function base64UrlEncode(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64url"); }
export function createLoginMetadata(): { challenge: string; metadata: LoginMetadata } {
  const verifier = base64UrlEncode(randomBytes(32));
  return { challenge: base64UrlEncode(createHash("sha256").update(verifier).digest()), metadata: { uuid: randomUUID(), verifier } };
}
export function createLoggedInStatus(accessToken: string): SandAuthStatus {
  const payload = parseJwtPayload(accessToken);
  return {
    kind: "logged-in",
    ...(payload?.sub == null ? {} : { authId: payload.sub }),
    ...(payload?.email == null ? {} : { email: payload.email }),
    ...(payload?.exp == null ? {} : { expiresAt: payload.exp * 1_000 }),
  };
}
export function resolveDevLoginPlan(tier: string | null | undefined): { plan: "free" | "pro" | "pro_plus" | "enterprise" | "ultra"; trial: boolean } {
  switch ((tier ?? "").trim()) {
    case "Free": return { plan: "free", trial: false };
    case "ProTrial": return { plan: "pro", trial: true };
    case "ProPlusTrial": return { plan: "pro_plus", trial: true };
    case "Pro": return { plan: "pro", trial: false };
    case "ProPlus": return { plan: "pro_plus", trial: false };
    case "Enterprise": return { plan: "enterprise", trial: false };
    default: return { plan: "ultra", trial: false };
  }
}
export function getAuthWebsiteUrl(backendUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SAND_CURSOR_WEBSITE_URL ?? env.CURSOR_WEBSITE_URL;
  return configured != null && configured.length > 0 ? new URL(configured).toString() : isDevAuthBackend(backendUrl) ? DEFAULT_LOCAL_CURSOR_WEBSITE_URL : DEFAULT_CURSOR_WEBSITE_URL;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

export class SandBackendLoginManager implements CursorLoginManager {
  constructor(
    readonly backendUrl: string,
    readonly websiteUrl: string,
    private readonly options: {
      readonly redirectTarget?: string;
      readonly fetchImpl?: typeof fetch;
      readonly policyHeaders?: () => Promise<Record<string, string>>;
      readonly delay?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
      readonly maxAttempts?: number;
    } = {},
  ) {}
  startLogin() {
    const { challenge, metadata } = createLoginMetadata();
    const url = new URL("/loginDeepControl", this.websiteUrl);
    url.searchParams.set("challenge", challenge); url.searchParams.set("uuid", metadata.uuid);
    url.searchParams.set("mode", "login"); url.searchParams.set("redirectTarget", this.options.redirectTarget ?? resolveAuthRedirectTarget());
    return { metadata, loginUrl: url.toString() };
  }
  async waitForResult(metadata: LoginMetadata, signal?: AbortSignal): Promise<CursorTokens | null> {
    const url = new URL("/auth/poll", this.backendUrl);
    url.searchParams.set("uuid", metadata.uuid); url.searchParams.set("verifier", metadata.verifier);
    const policyHeaders = await (this.options.policyHeaders?.() ?? mdmSignInPolicyHeaders());
    let consecutiveErrors = 0;
    for (let attempt = 0; attempt < (this.options.maxAttempts ?? MAX_LOGIN_POLL_ATTEMPTS); attempt += 1) {
      if (signal?.aborted) return null;
      try {
        const request: RequestInit = { headers: createLocalCliModeHeaders({ "Content-Type": "application/json", ...policyHeaders }) };
        if (signal !== undefined) request.signal = signal;
        const response = await (this.options.fetchImpl ?? fetch)(url, request);
        if (response.status === 403) {
          let denialError: unknown;
          try { const body: unknown = await response.json(); denialError = typeof body === "object" && body != null && "error" in body ? body.error : undefined; } catch { denialError = undefined; }
          if (denialError === SIGN_IN_POLICY_VIOLATION_ERROR) throw new SignInPolicyViolationError();
          if (++consecutiveErrors >= 3) return null;
        } else if (response.status === 404) consecutiveErrors = 0;
        else if (!response.ok) { if (++consecutiveErrors >= 3) return null; }
        else {
          const result: unknown = await response.json();
          if (typeof result === "object" && result !== null && "accessToken" in result && typeof result.accessToken === "string" && "refreshToken" in result && typeof result.refreshToken === "string") return { accessToken: result.accessToken, refreshToken: result.refreshToken };
          return null;
        }
      } catch (error) {
        if (error instanceof SignInPolicyViolationError) throw error;
        if (signal?.aborted) return null;
        if (++consecutiveErrors >= 3) return null;
      }
      await (this.options.delay ?? abortableDelay)(Math.min(1_000 * 1.2 ** attempt, 10_000), signal);
    }
    return null;
  }
}

export function createDefaultLoginManager(): CursorLoginManager {
  const backendUrl = getConfiguredBackendUrl();
  if (isDevAuthBackend(backendUrl)) return new SandBackendLoginManager(backendUrl, getAuthWebsiteUrl(backendUrl));
  return new LoginManager({ redirectTarget: resolveAuthRedirectTarget() });
}

interface OAuthTokenBody { access_token?: string; refresh_token?: string; shouldLogout?: boolean; error?: string }
function parseOAuthTokenBody(value: unknown): OAuthTokenBody | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  for (const key of ["access_token", "refresh_token", "error"] as const) if (source[key] !== undefined && typeof source[key] !== "string") return null;
  if (source.shouldLogout !== undefined && typeof source.shouldLogout !== "boolean") return null;
  return source as OAuthTokenBody;
}

export interface SandCursorAuthServiceOptions {
  readonly openExternal: (url: string) => void | Promise<void>;
  readonly secrets?: CursorSecretStore;
  readonly createLoginManager?: () => CursorLoginManager;
  readonly fetchOAuthToken?: typeof fetch;
  readonly fetchProfile?: (getAccessToken: AccessTokenReader) => Promise<CursorProfile | null>;
  readonly updateProfileName?: (getAccessToken: AccessTokenReader, name: string) => Promise<void>;
  readonly secureStorageWaitOptions?: { readonly timeoutMs?: number; readonly intervalMs?: number };
  readonly waitForEncryptedStorage?: (isAvailable: () => boolean, options: { readonly timeoutMs?: number; readonly intervalMs?: number }) => Promise<void>;
  readonly reportSessionSettlement?: (settlement: SessionSettlement) => void;
  readonly policyHeaders?: () => Promise<Record<string, string>>;
  readonly reportFailure?: (operation: string, error: unknown) => void;
  readonly now?: () => number;
  readonly getBackendUrl?: () => string;
}

const defaultSecrets: CursorSecretStore = {
  readSecret,
  writeSecret,
  deleteSecret,
  isEncryptedStorageAvailable,
};

export class SandCursorAuthService {
  private readonly secrets: CursorSecretStore;
  private readonly listeners = new Set<(status: SandAuthStatus) => void>();
  private readonly profileCache = new Map<string, CursorProfile>();
  private readonly profilePromises = new Map<string, { operationEpoch: number; promise: Promise<CursorProfile | null> }>();
  private authOperationEpoch = 0;
  private credentialMutationTail: Promise<void> = Promise.resolve();
  private loginAbortController: AbortController | undefined;
  private readonly refreshPromises = new Map<string, Promise<string>>();
  private credentialState: "active" | "revoked" | "retained-after-failed-logout" = "active";
  private refreshFailureStreak: { operationEpoch: number; count: number; startedAtMs: number } | undefined;
  private keychainUnavailableReported = false;
  private signoutSettled = false;
  private reportedLoggedOutStatus: SandAuthStatus = LOGGED_OUT_STATUS;

  constructor(private readonly options: SandCursorAuthServiceOptions) {
    this.secrets = options.secrets ?? defaultSecrets;
  }
  private get credentialUseRevoked(): boolean { return this.credentialState !== "active"; }
  private get credentialsRevoked(): boolean { return this.credentialState === "revoked"; }
  private get credentialsRetainedAfterFailedLogout(): boolean { return this.credentialState === "retained-after-failed-logout"; }
  private advanceAuthOperationEpoch(): number { return ++this.authOperationEpoch; }
  private isCurrentAuthOperation(epoch: number): boolean { return epoch === this.authOperationEpoch; }
  private assertCurrentAuthOperation(epoch: number): void { if (!this.isCurrentAuthOperation(epoch)) throw new SandAuthOperationSupersededError(); }
  private async mutateCredentials<T>(mutation: () => T | Promise<T>): Promise<T> {
    const result = this.credentialMutationTail.then(mutation);
    this.credentialMutationTail = result.then(() => undefined, () => undefined);
    return await result;
  }
  private reportFailure(operation: string, error: unknown): void { this.options.reportFailure?.(operation, error); }
  private async removeStoredCredentials(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const key of [ACCESS_TOKEN_SECRET_KEY, REFRESH_TOKEN_SECRET_KEY]) try { await this.secrets.deleteSecret(key); } catch (error) { errors.push(error); }
    return errors;
  }
  private async rollbackSupersededAuthentication(): Promise<void> {
    this.credentialState = "revoked";
    const failures = await this.removeStoredCredentials();
    if (failures.length > 0) throw new AggregateError(failures, "Failed to remove superseded Cursor credentials");
  }
  private async settleSecureStorage(): Promise<void> {
    if (shouldPersistSecretsOnDisk()) return;
    if (this.options.waitForEncryptedStorage != null) { await this.options.waitForEncryptedStorage(() => this.secrets.isEncryptedStorageAvailable(), this.options.secureStorageWaitOptions ?? {}); return; }
    await waitForEncryptedStorage(() => this.secrets.isEncryptedStorageAvailable(), this.options.secureStorageWaitOptions ?? {});
  }
  subscribe(listener: (status: SandAuthStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async getStatus(): Promise<SandAuthStatus> {
    const operationEpoch = this.authOperationEpoch;
    if (this.credentialsRetainedAfterFailedLogout) return RETAINED_AFTER_FAILED_LOGOUT_STATUS;
    if (this.credentialsRevoked) return this.reportedLoggedOutStatus;
    const [accessToken, refreshToken] = await Promise.all([this.secrets.readSecret(ACCESS_TOKEN_SECRET_KEY), this.secrets.readSecret(REFRESH_TOKEN_SECRET_KEY)]);
    if (this.credentialsRetainedAfterFailedLogout) return RETAINED_AFTER_FAILED_LOGOUT_STATUS;
    if (this.credentialsRevoked || accessToken == null || refreshToken == null) return this.credentialsRevoked ? this.reportedLoggedOutStatus : LOGGED_OUT_STATUS;
    const status = createLoggedInStatus(accessToken);
    if (status.kind === "logged-in" && status.authId != null) await this.ensureProfile(status.authId, operationEpoch);
    if (this.credentialUseRevoked || !this.isCurrentAuthOperation(operationEpoch)) return await this.getStatus();
    return this.withProfile(status);
  }
  private withProfile(status: SandAuthStatus): SandAuthStatus {
    if (status.kind !== "logged-in" || status.authId == null) return status;
    const profile = this.profileCache.get(status.authId); if (profile == null) return status;
    const email = status.email ?? profile.email;
    return { ...status, ...(email == null ? {} : { email }), ...(profile.displayName == null ? {} : { displayName: profile.displayName }), ...(profile.profilePictureUrl == null ? {} : { profilePictureUrl: profile.profilePictureUrl }), isAnysphereUser: profile.isAnysphereUser };
  }
  async updateDisplayName(rawName: string): Promise<SandAuthStatus> {
    const status = await this.getStatus(); if (status.kind !== "logged-in" || status.authId == null) return status;
    if (this.options.updateProfileName == null) throw new Error("updateDisplayName requires the wiring-injected profile-name writer.");
    const name = rawName.replace(/\s+/g, " ").trim(); await this.options.updateProfileName((options) => this.getValidAccessToken(options), name);
    const cached = this.profileCache.get(status.authId);
    this.profileCache.set(status.authId, { ...(cached?.email ?? status.email) == null ? {} : { email: cached?.email ?? status.email }, ...(cached?.profilePictureUrl == null ? {} : { profilePictureUrl: cached.profilePictureUrl }), isAnysphereUser: cached?.isAnysphereUser ?? false, ...(name.length === 0 ? {} : { displayName: name }) });
    const next = await this.getStatus(); this.emitStatus(next); return next;
  }
  private async ensureProfile(authId: string, operationEpoch: number): Promise<void> {
    if (!this.isCurrentAuthOperation(operationEpoch) || this.options.fetchProfile == null || this.profileCache.has(authId)) return;
    let pending = this.profilePromises.get(authId);
    if (pending == null || pending.operationEpoch !== operationEpoch) { pending = { operationEpoch, promise: this.options.fetchProfile((options) => this.getValidAccessToken(options)) }; this.profilePromises.set(authId, pending); }
    try { const profile = await pending.promise; if (profile != null && this.isCurrentAuthOperation(pending.operationEpoch) && this.profilePromises.get(authId) === pending) this.profileCache.set(authId, profile); }
    catch (error) { this.reportFailure("profile-fetch", error); }
    finally { if (this.profilePromises.get(authId) === pending) this.profilePromises.delete(authId); }
  }
  private async emitLoggedIn(accessToken: string, operationEpoch: number): Promise<SandAuthStatus> {
    const base = createLoggedInStatus(accessToken); if (base.kind === "logged-in" && base.authId != null) await this.ensureProfile(base.authId, operationEpoch);
    if (this.credentialUseRevoked || !this.isCurrentAuthOperation(operationEpoch)) return await this.getStatus();
    const status = this.withProfile(base); this.emitStatus(status); return status;
  }
  async getValidAccessToken(options?: { readonly backendUrl?: string }): Promise<string> {
    const operationEpoch = this.authOperationEpoch; if (this.credentialUseRevoked) throw new SandAuthSignInRequiredError();
    const backendUrl = options?.backendUrl ?? DEFAULT_CURSOR_BACKEND_URL;
    const [accessToken, refreshToken] = await Promise.all([this.secrets.readSecret(ACCESS_TOKEN_SECRET_KEY), this.secrets.readSecret(REFRESH_TOKEN_SECRET_KEY)]);
    if (!this.isCurrentAuthOperation(operationEpoch) || this.credentialUseRevoked || accessToken == null || refreshToken == null) throw new SandAuthSignInRequiredError();
    return shouldRefreshAccessToken(backendUrl, accessToken) ? await this.refreshAccessToken({ backendUrl, operationEpoch, refreshToken }) : accessToken;
  }
  async peekAccessToken(): Promise<string | null> { if (this.credentialUseRevoked) return null; const [access, refresh] = await Promise.all([this.secrets.readSecret(ACCESS_TOKEN_SECRET_KEY), this.secrets.readSecret(REFRESH_TOKEN_SECRET_KEY)]); return this.credentialUseRevoked || access == null || refresh == null ? null : access; }
  async exportTokens(): Promise<CursorTokens | null> { if (this.credentialUseRevoked) return null; const [accessToken, refreshToken] = await Promise.all([this.secrets.readSecret(ACCESS_TOKEN_SECRET_KEY), this.secrets.readSecret(REFRESH_TOKEN_SECRET_KEY)]); return this.credentialUseRevoked || accessToken == null || refreshToken == null ? null : { accessToken, refreshToken }; }
  async login(): Promise<SandAuthStatus> {
    this.abortActiveLogin(); const operationEpoch = this.advanceAuthOperationEpoch(); const controller = new AbortController(); this.loginAbortController = controller;
    try { return await this.runLogin(controller.signal, operationEpoch); } finally { if (this.loginAbortController === controller) this.loginAbortController = undefined; }
  }
  async cancelLogin(): Promise<SandAuthStatus> { return await this.revokeCredentials({ emitStatus: true, cause: "login_cancelled" }); }
  private abortActiveLogin(): void { this.loginAbortController?.abort(); this.loginAbortController = undefined; }
  async revokeForAccountRefusal(): Promise<{ kind: "completed"; status: SandAuthStatus } | { kind: "failed"; status: SandAuthStatus; error: unknown }> {
    const revocation = this.revokeCredentials({ emitStatus: false, cause: "account_refused", loggedOutStatus: ACCOUNT_REFUSED_STATUS }); const operationEpoch = this.authOperationEpoch;
    try { await revocation; } catch (error) { const status = await this.getStatus(); if (!this.isCurrentAuthOperation(operationEpoch) || status.kind === "logged-out" && status.errorMessage != null && status !== ACCOUNT_REFUSED_STATUS) return { kind: "failed", status, error }; this.reportedLoggedOutStatus = ACCOUNT_REFUSED_CREDENTIALS_RETAINED_STATUS; return { kind: "failed", status: ACCOUNT_REFUSED_CREDENTIALS_RETAINED_STATUS, error }; }
    if (!this.isCurrentAuthOperation(operationEpoch)) return { kind: "completed", status: await this.getStatus() };
    this.reportedLoggedOutStatus = ACCOUNT_REFUSED_STATUS; return { kind: "completed", status: ACCOUNT_REFUSED_STATUS };
  }
  async logout(): Promise<SandAuthStatus> { return await this.revokeCredentials({ emitStatus: true, cause: "user_action" }); }

  /**
   * Accept credentials established outside this service's own login flow - an
   * OpenGrok server signing the person in, for instance. Signing out latches
   * credentialState to "revoked" and getStatus honours that latch over whatever
   * is in the store, which is right for Cursor because login() is the only way
   * back. It is wrong once another backend can establish a session for the same
   * single account: the tokens were written, but the latch kept reporting
   * logged-out until the process restarted.
   */
  async adoptExternalCredentials(): Promise<SandAuthStatus> {
    this.credentialState = "active";
    this.reportedLoggedOutStatus = LOGGED_OUT_STATUS;
    this.profileCache.clear();
    const status = await this.getStatus();
    this.emitStatus(status);
    return status;
  }
  private async readDepartingSessionToken(): Promise<string | null> { try { const [access, refresh] = await Promise.all([this.secrets.readSecret(ACCESS_TOKEN_SECRET_KEY), this.secrets.readSecret(REFRESH_TOKEN_SECRET_KEY)]); return access == null || refresh == null ? null : access; } catch (error) { this.reportFailure("session-settlement", error); return null; } }
  private async revokeCredentials(options: { emitStatus: boolean; cause: SessionSignoutCause; loggedOutStatus?: SandAuthStatus }): Promise<SandAuthStatus> {
    const logoutOperationEpoch = this.advanceAuthOperationEpoch(); this.abortActiveLogin(); const startedRetained = this.credentialState === "retained-after-failed-logout"; const status = options.loggedOutStatus ?? LOGGED_OUT_STATUS;
    if (!startedRetained) { this.credentialState = "revoked"; this.reportedLoggedOutStatus = status; } this.profileCache.clear();
    const { failures, settlement } = await this.mutateCredentials(async () => { const token = await this.readDepartingSessionToken(); const failures = await this.removeStoredCredentials(); if (token == null || this.signoutSettled) return { failures }; this.signoutSettled = true; return { failures, settlement: { kind: "signed_out" as const, cause: options.cause, durable: failures.length === 0, accessToken: token } }; });
    const current = this.isCurrentAuthOperation(logoutOperationEpoch); const retained = current && (options.emitStatus ? startedRetained || failures.length > 0 : startedRetained && failures.length > 0); if (current) this.credentialState = retained ? "retained-after-failed-logout" : "revoked";
    if (settlement != null) { this.options.reportSessionSettlement?.(settlement); reportSigninSignout(settlement.durable ? signinSignoutCause(settlement.cause) : "retained_after_failed_logout"); }
    const reported = retained ? RETAINED_AFTER_FAILED_LOGOUT_STATUS : status; if (current && options.emitStatus) this.emitStatus(reported);
    if (failures.length > 0) throw new AggregateError(failures, retained ? RETAINED_AFTER_FAILED_LOGOUT_STATUS.errorMessage : "Failed to remove Cursor credentials"); return reported;
  }
  async devLogin(args: { readonly tier?: string; readonly email?: string }): Promise<SandAuthStatus> {
    const backendUrl = this.options.getBackendUrl?.() ?? getConfiguredBackendUrl(); if (!isDevAuthBackend(backendUrl)) throw new SandDevLoginError(`Refusing dev-login against non-dev backend ${backendUrl}. Set SAND_BACKEND_URL to a local backend (e.g. https://localhost:8000).`);
    this.abortActiveLogin(); const operationEpoch = this.advanceAuthOperationEpoch(); await this.settleSecureStorage(); if (!this.isCurrentAuthOperation(operationEpoch)) return await this.getStatus(); this.emitStatus({ kind: "logging-in" });
    const { plan, trial } = resolveDevLoginPlan(args.tier); const url = new URL("/auth/cursor_dev_session_token", backendUrl); url.searchParams.set("plan", plan); if (trial) url.searchParams.set("trial", "true"); if (args.email != null && args.email.length > 0) url.searchParams.set("email", args.email);
    const response = await (this.options.fetchOAuthToken ?? fetch)(url, { headers: { accept: "application/json" } }); if (!response.ok) throw new SandDevLoginError(`dev session token request failed: ${response.status} ${response.statusText}`);
    const body: unknown = await response.json(); if (typeof body !== "object" || body == null || !("accessToken" in body) || typeof body.accessToken !== "string") throw new SandDevLoginError("dev session response did not include an accessToken.");
    const result = { accessToken: body.accessToken, refreshToken: "refreshToken" in body && typeof body.refreshToken === "string" ? body.refreshToken : body.accessToken };
    if (!await this.storeAuthentication(result, operationEpoch)) return await this.getStatus(); return await this.emitLoggedIn(result.accessToken, operationEpoch);
  }
  private async runLogin(signal: AbortSignal, operationEpoch: number): Promise<SandAuthStatus> {
    const settling = this.settleSecureStorage().catch((error) => this.reportFailure("secure-storage-settle", error)); this.emitStatus({ kind: "logging-in" }); const manager = (this.options.createLoginManager ?? createDefaultLoginManager)(); const { metadata, loginUrl } = manager.startLogin(); reportSigninLogin({ phase: "login_started" });
    try { await this.options.openExternal(loginUrl); } catch (error) { if (!signal.aborted && this.isCurrentAuthOperation(operationEpoch)) reportSigninLogin({ phase: "login_failed", cause: "error" }); throw error; }
    if (signal.aborted || !this.isCurrentAuthOperation(operationEpoch)) return await this.getStatus();
    let result: CursorTokens | null;
    try { result = await manager.waitForResult(metadata, signal); } catch (error) { if (signal.aborted || !this.isCurrentAuthOperation(operationEpoch)) return await this.getStatus(); if (error instanceof SignInPolicyViolationError) { const status = await this.getStatus(); this.emitStatus(status.kind === "logged-out" && status.errorMessage === undefined ? SIGN_IN_POLICY_VIOLATION_STATUS : status); reportSigninLogin({ phase: "login_failed", cause: "policy_refused" }); } else reportSigninLogin({ phase: "login_failed", cause: "error" }); throw error; }
    if (signal.aborted || !this.isCurrentAuthOperation(operationEpoch)) return await this.getStatus();
    if (result == null) { const status = await this.getStatus(); if (status.kind === "logged-out" && status.errorMessage === undefined) { this.credentialState = "revoked"; this.reportedLoggedOutStatus = LOGIN_DID_NOT_FINISH_STATUS; this.emitStatus(LOGIN_DID_NOT_FINISH_STATUS); } else this.emitStatus(status); reportSigninLogin({ phase: "login_failed", cause: "timeout" }); throw new SandAuthLoginTimedOutError(); }
    await settling; try { if (!await this.storeAuthentication(result, operationEpoch)) return await this.getStatus(); } catch (error) { if (!signal.aborted && this.isCurrentAuthOperation(operationEpoch)) reportSigninLogin({ phase: "login_failed", cause: "error" }); throw error; }
    reportSigninLogin({ phase: "login_completed" }); return await this.emitLoggedIn(result.accessToken, operationEpoch);
  }
  private async storeAuthentication(result: CursorTokens, operationEpoch: number): Promise<boolean> {
    const stored = await this.mutateCredentials(async () => { if (!this.isCurrentAuthOperation(operationEpoch)) return false; await this.secrets.writeSecret(ACCESS_TOKEN_SECRET_KEY, result.accessToken); if (!this.isCurrentAuthOperation(operationEpoch)) { await this.rollbackSupersededAuthentication(); return false; } await this.secrets.writeSecret(REFRESH_TOKEN_SECRET_KEY, result.refreshToken); if (!this.isCurrentAuthOperation(operationEpoch)) { await this.rollbackSupersededAuthentication(); return false; } this.credentialState = "active"; this.signoutSettled = false; this.reportedLoggedOutStatus = LOGGED_OUT_STATUS; return true; });
    if (stored) this.noteSecretsUnavailableSession(result.accessToken); return stored;
  }
  private noteSecretsUnavailableSession(accessToken: string): void { if (this.keychainUnavailableReported) return; let encrypted: boolean; try { encrypted = this.secrets.isEncryptedStorageAvailable(); } catch (error) { this.reportFailure("session-settlement", error); return; } if (encrypted) return; this.keychainUnavailableReported = true; this.options.reportSessionSettlement?.({ kind: "keychain_unavailable", accessToken }); }
  private noteRefreshFailure(operationEpoch: number, failure: SessionRefreshFailure): void { if (!this.isCurrentAuthOperation(operationEpoch)) return; if (this.refreshFailureStreak?.operationEpoch !== operationEpoch) { this.refreshFailureStreak = { operationEpoch, count: 1, startedAtMs: (this.options.now ?? Date.now)() }; reportSessionEvent({ phase: "refresh_failed", failure }); } else this.refreshFailureStreak.count += 1; }
  private noteRefreshSettled(operationEpoch: number, rescued: boolean): void { if (!this.isCurrentAuthOperation(operationEpoch)) return; const streak = this.refreshFailureStreak; if (streak?.operationEpoch === operationEpoch) { this.refreshFailureStreak = undefined; reportSessionEvent({ phase: "refresh_recovered", consecutiveFailures: streak.count, degradedMs: (this.options.now ?? Date.now)() - streak.startedAtMs }); } if (rescued) reportSessionEvent({ phase: "rotation_rescued" }); }
  private async refreshAccessToken(args: { backendUrl: string; operationEpoch: number; refreshToken: string }): Promise<string> { const active = this.refreshPromises.get(args.refreshToken); if (active != null) return await active; const promise = this.runRefreshAccessToken(args); this.refreshPromises.set(args.refreshToken, promise); try { return await promise; } finally { if (this.refreshPromises.get(args.refreshToken) === promise) this.refreshPromises.delete(args.refreshToken); } }
  /**
   * The access token another refresh already won, if this one lost the race.
   *
   * Refresh tokens rotate single-use, so a concurrent refresh leaves this one
   * presenting a token the backend has already replaced. It answers "unknown
   * refresh token" - identical to a dead session - so the only way to tell them
   * apart is that our own store has moved on.
   */
  private async accessTokenIfSuperseded(presentedRefreshToken: string, operationEpoch: number): Promise<string | null> {
    const storedRefresh = await this.secrets.readSecret(REFRESH_TOKEN_SECRET_KEY);
    this.assertCurrentAuthOperation(operationEpoch);
    if (storedRefresh == null || storedRefresh === presentedRefreshToken) return null;
    const storedAccess = await this.secrets.readSecret(ACCESS_TOKEN_SECRET_KEY);
    this.assertCurrentAuthOperation(operationEpoch);
    return storedAccess != null && storedAccess.length > 0 ? storedAccess : null;
  }

  private async runRefreshAccessToken(args: { backendUrl: string; operationEpoch: number; refreshToken: string }): Promise<string> {
    const policyHeaders = await (this.options.policyHeaders?.() ?? Promise.resolve({})); this.assertCurrentAuthOperation(args.operationEpoch); let response: Response;
    try { response = await (this.options.fetchOAuthToken ?? fetch)(new URL("/oauth/token", args.backendUrl), { method: "POST", body: JSON.stringify({ client_id: getAuthClientId(args.backendUrl), grant_type: "refresh_token", refresh_token: args.refreshToken }), headers: { "content-type": "application/json", ...policyHeaders } }); } catch (error) { this.noteRefreshFailure(args.operationEpoch, { kind: "network", errno: findSystemErrno(error) ?? "E_OTHER" }); throw error; }
    this.assertCurrentAuthOperation(args.operationEpoch);
    if (!response.ok) {
      this.noteRefreshFailure(args.operationEpoch, { kind: "http_status", httpStatus: response.status });
      const refusal = await readRefreshRefusal(response);
      if (!refusal.rejectsCredential) {
        this.assertCurrentAuthOperation(args.operationEpoch);
        throw new SandAuthRefreshUnavailableError(response.status, refusal.detail);
      }
      const superseded = await this.accessTokenIfSuperseded(args.refreshToken, args.operationEpoch);
      if (superseded != null) { this.noteRefreshSettled(args.operationEpoch, true); return superseded; }
      this.assertCurrentAuthOperation(args.operationEpoch);
      this.advanceAuthOperationEpoch(); this.credentialState = "revoked";
      this.reportedLoggedOutStatus = SIGN_IN_CONFIRMATION_FAILED_STATUS; this.profileCache.clear();
      this.emitStatus(SIGN_IN_CONFIRMATION_FAILED_STATUS); throw new SandAuthSignInExpiredError();
    }
    let raw: unknown; try { raw = await response.json(); } catch (error) { this.noteRefreshFailure(args.operationEpoch, { kind: "bad_payload" }); throw error; }
    const parsed = parseOAuthTokenBody(raw); this.assertCurrentAuthOperation(args.operationEpoch);
    if (parsed?.shouldLogout === true && parsed.error === SIGN_IN_POLICY_VIOLATION_ERROR) { await this.revokeCredentials({ emitStatus: true, cause: "policy", loggedOutStatus: SIGN_IN_POLICY_VIOLATION_STATUS }); throw new SignInPolicyViolationError(); }
    if (parsed == null || parsed.shouldLogout === true) { const superseded = await this.accessTokenIfSuperseded(args.refreshToken, args.operationEpoch); if (superseded != null) { this.noteRefreshSettled(args.operationEpoch, true); return superseded; } await this.revokeCredentials({ emitStatus: true, cause: parsed == null ? "unparseable" : "session_revoked", ...(parsed == null ? {} : { loggedOutStatus: SIGN_IN_EXPIRED_STATUS }) }); throw new SandAuthSignInExpiredError(); }
    const accessToken = parsed.access_token; if (accessToken == null || accessToken.length === 0) { this.noteRefreshFailure(args.operationEpoch, { kind: "bad_payload" }); throw new SandAuthSignInExpiredError(); }
    const previous = await this.secrets.readSecret(ACCESS_TOKEN_SECRET_KEY); this.assertCurrentAuthOperation(args.operationEpoch); if (!await this.storeAuthentication({ accessToken, refreshToken: parsed.refresh_token ?? args.refreshToken }, args.operationEpoch)) throw new SandAuthOperationSupersededError(); this.assertCurrentAuthOperation(args.operationEpoch); this.noteRefreshSettled(args.operationEpoch, false);
    if (previous == null || parseJwtPayload(previous)?.sub !== parseJwtPayload(accessToken)?.sub) this.emitStatus(this.withProfile(createLoggedInStatus(accessToken))); return accessToken;
  }
  private emitStatus(status: SandAuthStatus): void { for (const listener of this.listeners) listener(status); }
}
