import { PrivacyMode } from "../../shared/observability/sentry-privacy-mode.js";
import { DashboardService } from "../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import { createSandCursorBackendClient } from "../../shared/node/cursor-backend/cursor-inference.js";
import { getOrCreateMachineId } from "./cursor-machine-id.js";

export const PROFILE_REQUEST_TIMEOUT_MS = 10_000;
export const USAGE_REQUEST_TIMEOUT_MS = 15_000;
export const ANYSPHERE_TEAM_ID = 1;
export const NO_LIMIT_SENTINEL_CENTS = 2_147_483_647;
export const SAND_TRIAL_CLAIM_GRANTED = 3;
export const SUPPORTED_DASHBOARD_ACTIONS = new Set(["requestLimitIncrease"]);

export type AccessTokenReader = () => Promise<string>;
export interface TimestampLike { toDate(): Date }
export interface Team { readonly id: number; readonly hasBilling: boolean; readonly seats: number; readonly isEnterprise?: boolean }
export interface TeamsResponse { readonly teams: readonly Team[] }
export interface SpendLimitUsage { readonly individualUsed: number; readonly individualLimit?: number }
export interface CurrentPeriodUsage { readonly spendLimitUsage?: SpendLimitUsage; readonly billingCycleEnd?: number | string | bigint }
export interface DashboardButton {
  readonly label: string;
  readonly action: { readonly case: "url"; readonly value: { readonly url: string } } |
    { readonly case: "dashboardAction"; readonly value: { readonly action: string; readonly args: Readonly<Record<string, string>>; readonly successMessage?: string } } |
    { readonly case: string; readonly value: unknown };
}
export interface SandUsageStatus {
  readonly usesPooledEnterpriseAllowance?: boolean;
  readonly usagePercent?: number;
  readonly nextResetTimestampUtc?: TimestampLike;
  readonly hasNonZeroIncludedLimit?: boolean;
  readonly hasAvailableUsage?: boolean;
  readonly sandTrialExpiresAt?: TimestampLike;
  readonly sandTrialCancelable?: boolean;
  readonly upgradeRecommendation?: { readonly disabled: boolean; readonly cta?: DashboardButton };
}
export interface WeeklyUsage { readonly percentUsed: number; readonly nextResetMs: number | null; readonly hasNonZeroIncludedLimit: boolean; readonly onDemand: { readonly usedCents: number; readonly limitCents: number } | null }
export interface CursorProfile { readonly displayName: string | undefined; readonly email: string | undefined; readonly profilePictureUrl: string | undefined; readonly isAnysphereUser: boolean }
export interface DashboardClient {
  getMe(request: object, options: { timeoutMs: number }): Promise<{ firstName?: string; lastName?: string; email?: string; profilePictureUrl?: string }>;
  getTeams(request: object, options: { timeoutMs: number }): Promise<TeamsResponse>;
  updateUserName(request: { firstName: string; lastName: string }, options: { timeoutMs: number }): Promise<unknown>;
  getUserPrivacyMode(request: object, options: { timeoutMs: number }): Promise<{ privacyMode?: PrivacyMode }>;
  getSandUsageStatus(request: object, options: { timeoutMs: number }): Promise<SandUsageStatus>;
  getCurrentPeriodUsage(request: object, options: { timeoutMs: number }): Promise<CurrentPeriodUsage>;
  getTeamAdminSettingsOrEmptyIfNotInTeam(request: object, options: { timeoutMs: number }): Promise<{ localToolControls?: { permissionCeiling?: number } }>;
  getSandTrialClaimStatus(request: object, options: { timeoutMs: number }): Promise<{ status: number }>;
  cancelSandTrial(request: object, options: { timeoutMs: number }): Promise<unknown>;
  clientAction(request: { action: string; args: Readonly<Record<string, string>> }, options: { timeoutMs: number }): Promise<{ success: boolean; infoMessage?: string; errorMessage?: string }>;
}
export interface CursorProfileDeps {
  readonly createClient?: (getAccessToken: AccessTokenReader) => DashboardClient;
  readonly getMachineId?: () => Promise<string>;
  readonly reportFailure?: (area: string, leg: string, error: unknown) => void;
  readonly isInvalidArgumentError?: (error: unknown) => boolean;
  readonly connectRawMessage?: (error: unknown) => string | undefined;
  readonly localToolPermissionCeilings?: { readonly never: number; readonly ask: number; readonly always: number };
  readonly now?: () => number;
}

function profileClient(getAccessToken: AccessTokenReader, deps: CursorProfileDeps): DashboardClient {
  if (deps.createClient != null) return deps.createClient(getAccessToken);
  return createSandCursorBackendClient(DashboardService, {
    getAccessToken,
    getMachineId: deps.getMachineId ?? getOrCreateMachineId,
  }) as unknown as DashboardClient;
}

function nonEmpty(value: string | undefined): string | undefined { const trimmed = value?.trim(); return trimmed != null && trimmed.length > 0 ? trimmed : undefined; }
export function displayNameFromProfile(firstName?: string, lastName?: string): string { return [firstName?.trim(), lastName?.trim()].filter((part): part is string => part != null && part.length > 0).join(" "); }
export function splitAccountName(name: string): { firstName: string; lastName: string } { const parts = name.split(/\s+/).filter(Boolean); return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") }; }
export function privacyModeEnabledForMode(mode: PrivacyMode | undefined): boolean { return mode !== PrivacyMode.USAGE_DATA_TRAINING_ALLOWED && mode !== PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED; }
export function isLiveSandTrial(expiresAt: TimestampLike | null | undefined, nowMs: number): boolean { if (expiresAt == null) return false; const expiresMs = expiresAt.toDate().getTime(); return Number.isFinite(expiresMs) && expiresMs > nowMs; }
export function normalizedLimitCents(value: number | undefined): number | null { return value === undefined || !Number.isFinite(value) || value <= 0 || value >= NO_LIMIT_SENTINEL_CENTS ? null : value; }

function toOnDemandSpend(response: CurrentPeriodUsage | null | undefined): { usedCents: number; limitCents: number } | null {
  const usage = response?.spendLimitUsage; const limitCents = normalizedLimitCents(usage?.individualLimit);
  return usage == null || limitCents == null ? null : { usedCents: usage.individualUsed, limitCents };
}
function onDemandOf(response: CurrentPeriodUsage | undefined): { usedCents: number; limitCents: number | null; resetTimestampMs: number | null } | null {
  const usage = response?.spendLimitUsage; if (response === undefined || usage === undefined) return null;
  const end = Number(response.billingCycleEnd);
  return { usedCents: Number.isFinite(usage.individualUsed) ? usage.individualUsed : 0, limitCents: normalizedLimitCents(usage.individualLimit), resetTimestampMs: Number.isFinite(end) && end > 0 ? end : null };
}
export function toWeeklyUsage(status: SandUsageStatus, currentPeriodUsage: CurrentPeriodUsage | null, _nowMs: number): WeeklyUsage | null {
  if (status.usesPooledEnterpriseAllowance || status.usagePercent == null || !Number.isFinite(status.usagePercent)) return null;
  const reset = status.nextResetTimestampUtc?.toDate().getTime(); const included = status.hasNonZeroIncludedLimit === true;
  return { percentUsed: Math.max(status.usagePercent, 0), nextResetMs: reset != null && Number.isFinite(reset) && reset > 0 ? reset : null, hasNonZeroIncludedLimit: included, onDemand: included ? toOnDemandSpend(currentPeriodUsage) : null };
}

function isHttpExternalUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; } }
export function upgradeCtaOf(recommendation: SandUsageStatus["upgradeRecommendation"]): unknown | null {
  const button = recommendation?.cta; if (button == null || button.label === "") return null;
  const disabled = recommendation?.disabled === true;
  if (button.action.case === "url") {
    const value = button.action.value as { url: string }; if (!isHttpExternalUrl(value.url)) return null;
    return { label: button.label, disabled, action: { kind: "open-url", url: value.url } };
  }
  if (button.action.case === "dashboardAction") {
    const value = button.action.value as { action: string; args: Readonly<Record<string, string>>; successMessage?: string };
    if (!SUPPORTED_DASHBOARD_ACTIONS.has(value.action)) return null;
    return { label: button.label, disabled, action: { kind: "dashboard-action", action: value.action, args: { ...value.args }, successMessage: nonEmpty(value.successMessage) ?? null } };
  }
  return null;
}

export function buildSandUsageSummary(args: { readonly sandStatus: SandUsageStatus; readonly currentPeriodUsage?: CurrentPeriodUsage; readonly teams: TeamsResponse; readonly nowMs: number; readonly trialClaimGranted: boolean }): unknown {
  const { sandStatus } = args; const reset = sandStatus.nextResetTimestampUtc?.toDate().getTime(); const trial = isLiveSandTrial(sandStatus.sandTrialExpiresAt, args.nowMs); const included = sandStatus.hasNonZeroIncludedLimit === true;
  return { isEnterprise: args.teams.teams.some((team) => team.isEnterprise === true), sandUsagePercent: sandStatus.usagePercent !== undefined && Number.isFinite(sandStatus.usagePercent) && sandStatus.usagePercent >= 0 ? sandStatus.usagePercent : null, sandUsageResetTimestampMs: reset !== undefined && Number.isFinite(reset) && reset > 0 ? reset : null, hasAvailableUsage: sandStatus.hasAvailableUsage === true, isSandTrial: trial, hasEndedSandTrial: args.trialClaimGranted && !trial, hasNonZeroIncludedLimit: included, canCancelSandTrial: trial && sandStatus.sandTrialCancelable === true, onDemand: included ? onDemandOf(args.currentPeriodUsage) : null, upgradeCta: upgradeCtaOf(sandStatus.upgradeRecommendation) };
}

export async function fetchCursorProfile(getAccessToken: AccessTokenReader, deps: CursorProfileDeps): Promise<CursorProfile | null> {
  try {
    const client = profileClient(getAccessToken, deps);
    const [me, isAnysphereUser] = await Promise.all([client.getMe({}, { timeoutMs: PROFILE_REQUEST_TIMEOUT_MS }), client.getTeams({}, { timeoutMs: PROFILE_REQUEST_TIMEOUT_MS }).then((r) => r.teams.some((team) => team.id === ANYSPHERE_TEAM_ID && team.hasBilling && team.seats > 0)).catch((error: unknown) => { deps.reportFailure?.("cursor-profile", "teams-membership", error); return false; })]);
    return { displayName: nonEmpty(displayNameFromProfile(me.firstName, me.lastName)), email: nonEmpty(me.email), profilePictureUrl: nonEmpty(me.profilePictureUrl), isAnysphereUser };
  } catch { return null; }
}
export async function updateCursorProfileName(getAccessToken: AccessTokenReader, name: string, deps: CursorProfileDeps): Promise<void> { await profileClient(getAccessToken, deps).updateUserName(splitAccountName(name), { timeoutMs: PROFILE_REQUEST_TIMEOUT_MS }); }
export async function fetchUserPrivacyMode(getAccessToken: AccessTokenReader, deps: CursorProfileDeps): Promise<PrivacyMode | undefined> { try { return (await profileClient(getAccessToken, deps).getUserPrivacyMode({}, { timeoutMs: PROFILE_REQUEST_TIMEOUT_MS })).privacyMode; } catch { return undefined; } }
export async function fetchUserPrivacyModeEnabled(getAccessToken: AccessTokenReader, deps: CursorProfileDeps): Promise<boolean> { return privacyModeEnabledForMode(await fetchUserPrivacyMode(getAccessToken, deps)); }
export async function fetchSandWeeklyUsage(getAccessToken: AccessTokenReader, deps: CursorProfileDeps): Promise<WeeklyUsage | null> { try { const client = profileClient(getAccessToken, deps); const [status, usage] = await Promise.allSettled([client.getSandUsageStatus({}, { timeoutMs: PROFILE_REQUEST_TIMEOUT_MS }), client.getCurrentPeriodUsage({}, { timeoutMs: PROFILE_REQUEST_TIMEOUT_MS })]); return status.status === "fulfilled" ? toWeeklyUsage(status.value, usage.status === "fulfilled" ? usage.value : null, (deps.now ?? Date.now)()) : null; } catch { return null; } }
export async function fetchLocalToolPermissionCeiling(getAccessToken: AccessTokenReader, deps: CursorProfileDeps): Promise<"never" | "ask" | "always" | undefined> { try { const value = (await profileClient(getAccessToken, deps).getTeamAdminSettingsOrEmptyIfNotInTeam({}, { timeoutMs: PROFILE_REQUEST_TIMEOUT_MS })).localToolControls?.permissionCeiling; const c = deps.localToolPermissionCeilings ?? { never: 1, ask: 2, always: 3 }; return value === c.never ? "never" : value === c.ask ? "ask" : value === c.always ? "always" : undefined; } catch { return undefined; } }
export async function fetchSandUsageSummary(getAccessToken: AccessTokenReader, deps: CursorProfileDeps): Promise<unknown> { const client = profileClient(getAccessToken, deps); const [sandStatus, currentPeriodUsage, teams, trial] = await Promise.all([client.getSandUsageStatus({}, { timeoutMs: USAGE_REQUEST_TIMEOUT_MS }), client.getCurrentPeriodUsage({}, { timeoutMs: USAGE_REQUEST_TIMEOUT_MS }).catch((error: unknown) => { if (deps.isInvalidArgumentError?.(error) === true) return undefined; throw error; }), client.getTeams({}, { timeoutMs: USAGE_REQUEST_TIMEOUT_MS }), client.getSandTrialClaimStatus({}, { timeoutMs: USAGE_REQUEST_TIMEOUT_MS })]); return buildSandUsageSummary({ sandStatus, ...(currentPeriodUsage === undefined ? {} : { currentPeriodUsage }), teams, nowMs: (deps.now ?? Date.now)(), trialClaimGranted: trial.status === SAND_TRIAL_CLAIM_GRANTED }); }
export async function cancelSandTrial(getAccessToken: AccessTokenReader, deps: CursorProfileDeps): Promise<{ ok: boolean; message: string | null }> { try { await profileClient(getAccessToken, deps).cancelSandTrial({}, { timeoutMs: USAGE_REQUEST_TIMEOUT_MS }); return { ok: true, message: null }; } catch (error) { return { ok: false, message: nonEmpty(deps.connectRawMessage?.(error)) ?? null }; } }
export async function invokeSandDashboardAction(getAccessToken: AccessTokenReader, request: { readonly action: string; readonly args: Readonly<Record<string, string>> }, deps: CursorProfileDeps): Promise<{ ok: boolean; message: string | null }> { const response = await profileClient(getAccessToken, deps).clientAction(request, { timeoutMs: USAGE_REQUEST_TIMEOUT_MS }); return { ok: response.success, message: nonEmpty(response.success ? response.infoMessage : response.errorMessage) ?? null }; }
