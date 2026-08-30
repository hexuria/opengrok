import { createSandAccessReader, readSandAccessOnce, type SandAccess } from "./access.js";
import { SandCursorAuthService, type AccessTokenReader, type SandAuthStatus, type SandCursorAuthServiceOptions } from "./cursor-auth.js";
import { fetchCursorProfile, fetchLocalToolPermissionCeiling, fetchUserPrivacyMode, updateCursorProfileName } from "./cursor-profile.js";
import { SandTranscriptionManager, type SandTranscriptionOptions } from "./cursor-transcribe.js";
import { syncSandSentryAccount } from "../telemetry/sentry.js";
import type { PrivacyMode } from "../../shared/observability/sentry-privacy-mode.js";

export const SUPPORTED_DASHBOARD_ACTIONS = new Set(["requestLimitIncrease"] as const);
export const NO_SAND_PR_REVIEW_PREFERENCES = { user: undefined, team: undefined } as const;
export interface DashboardActionRequest { readonly action: "requestLimitIncrease"; readonly args: Readonly<Record<string, string>> }
export interface AccountRuntime {
  observe(status: SandAuthStatus): void;
  whenIdle(): Promise<SandAuthStatus | null | undefined>;
}
export interface AuthServicePort {
  subscribe(listener: (status: SandAuthStatus) => void): () => void;
  getStatus(): Promise<SandAuthStatus>;
  getValidAccessToken(options?: { readonly backendUrl?: string }): Promise<string>;
  peekAccessToken?(): Promise<string | null>;
  revokeForAccountRefusal(): Promise<{ readonly kind: "completed"; readonly status: SandAuthStatus } | { readonly kind: "failed"; readonly status: SandAuthStatus; readonly error: unknown }>;
  login(): Promise<SandAuthStatus>;
  cancelLogin(): Promise<SandAuthStatus>;
  logout(): Promise<SandAuthStatus>;
  adoptExternalCredentials(): Promise<SandAuthStatus>;
  updateDisplayName(name: string): Promise<SandAuthStatus>;
  devLogin?(options: { readonly tier?: string; readonly email?: string }): Promise<SandAuthStatus>;
}

export function createCursorAuthWiring(deps: {
  readonly openExternal: (url: string) => void | Promise<void>;
  readonly serviceOptions?: Omit<SandCursorAuthServiceOptions, "openExternal">;
  readonly createAuthService?: (options: SandCursorAuthServiceOptions) => AuthServicePort;
  readonly fetchProfile?: (getAccessToken: AccessTokenReader) => Promise<{ readonly email?: string; readonly displayName?: string; readonly profilePictureUrl?: string; readonly isAnysphereUser: boolean } | null>;
  readonly updateProfileName?: (getAccessToken: AccessTokenReader, name: string) => Promise<void>;
  readonly reportSessionSettlement?: SandCursorAuthServiceOptions["reportSessionSettlement"];
  readonly getAccountRuntime: () => AccountRuntime | null | undefined;
  readonly emitAuthStatus: (status: SandAuthStatus & { readonly freshness: number }) => void;
  readonly sentryEnabled: boolean;
  readonly syncSentryAccount?: (status: SandAuthStatus, privacyMode: () => Promise<unknown>) => void | Promise<void>;
  readonly fetchUserPrivacyMode?: (getAccessToken: AccessTokenReader) => Promise<unknown>;
  readonly fetchLocalToolPermissionCeiling?: (getAccessToken: AccessTokenReader) => Promise<string | undefined>;
  readonly settingsStore: {
    getLocalToolPermission(): string;
    setLocalToolPermissionCeiling(ceiling: string | undefined): void;
  };
  readonly syncHostSettingsToBox: (settings: { readonly localToolPermission: string }) => Promise<void>;
  readonly reportFailure?: (domain: string, operation: string, error: unknown) => void;
}) {
  let cursorAuthService: AuthServicePort | undefined;
  let unsubscribeAuthStatus: (() => void) | undefined;
  let authStatusFreshness = 0;
  let localToolCeilingSyncSeq = 0;
  const readPrivacyMode = deps.fetchUserPrivacyMode ?? (async (getAccessToken: AccessTokenReader) => await fetchUserPrivacyMode(getAccessToken, {}));
  const readLocalToolPermissionCeiling = deps.fetchLocalToolPermissionCeiling ?? (async (getAccessToken: AccessTokenReader) => await fetchLocalToolPermissionCeiling(getAccessToken, {}));
  const syncSentryAccount = deps.syncSentryAccount ?? (async (status: SandAuthStatus, privacyMode: () => Promise<unknown>) => await syncSandSentryAccount(status as Parameters<typeof syncSandSentryAccount>[0], async () => await privacyMode() as PrivacyMode));

  async function syncLocalToolPermissionCeiling(service: AuthServicePort, status: SandAuthStatus): Promise<void> {
    const sequence = ++localToolCeilingSyncSeq;
    const previous = deps.settingsStore.getLocalToolPermission();
    let ceiling: string | undefined;
    if (status.kind === "logged-in") ceiling = await readLocalToolPermissionCeiling((options) => service.getValidAccessToken(options));
    if (sequence !== localToolCeilingSyncSeq) return;
    deps.settingsStore.setLocalToolPermissionCeiling(ceiling);
    const effective = deps.settingsStore.getLocalToolPermission();
    if (effective === previous) return;
    try { await deps.syncHostSettingsToBox({ localToolPermission: effective }); }
    catch (error) { deps.reportFailure?.("host-settings", "local-tool-ceiling", error); }
  }

  function deliverCursorAuthStatus(service: AuthServicePort, status: SandAuthStatus): void {
    authStatusFreshness += 1;
    deps.emitAuthStatus({ ...status, freshness: authStatusFreshness });
    if (deps.sentryEnabled) void syncSentryAccount(status, () => readPrivacyMode((options) => service.getValidAccessToken(options)));
    void syncLocalToolPermissionCeiling(service, status);
  }

  async function ensureCursorAuthService(): Promise<AuthServicePort> {
    if (cursorAuthService != null) return cursorAuthService;
    const service = (deps.createAuthService ?? ((options) => new SandCursorAuthService(options)))({
      ...(deps.serviceOptions ?? {}),
      openExternal: deps.openExternal,
      fetchProfile: deps.fetchProfile ?? (async (getAccessToken) => {
        const profile = await fetchCursorProfile(getAccessToken, {});
        return profile == null ? null : {
          isAnysphereUser: profile.isAnysphereUser,
          ...(profile.email === undefined ? {} : { email: profile.email }),
          ...(profile.displayName === undefined ? {} : { displayName: profile.displayName }),
          ...(profile.profilePictureUrl === undefined ? {} : { profilePictureUrl: profile.profilePictureUrl }),
        };
      }),
      updateProfileName: deps.updateProfileName ?? ((getAccessToken, name) => updateCursorProfileName(getAccessToken, name, {})),
      ...(deps.reportSessionSettlement == null ? {} : { reportSessionSettlement: deps.reportSessionSettlement }),
    });
    unsubscribeAuthStatus = service.subscribe((status) => {
      const runtime = deps.getAccountRuntime();
      if (runtime == null) deliverCursorAuthStatus(service, status);
      else runtime.observe(status);
    });
    cursorAuthService = service;
    if (deps.sentryEnabled) void service.getStatus().then((status) => syncSentryAccount(status, () => readPrivacyMode((options) => service.getValidAccessToken(options))));
    void service.getStatus().then((status) => syncLocalToolPermissionCeiling(service, status));
    return service;
  }

  return {
    ensureCursorAuthService,
    deliverCursorAuthStatus,
    currentAuthStatusFreshness: () => authStatusFreshness,
    dispose(): void {
      unsubscribeAuthStatus?.();
      unsubscribeAuthStatus = undefined;
      cursorAuthService = undefined;
      localToolCeilingSyncSeq += 1;
    },
  };
}

export function parseDashboardActionRequest(request: unknown): DashboardActionRequest | null {
  if (request == null || typeof request !== "object") return null;
  const { action, args } = request as { action?: unknown; args?: unknown };
  if (typeof action !== "string" || !SUPPORTED_DASHBOARD_ACTIONS.has(action as never)) return null;
  if (args == null || typeof args !== "object" || Array.isArray(args)) return null;
  const entries = Object.entries(args);
  if (!entries.every(([, value]) => typeof value === "string")) return null;
  return { action: action as DashboardActionRequest["action"], args: Object.fromEntries(entries) as Record<string, string> };
}

export function createCursorAccountEdgePort(deps: {
  readonly ensureCursorAuthService: () => Promise<AuthServicePort>;
  readonly currentAuthStatusFreshness: () => number;
  readonly getAccountRuntime: () => AccountRuntime | null | undefined;
  readonly readSandAccess: (getAccessToken: AccessTokenReader) => Promise<SandAccess>;
  readonly resetMcpManager: () => void | Promise<void>;
  readonly refreshHostMcp: () => void | Promise<void>;
  readonly resolveAvatar: (authId: string, preferredUrl?: string) => Promise<string | null>;
  readonly fetchWeeklyUsage: (getAccessToken: AccessTokenReader) => Promise<unknown>;
  readonly isUsagePageEnabled: () => boolean | Promise<boolean>;
  readonly fetchUsageSummary: (getAccessToken: AccessTokenReader) => Promise<unknown>;
  readonly fetchPrReviewPreferences: (getAccessToken: AccessTokenReader) => Promise<unknown>;
  readonly fetchPrivacyModeEnabled: (getAccessToken: AccessTokenReader) => Promise<boolean>;
  readonly cancelTrial: (getAccessToken: AccessTokenReader) => Promise<unknown>;
  readonly invokeDashboardAction: (getAccessToken: AccessTokenReader, request: DashboardActionRequest) => Promise<unknown>;
  readonly productDisplayName?: string;
}) {
  let sandAccessReader: Promise<ReturnType<typeof createSandAccessReader>> | undefined;
  const settledStatus = async (getStatus: () => Promise<SandAuthStatus>) => await deps.getAccountRuntime()?.whenIdle() ?? await getStatus();
  const sandAccessDeps = async () => {
    const service = await deps.ensureCursorAuthService();
    return { getAuthStatus: () => settledStatus(() => service.getStatus()), readAccess: () => deps.readSandAccess((options) => service.getValidAccessToken(options)) };
  };
  const ensureSandAccessReader = async () => {
    sandAccessReader ??= sandAccessDeps().then(createSandAccessReader);
    return await sandAccessReader;
  };
  const withService = async <T>(operation: (service: AuthServicePort) => Promise<T>): Promise<T> => await operation(await deps.ensureCursorAuthService());
  const tokenReader = (service: AuthServicePort): AccessTokenReader => (options) => service.getValidAccessToken(options);
  return {
    getSandAccess: async () => await (await ensureSandAccessReader()).read(),
    getSandAccessFresh: async () => (await readSandAccessOnce(await sandAccessDeps())).access,
    getAuthStatus: async () => { const freshness = deps.currentAuthStatusFreshness(); const service = await deps.ensureCursorAuthService(); return { ...await settledStatus(() => service.getStatus()), freshness }; },
    login: async () => withService(async (service) => { const result = await service.login(); const settled = await deps.getAccountRuntime()?.whenIdle(); await deps.resetMcpManager(); await deps.refreshHostMcp(); return settled ?? result; }),
    cancelLogin: async () => withService(async (service) => { const result = await service.cancelLogin(); return await deps.getAccountRuntime()?.whenIdle() ?? result; }),
    logout: async () => withService(async (service) => { const result = await service.logout(); return await deps.getAccountRuntime()?.whenIdle() ?? result; }),
    // Used when another backend has established the session for this one account -
    // the tokens are already stored; the service just has to stop remembering the
    // last sign-out, which otherwise reports logged-out until the process restarts.
    adoptExternalCredentials: async () => withService(async (service) => {
      const result = await service.adoptExternalCredentials();
      return await deps.getAccountRuntime()?.whenIdle() ?? result;
    }),
    getValidAccessToken: async (options?: { readonly backendUrl?: string }) =>
      await (await deps.ensureCursorAuthService()).getValidAccessToken(options),
    updateAccountName: async (name: unknown) => {
      if (typeof name !== "string" || name.length > 200) throw new Error("updateCursorAccountName requires a bounded name string.");
      return await withService(async (service) => { const result = await service.updateDisplayName(name); return await deps.getAccountRuntime()?.whenIdle() ?? result; });
    },
    getAvatar: async () => withService(async (service) => { const status = await service.getStatus(); return status.kind !== "logged-in" || status.authId == null ? null : await deps.resolveAvatar(status.authId, status.profilePictureUrl); }),
    getWeeklyUsage: async () => withService(async (service) => (await service.getStatus()).kind === "logged-in" ? await deps.fetchWeeklyUsage(tokenReader(service)) : null),
    getUsageSummary: async () => !await deps.isUsagePageEnabled() ? null : await withService(async (service) => (await service.getStatus()).kind === "logged-in" ? await deps.fetchUsageSummary(tokenReader(service)) : null),
    getPrReviewPreferences: async () => withService(async (service) => (await service.getStatus()).kind === "logged-in" ? await deps.fetchPrReviewPreferences(tokenReader(service)) : NO_SAND_PR_REVIEW_PREFERENCES),
    getPrivacyModeEnabled: async () => withService(async (service) => (await service.getStatus()).kind === "logged-in" ? await deps.fetchPrivacyModeEnabled(tokenReader(service)) : true),
    cancelTrial: async () => !await deps.isUsagePageEnabled() ? { ok: false, message: "This isn’t available right now" } : await withService(async (service) => (await service.getStatus()).kind === "logged-in" ? await deps.cancelTrial(tokenReader(service)) : { ok: false, message: "Sign in to Cursor to continue" }),
    invokeDashboardAction: async (raw: unknown) => {
      const request = parseDashboardActionRequest(raw);
      if (request == null) return { ok: false, message: `This action isn’t supported by this version of ${deps.productDisplayName ?? "Grok Bot"}` };
      return await withService(async (service) => (await service.getStatus()).kind === "logged-in" ? await deps.invokeDashboardAction(tokenReader(service), request) : { ok: false, message: "Sign in to Cursor to continue" });
    },
  };
}

export function createTranscriptionManagerEnsure(deps: {
  readonly ensureCursorAuthService: () => Promise<AuthServicePort>;
  readonly getMachineId: () => Promise<string>;
  readonly createClient?: NonNullable<SandTranscriptionOptions["createClient"]>;
}) {
  let transcriptionManager: SandTranscriptionManager | undefined;
  return async (): Promise<SandTranscriptionManager> => {
    if (transcriptionManager != null) return transcriptionManager;
    const authService = await deps.ensureCursorAuthService();
    transcriptionManager = new SandTranscriptionManager({
      getCursorAccessToken: (options) => authService.getValidAccessToken(options),
      getMachineId: deps.getMachineId,
      ...(deps.createClient == null ? {} : { createClient: deps.createClient }),
    });
    return transcriptionManager;
  };
}
