import {
  createRemoteHostConnector,
  type BrokerDeps,
} from "../box/box-host-connector.js";
import { createDesktopGatewayDescriptorFastPath } from "../box/gateway-descriptor-store.js";
import type {
  ProductionCoordinatorAuthStatus,
  ProductionCoordinatorGatewayConnector,
  ProductionCoordinatorPorts,
} from "../coordinator/production-provider.js";
import type { ProductionServiceContext } from "../main-production-services.js";
import type { BoxConnectionInfo } from "../../shared/node/egress-tunnel/box-connection.js";
import { createSettingsRoutedHostConnector } from "../box/local-docker-host-connector.js";
import { OPENGROK_GATEWAY_TOKEN_SECRET } from "../../shared/box-runtime.js";
import { readSecret } from "../secrets/secret-store.js";

function requireFunction(value: unknown, label: string): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") {
    throw new Error(`Electron production coordinator gateway requires ${label}.`);
  }
}

/**
 * Exact root handoff for the coordinator's generated GrokBot gateway client.
 * The connector remains account-scoped and process-owned; coordinator account
 * authorization/transition ports are intentionally supplied by the separate
 * coordinator binding and are not inferred here.
 */
export function createProductionCoordinatorGatewayBinding(): Pick<
  ProductionCoordinatorPorts<ProductionCoordinatorAuthStatus>,
  "createGatewayConnector"
> {
  return {
    createGatewayConnector(context: ProductionServiceContext): ProductionCoordinatorGatewayConnector {
      requireFunction(context?.requireAccount, "authenticated account service");
      requireFunction(context?.requireUpdate, "update-service lifecycle");
      requireFunction(context?.accountLifecycle?.getAccountScope, "account-scope reader");
      const account = context.requireAccount();
      requireFunction(account?.getAuthService, "authenticated account token service");

      const deps: BrokerDeps = {
        getAccessToken: async ({ backendUrl }) =>
          (await account.getAuthService()).getValidAccessToken({ backendUrl }),
        getMachineId: () => context.machineId,
      };
      const descriptorFastPath = createDesktopGatewayDescriptorFastPath({
        app: context.native.app,
        safeStorage: context.native.safeStorage,
        getAccountScope: () => context.accountLifecycle.getAccountScope() ?? undefined,
      });
      const remote = createSettingsRoutedHostConnector(createRemoteHostConnector(
        deps,
        context.env,
        context.requireUpdate(),
        descriptorFastPath,
      ), context.settings.settingsStore, async () => await readSecret(OPENGROK_GATEWAY_TOKEN_SECRET)) as unknown as {
        connect(): unknown | Promise<unknown>;
        recreate?: (...args: any[]) => unknown;
        forceRecreate?: (...args: any[]) => unknown;
        issueLocalExecDaemonCredential?: (...args: any[]) => unknown;
      };
      requireFunction(remote?.connect, "generated gateway connector.connect()");
      requireFunction(
        remote?.issueLocalExecDaemonCredential,
        "generated local-exec credential issuer",
      );
      const wrappedBase: {
        connect(): Promise<BoxConnectionInfo>;
        issueLocalExecDaemonCredential(...args: any[]): unknown;
        recreate?: (...args: any[]) => unknown;
        forceRecreate?: (...args: any[]) => unknown;
      } = {
        connect: async () => await remote.connect() as BoxConnectionInfo,
        issueLocalExecDaemonCredential: remote.issueLocalExecDaemonCredential.bind(remote),
      };
      if (remote.recreate != null) wrappedBase.recreate = remote.recreate.bind(remote);
      if (remote.forceRecreate != null) wrappedBase.forceRecreate = remote.forceRecreate.bind(remote);
      return context.connectorEgress.wrap(wrappedBase) as unknown as ProductionCoordinatorGatewayConnector;
    },
  };
}
