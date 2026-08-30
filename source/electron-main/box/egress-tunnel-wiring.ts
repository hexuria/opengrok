import {
  boxConnectionToEgressConfig,
  type BoxConnectionInfo,
} from "../../shared/node/egress-tunnel/box-connection.js";
import {
  EgressTunnelController,
  type EgressTunnelClient,
  type EgressTunnelStatus,
} from "../../shared/node/egress-tunnel/egress-tunnel-controller.js";
import { EgressTunnelExitClient } from "../../shared/node/egress-tunnel/exit-client.js";
import {
  createWebSocket,
  EGRESS_TUNNEL_OPEN_READY_STATE,
} from "../../shared/node/egress-tunnel/websocket-client.js";

export function createProductionEgressTunnelClient(options: {
  readonly config: ConstructorParameters<typeof EgressTunnelExitClient>[0]["config"];
  readonly onStatus: ConstructorParameters<typeof EgressTunnelExitClient>[0]["onStatus"];
  readonly log: (...values: unknown[]) => void;
}): EgressTunnelClient {
  return new EgressTunnelExitClient({
    config: options.config,
    onStatus: options.onStatus,
    log: (...values) => options.log(...values),
    createWebSocket,
    openReadyState: EGRESS_TUNNEL_OPEN_READY_STATE,
  });
}

/* The production default is the artifact's direct ws constructor. */
export function createEgressTunnelWiring(deps: {
  readonly broadcastStatus: (status: EgressTunnelStatus) => void;
  readonly observer: { attach(listener: (info: BoxConnectionInfo | null) => void): void };
  readonly isEnabled: () => boolean;
  readonly createClient?: ConstructorParameters<typeof EgressTunnelController>[0]["createClient"];
  readonly log?: (...values: unknown[]) => void;
  readonly env?: NodeJS.ProcessEnv;
}): EgressTunnelController {
  const createClient = deps.createClient ?? createProductionEgressTunnelClient;
  const options: ConstructorParameters<typeof EgressTunnelController>[0] = {
    onStatus: (status) => deps.broadcastStatus(status),
    createClient,
    ...(deps.log === undefined ? {} : { log: deps.log }),
    ...(deps.env === undefined ? {} : { env: deps.env }),
  };
  const controller = new EgressTunnelController(options);
  deps.observer.attach((info) => controller.setBoxConnection(info != null ? boxConnectionToEgressConfig(info) : null));
  controller.setEnabled(deps.isEnabled());
  return controller;
}

export type { EgressTunnelClient };
