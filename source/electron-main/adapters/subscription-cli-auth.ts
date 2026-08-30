import { createSubscriptionCliAuthWiring, type SubscriptionCliAuthPort } from "../account/subscription-cli-auth-wiring.js";
import { requireFunction, requireObject } from "./provider-guards.js";

export interface ProductionSubscriptionCliAuthPorts {
  readonly resolvePort?: () => SubscriptionCliAuthPort;
}

function validatePort(port: SubscriptionCliAuthPort): SubscriptionCliAuthPort {
  requireObject(port, "subscriptionCliAuth.port");
  requireFunction(port.getStatus, "subscriptionCliAuth.port.getStatus");
  requireFunction(port.startLogin, "subscriptionCliAuth.port.startLogin");
  return port;
}

/** Production subscription login port for Claude Pro/Max and Codex/ChatGPT CLI auth. */
export function createProductionSubscriptionCliAuthAdapter(
  ports: ProductionSubscriptionCliAuthPorts = {},
): { create(): SubscriptionCliAuthPort } {
  return {
    create() {
      return validatePort(ports.resolvePort?.() ?? createSubscriptionCliAuthWiring().port);
    },
  };
}

export function createElectronProductionSubscriptionCliAuthBinding(): SubscriptionCliAuthPort {
  return createProductionSubscriptionCliAuthAdapter({}).create();
}
