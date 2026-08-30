import {
  createSubscriptionCliAuthPort,
  type SubscriptionCliAuthPort,
} from "../../shared/node/subscription-cli-auth.js";

export type { SubscriptionCliAuthPort } from "../../shared/node/subscription-cli-auth.js";

export function createSubscriptionCliAuthWiring(
  deps?: Parameters<typeof createSubscriptionCliAuthPort>[0],
): {
  readonly port: SubscriptionCliAuthPort;
  dispose(): void;
} {
  const port = createSubscriptionCliAuthPort(deps ?? {});
  return {
    port,
    dispose() {},
  };
}
