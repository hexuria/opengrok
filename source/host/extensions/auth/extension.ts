import { createRealRetryPolicy, realClock } from "../../../internal/scheduling.js";
import { defineHostExtension } from "../../../internal/host-extensions.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { createHostAuthService } from "./auth-service.js";
import { CREDENTIAL_RETRY_BASE_DELAY_MS, CREDENTIAL_RETRY_MAX_DELAY_MS } from "./credential-renewer.js";
import { createSandUserFullNameResolver } from "./user-full-name-service.js";

interface AuthHost { log(message: string): void; }
export const authExtension = defineHostExtension({
  id: HostExtensions.Auth, dependencies: [],
  start: (context) => {
    const host = context.host as AuthHost;
    const service = createHostAuthService({ retry: createRealRetryPolicy({ name: "sand-inference-credential-renewal", maxAttempts: Number.MAX_SAFE_INTEGER, initialDelayMs: CREDENTIAL_RETRY_BASE_DELAY_MS, maxDelayMs: CREDENTIAL_RETRY_MAX_DELAY_MS }), clock: realClock, log: (message) => host.log(message) });
    context.onStop(() => service.dispose());
    const userFullName = createSandUserFullNameResolver({
      getAccessToken: (options) => service.getAccessToken(options),
      peekAccessToken: () => service.peekAccessToken(),
      getMachineId: () => service.getMachineId(),
      log: (message) => host.log(message)
    });
    context.onStop(service.subscribeToRenewal((event) => { if (event.outcome === "renewed") void userFullName.refresh(); }));
    if (service.peekAccessToken() !== null) void userFullName.refresh();
    return {
      getAccessToken: (options: { readonly backendUrl?: string }) => service.getAccessToken(options),
      peekAccessToken: () => service.peekAccessToken(),
      getLastRenewalEvent: () => service.getLastRenewalEvent(),
      getMachineId: () => service.getMachineId(),
      subscribeToRenewal: (listener: Parameters<typeof service.subscribeToRenewal>[0]) => service.subscribeToRenewal(listener),
      getUserFullName: () => userFullName.getUserFullName()
    };
  }
});
