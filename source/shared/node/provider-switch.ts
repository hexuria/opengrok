import { shouldLogoutCursorForProviderChange } from "../cursor-session-policy.js";
import type { SandInferenceProvider } from "../inference-router.js";
import { isSandInferenceProvider } from "../inference-router.js";
import { providerSwitchMustNotTouchComputer } from "../provider-computers.js";
import {
  logoutPreviousInferenceProvider,
  selectSubscriptionInferenceProvider,
  type SelectSubscriptionProviderResult,
  type SubscriptionCliAuthPort,
} from "./subscription-cli-auth.js";

export interface ProviderSwitchComputerGuard {
  readonly restartCoordinator: boolean;
  readonly recreateComputer: boolean;
  readonly markUnreachable: boolean;
  readonly recoverComputer: boolean;
}

export interface ApplyInferenceProviderSwitchInput {
  readonly requested: SandInferenceProvider;
  readonly current: SandInferenceProvider;
  readonly auth: SubscriptionCliAuthPort;
  readonly persist: (provider: SandInferenceProvider) => void;
  readonly logoutCursor?: () => Promise<unknown>;
}

export interface ApplyInferenceProviderSwitchResult {
  readonly ok: boolean;
  readonly provider: SandInferenceProvider;
  readonly persisted: boolean;
  readonly applied: boolean;
  readonly loginStarted: boolean;
  readonly previousLoggedOut: string;
  readonly previousSessionCleared: boolean;
  readonly computer: ProviderSwitchComputerGuard;
  readonly error?: string;
  readonly local: SelectSubscriptionProviderResult["local"];
}

export function createIdleProviderSwitchComputerGuard(): ProviderSwitchComputerGuard {
  return { ...providerSwitchMustNotTouchComputer() };
}

export async function applyInferenceProviderSwitch(
  input: ApplyInferenceProviderSwitchInput,
): Promise<ApplyInferenceProviderSwitchResult> {
  const computer = createIdleProviderSwitchComputerGuard();
  const current = isSandInferenceProvider(input.current) ? input.current : "cursor";
  const selected = await selectSubscriptionInferenceProvider({
    requested: input.requested,
    current,
    auth: input.auth,
  });
  if (!selected.ok) {
    return {
      ok: false,
      provider: selected.provider,
      persisted: false,
      applied: false,
      loginStarted: selected.loginStarted,
      previousLoggedOut: "none",
      previousSessionCleared: false,
      computer,
      ...(selected.error == null ? {} : { error: selected.error }),
      local: selected.local,
    };
  }
  input.persist(selected.provider);
  const logoutCursor = input.logoutCursor != null && shouldLogoutCursorForProviderChange("explicit-user-switch")
    ? input.logoutCursor
    : undefined;
  const logout = current === selected.provider
    ? { loggedOut: "none" as const, sessionCleared: false }
    : await logoutPreviousInferenceProvider({
      previous: current,
      next: selected.provider,
      auth: input.auth,
      ...(logoutCursor == null ? {} : { logoutCursor }),
    });
  return {
    ok: true,
    provider: selected.provider,
    persisted: true,
    applied: true,
    loginStarted: selected.loginStarted,
    previousLoggedOut: logout.loggedOut,
    previousSessionCleared: logout.sessionCleared,
    computer,
    local: selected.local,
  };
}
