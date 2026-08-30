import { ErrorDetails } from "../../../packages/proto/generated/aiserver/v1/utils_pb.js";

export const PROVIDER_OVERLOAD_ERROR_TITLE = "Model provider is overloaded";
export const PROVIDER_OVERLOAD_ERROR_DETAIL =
  "The model provider is under heavy load right now. This is usually temporary — retry, or switch to another model.";
export const SAND_INCLUDED_LIMIT_REASON = "sand_included_limit";
export const RESETS_AT_ABS_OR_ISO = /It resets at \S+\.?/g;
export const RESETS_IN_CLAUSE = /It resets in [^.]+/g;
export const MAX_TRAY_ACTIONS = 3;
export const CURSOR_WEBSITE_ORIGIN = "https://cursor.com";
export const SUPPORTED_DASHBOARD_ACTION_VERBS = new Set([
  "requestLimitIncrease",
]);
export interface BackendDetail {
  title?: string;
  detail?: string;
  buttons?: ErrorButton[];
  additionalInfo?: { rateLimitReason?: string; nextResetAt?: string };
}
export interface BackendConnectError extends Error {
  findDetails(type?: unknown): Array<{ details?: BackendDetail }>;
  code?: number;
}
function isConnectError(value: unknown): value is BackendConnectError {
  return (
    value instanceof Error &&
    typeof (value as Partial<BackendConnectError>).findDetails === "function"
  );
}
function connectErrorDetails(error: BackendConnectError): Array<{ details?: BackendDetail }> {
  try {
    return error.findDetails(ErrorDetails);
  } catch {
    try {
      return error.findDetails();
    } catch {
      return [];
    }
  }
}
export function walkForBackendConnectError(
  error: unknown,
  seen: Set<object>,
  first: { value: BackendConnectError | null },
): BackendConnectError | null {
  if (error == null || typeof error !== "object" || seen.has(error))
    return null;
  seen.add(error);
  if (isConnectError(error)) {
    if (connectErrorDetails(error).length > 0) return error;
    first.value ??= error;
  }
  const cause = (error as { cause?: unknown }).cause,
    fromCause = walkForBackendConnectError(cause, seen, first);
  if (fromCause != null) return fromCause;
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors))
    for (const inner of errors) {
      const found = walkForBackendConnectError(inner, seen, first);
      if (found != null) return found;
    }
  return null;
}
export function findBackendConnectError(
  error: unknown,
  requireDetails = true,
): BackendConnectError | null {
  const first = { value: null as BackendConnectError | null },
    detailed = walkForBackendConnectError(error, new Set(), first);
  return detailed ?? (requireDetails ? null : first.value);
}
export function getBackendErrorDetailMessage(error: unknown): string | null {
  const connectError = findBackendConnectError(error);
  const detail = connectError == null ? undefined : connectErrorDetails(connectError)[0]?.details,
    title = detail?.title?.trim(),
    message = detail?.detail?.trim();
  return !title
    ? (message ?? null)
    : !message || message === title
      ? title
      : `${title}\n\n${message}`;
}
export function formatAgentRunError(error: Error): string {
  return getBackendErrorDetailMessage(error) ?? error.message;
}
export function formatSandUsageResetIn(
  nextResetAt: string | Date,
  nowMs = Date.now(),
): string | null {
  const resetMs =
    typeof nextResetAt === "string"
      ? Date.parse(nextResetAt)
      : nextResetAt.getTime();
  if (!Number.isFinite(resetMs)) return null;
  const ms = resetMs - nowMs;
  if (ms <= 0) return "less than a minute";
  if (ms >= 86_400_000) {
    const days = Math.ceil(ms / 86_400_000);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (ms >= 3_600_000) {
    const hours = Math.ceil(ms / 3_600_000);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
export function withRelativeSandIncludedLimitReset(
  detail: string,
  nextResetAt: string | null | undefined,
  nowMs = Date.now(),
): string {
  if (!nextResetAt) return detail;
  const relative = formatSandUsageResetIn(nextResetAt, nowMs);
  return relative == null
    ? detail
    : detail
        .replace(RESETS_AT_ABS_OR_ISO, `It resets in ${relative}.`)
        .replace(RESETS_IN_CLAUSE, `It resets in ${relative}`);
}
export type ErrorButton = {
  label: string;
  action: { case: string; value: any };
};
export function checkoutDeepControlUrl(action: {
  membershipToUpgradeTo?: string;
  allowTrial?: boolean;
}): string {
  const tier = ["pro", "pro_plus", "ultra"].includes(
    action.membershipToUpgradeTo ?? "",
  )
    ? action.membershipToUpgradeTo
    : "pro";
  let url = `${CURSOR_WEBSITE_ORIGIN}/api/auth/checkoutDeepControl?tier=${tier}`;
  if (action.allowTrial === true) url += "&allowTrial=true";
  else if (action.allowTrial === false) url += "&allowTrial=false";
  return url;
}
export function mapErrorDetailButtons(
  buttons: readonly ErrorButton[] | null | undefined,
): Array<Record<string, unknown>> {
  const actions: Array<Record<string, unknown>> = [];
  let hasSwitch = false;
  for (const button of buttons ?? []) {
    if (actions.length >= MAX_TRAY_ACTIONS) break;
    const value = button.action.value ?? {};
    switch (button.action.case) {
      case "url":
        try {
          const url = new URL(value.url);
          if (["http:", "https:"].includes(url.protocol) && button.label)
            actions.push({
              kind: "open-url",
              label: button.label,
              url: value.url,
            });
        } catch {}
        break;
      case "upgrade":
        actions.push({
          kind: "open-url",
          label: button.label || "Upgrade",
          url: checkoutDeepControlUrl(value),
        });
        break;
      case "upgradeChoice":
        actions.push({
          kind: "open-url",
          label: button.label || "Upgrade",
          url: `${CURSOR_WEBSITE_ORIGIN}/pricing`,
        });
        break;
      case "switchModel":
        if (!hasSwitch) {
          hasSwitch = true;
          actions.push({ kind: "switch-model" });
        }
        break;
      case "dashboardAction":
        if (SUPPORTED_DASHBOARD_ACTION_VERBS.has(value.action) && button.label)
          actions.push({
            kind: "dashboard-action",
            label: button.label,
            action: value.action,
            args: { ...value.args },
            successMessage: value.successMessage || null,
          });
    }
  }
  return actions;
}
export function describeAgentRunError(error: unknown): Record<string, unknown> {
  const formatted =
      error instanceof Error ? formatAgentRunError(error) : String(error),
    connectError = findBackendConnectError(error),
    detail = connectError == null ? undefined : connectErrorDetails(connectError)[0]?.details,
    title = detail?.title?.trim() ?? "",
    actions = mapErrorDetailButtons(detail?.buttons);
  let shown = title ? (detail?.detail?.trim() ?? "") : formatted;
  if (detail?.additionalInfo?.rateLimitReason === SAND_INCLUDED_LIMIT_REASON)
    shown = withRelativeSandIncludedLimitReset(
      shown || formatted,
      detail.additionalInfo.nextResetAt,
    );
  else if (!shown) shown = formatted;
  return {
    ...(title ? { title } : {}),
    detail: shown,
    ...(actions.length ? { actions } : {}),
  };
}
