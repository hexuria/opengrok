import { defineHostExtension } from "../../../internal/host-extensions.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { createUaOwnerStampWriter } from "./ua-owner-stamp-service.js";
import { createUaTokenKillSwitchReconciler } from "./ua-token-kill-switch-service.js";

interface AuthApi {
  peekAccessToken(): string | null;
  subscribeToRenewal(listener: (event: { outcome: string }) => void): () => void;
}
interface ExperimentsApi {
  isUaTokenKillSwitchEnabled(): boolean;
  subscribe(listener: () => void): () => void;
}

export const browserUaExtension = defineHostExtension<{}, { log(message: string): void }>({
  id: HostExtensions.BrowserUa,
  dependencies: [HostExtensions.Auth, HostExtensions.Experiments],
  start: (context) => {
    const auth = context.deps[HostExtensions.Auth] as AuthApi;
    const experiments = context.deps[HostExtensions.Experiments] as ExperimentsApi;
    const stampUaOwner = createUaOwnerStampWriter({ log: (message) => context.host.log(message) });
    context.onStop(auth.subscribeToRenewal((event) => { if (event.outcome === "renewed") void stampUaOwner(auth.peekAccessToken()); }));
    if (auth.peekAccessToken() !== null) void stampUaOwner(auth.peekAccessToken());
    const reconcileKillSwitch = createUaTokenKillSwitchReconciler({ isKillSwitchEnabled: () => experiments.isUaTokenKillSwitchEnabled(), log: (message) => context.host.log(message) });
    context.onStop(experiments.subscribe(() => void reconcileKillSwitch()));
    void reconcileKillSwitch();
    return {};
  }
});

