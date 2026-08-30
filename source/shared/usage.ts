/**
 * Cross-process usage and billing value contracts.
 *
 * The 0.18 electron-main artifact retains one runtime value from this module:
 * the dashboard-action allowlist below. The rest of the original module's
 * structural contracts were erased by TypeScript and are recovered from the
 * account projection and renderer intake checks that consume them.
 */

export type SupportedDashboardAction = "requestLimitIncrease";

/** Exact runtime state retained at `dist/electron-main/main.cjs:387117-387122`. */
export const SUPPORTED_DASHBOARD_ACTIONS = new Set<SupportedDashboardAction>([
  "requestLimitIncrease",
]);

export interface DashboardActionRequest {
  readonly action: SupportedDashboardAction;
  readonly args: Readonly<Record<string, string>>;
}

export interface UsageActionResult {
  readonly ok: boolean;
  readonly message: string | null;
}

export interface SandWeeklyOnDemandUsage {
  readonly usedCents: number;
  readonly limitCents: number;
}

/** Shape projected by `toWeeklyUsage` and admitted by the renderer intake. */
export interface SandWeeklyUsage {
  readonly percentUsed: number;
  readonly nextResetMs: number | null;
  readonly hasNonZeroIncludedLimit: boolean;
  readonly onDemand: SandWeeklyOnDemandUsage | null;
}

export interface SandUsageOnDemand {
  readonly usedCents: number;
  readonly limitCents: number | null;
  readonly resetTimestampMs: number | null;
}

export interface SandUsageOpenUrlAction {
  readonly kind: "open-url";
  readonly url: string;
}

export interface SandUsageDashboardAction {
  readonly kind: "dashboard-action";
  readonly action: SupportedDashboardAction;
  readonly args: Readonly<Record<string, string>>;
  readonly successMessage: string | null;
}

export type SandUsageUpgradeAction =
  | SandUsageOpenUrlAction
  | SandUsageDashboardAction;

export interface SandUsageUpgradeCta {
  readonly label: string;
  readonly disabled: boolean;
  readonly action: SandUsageUpgradeAction;
}

/** Exact value assembled by `electron-main/account/cursor-profile.ts`. */
export interface SandUsageSummary {
  readonly isEnterprise: boolean;
  readonly sandUsagePercent: number | null;
  readonly sandUsageResetTimestampMs: number | null;
  readonly hasAvailableUsage: boolean;
  readonly isSandTrial: boolean;
  readonly hasEndedSandTrial: boolean;
  readonly hasNonZeroIncludedLimit: boolean;
  readonly canCancelSandTrial: boolean;
  readonly onDemand: SandUsageOnDemand | null;
  readonly upgradeCta: SandUsageUpgradeCta | null;
}
