import type { Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { computerUseExecutorResource } from "../../packages/agent-exec/computer-use.js";
import {
  CombinedResourceAccessor,
  RemoteResourceAccessor,
  resourceEntry,
  type ResourceAccessor
} from "../../packages/agent-exec/resource-provider.js";
import { readExecutorResource } from "../../packages/agent-exec/read.js";
import type { RemoteExecManager } from "../../packages/agent-exec/remote.js";
import type { Context } from "../../packages/context/core.js";
import { createContextPropagatingClient } from "../../packages/context-rpc/index.js";
import {
  LoadMcpServersRequest,
  PingRequest,
  UpdateEnvironmentVariablesRequest
} from "../../packages/proto/generated/agent/v1/control_service_pb.js";
import { ControlService } from "../../packages/proto/generated/agent/v1/control_service_connect.js";
import { ExecService } from "../../packages/proto/generated/agent/v1/exec_service_connect.js";
import {
  noMonitorComputerUseExecutor
} from "../ports/box.js";
import type {
  BoxEnvironmentControlClient
} from "./box-env.js";
import type { FileTransferAccessor } from "./box-file-transfer.js";
import type { BoxMcpControlClient } from "./box-mcp.js";
import type {
  BoxPingControlClient,
  BoxRemoteExecClient,
  BoxRemoteExecManager,
  BoxTransportFactory
} from "./box-remote-accessor.js";
import type {
  ProductionBoxControlClient,
  ProductionBoxGeneratedPorts
} from "./production.js";
import type { ShellAccessor } from "./box-windows.js";

/**
 * Exact package versions visible in the immutable 0.18 host bundle markers.
 * The package implementations are imported below; this module does not
 * substitute a home-grown HTTP or protobuf runtime for them.
 */
export const BOX_GENERATED_PACKAGE_VERSIONS: Readonly<{
  protobuf: "1.10.1";
  connect: "1.6.1";
  connectNode: "1.6.1";
  connectStoreMarker: "@connectrpc+connect@1.6.1_patch_hash=c9c7616ccfc0246b19c6537f56676d8501713cb6c94b440d13_ef7275568c8b1f1f499006dc986c70d2";
  connectNodeStoreMarker: "@connectrpc+connect-node@1.6.1_@bufbuild+protobuf@1.10.1_@connectrpc+connect@1.6.1_patc_c333e1fd2007e07028093d0fe22e3f55";
}> = Object.freeze({
  protobuf: "1.10.1",
  connect: "1.6.1",
  connectNode: "1.6.1",
  connectStoreMarker: "@connectrpc+connect@1.6.1_patch_hash=c9c7616ccfc0246b19c6537f56676d8501713cb6c94b440d13_ef7275568c8b1f1f499006dc986c70d2",
  connectNodeStoreMarker: "@connectrpc+connect-node@1.6.1_@bufbuild+protobuf@1.10.1_@connectrpc+connect@1.6.1_patc_c333e1fd2007e07028093d0fe22e3f55"
});

export interface GeneratedMessageConstructor<Input, Message> {
  new(data?: Input): Message;
  readonly typeName: string;
  readonly fields: unknown;
}

export interface GeneratedServiceDescriptor<TypeName extends string> {
  readonly typeName: TypeName;
  readonly methods: Readonly<Record<string, unknown>>;
}

export interface GeneratedControlClient<
  PingRequest,
  UpdateEnvironmentVariablesRequest,
  LoadMcpServersRequest
> {
  ping(
    ctx: Context,
    request: PingRequest,
    options: { readonly timeoutMs: number }
  ): Promise<unknown>;
  updateEnvironmentVariables(
    ctx: Context,
    request: UpdateEnvironmentVariablesRequest
  ): Promise<unknown>;
  loadMcpServers(
    ctx: Context,
    request: LoadMcpServersRequest
  ): Promise<{ readonly loadedServerNames: string[] }>;
}

export interface GeneratedContextPropagatingClientFactory<
  Transport,
  PingRequest,
  UpdateEnvironmentVariablesRequest,
  LoadMcpServersRequest
> {
  (
    service: GeneratedServiceDescriptor<"agent.v1.ControlService">,
    transport: Transport
  ): GeneratedControlClient<
    PingRequest,
    UpdateEnvironmentVariablesRequest,
    LoadMcpServersRequest
  >;
  (
    service: GeneratedServiceDescriptor<"agent.v1.ExecService">,
    transport: Transport
  ): BoxRemoteExecClient;
}

export interface ProductionBoxGeneratedPackageBindings<
  Transport,
  PingRequest,
  UpdateEnvironmentVariablesRequest,
  LoadMcpServersRequest
> {
  readonly createConnectTransport: BoxTransportFactory<Transport>;
  readonly createContextPropagatingClient: GeneratedContextPropagatingClientFactory<
    Transport,
    PingRequest,
    UpdateEnvironmentVariablesRequest,
    LoadMcpServersRequest
  >;
  readonly controlService: GeneratedServiceDescriptor<"agent.v1.ControlService">;
  readonly execService: GeneratedServiceDescriptor<"agent.v1.ExecService">;
  readonly PingRequest: GeneratedMessageConstructor<
    Readonly<Record<string, never>>,
    PingRequest
  >;
  readonly UpdateEnvironmentVariablesRequest: GeneratedMessageConstructor<
    {
      readonly env: Readonly<Record<string, string>>;
      readonly replace: boolean;
    },
    UpdateEnvironmentVariablesRequest
  >;
  readonly LoadMcpServersRequest: GeneratedMessageConstructor<
    {
      readonly mcpConfigJson: string;
      readonly removeMissing: true;
    },
    LoadMcpServersRequest
  >;
}

export type ProductionGeneratedBoxAccessor =
  & ResourceAccessor<RemoteExecManager>
  & ShellAccessor
  & FileTransferAccessor;

/**
 * Constructs only the six erased generated/package ports used by the shipped
 * Box graph. The internal generated service descriptors and the exact
 * Connect/Buf runtime are supplied by the exact package imports below.
 *
 * Artifact anchors:
 * - host-main.cjs:614162-614180, 614379-614436 (client factory + Control RPCs)
 * - host-main.cjs:614663-614725 (Exec service/client/resource accessor)
 * - host-main.cjs:614929-614938 (protected read overlay)
 * - host-main.cjs:615411-615416 (no-monitor computer-use overlay)
 */
export function createProductionBoxGeneratedPorts<
  Transport,
  PingRequest,
  UpdateEnvironmentVariablesRequest,
  LoadMcpServersRequest
>(
  bindings: ProductionBoxGeneratedPackageBindings<
    Transport,
    PingRequest,
    UpdateEnvironmentVariablesRequest,
    LoadMcpServersRequest
  >
): ProductionBoxGeneratedPorts<Transport, ProductionGeneratedBoxAccessor> {
  const createGeneratedControlClient = (transport: Transport) =>
    bindings.createContextPropagatingClient(bindings.controlService, transport);

  return {
    createTransport: bindings.createConnectTransport,

    createControlClient(transport): ProductionBoxControlClient {
      const client = createGeneratedControlClient(transport);
      const ping: BoxPingControlClient["ping"] = async (ctx, _request, options) =>
        await client.ping(ctx, new bindings.PingRequest(), options);
      const updateEnvironmentVariables: BoxEnvironmentControlClient["updateEnvironmentVariables"] =
        async (ctx, request) => await client.updateEnvironmentVariables(
          ctx,
          new bindings.UpdateEnvironmentVariablesRequest({
            env: request.env,
            replace: request.replace
          })
        );
      const loadMcpServers: BoxMcpControlClient["loadMcpServers"] =
        async (ctx, request) => await client.loadMcpServers(
          ctx,
          new bindings.LoadMcpServersRequest({
            mcpConfigJson: request.mcpConfigJson,
            removeMissing: true
          })
        );
      return { ping, updateEnvironmentVariables, loadMcpServers };
    },

    createExecClient(transport): BoxRemoteExecClient {
      return bindings.createContextPropagatingClient(bindings.execService, transport);
    },

    createResourceAccessor(manager): ProductionGeneratedBoxAccessor {
      return new RemoteResourceAccessor(manager);
    },

    withFileReadGuard(accessor, assertFileReadAllowed): ProductionGeneratedBoxAccessor {
      return new CombinedResourceAccessor(accessor, [
        resourceEntry(readExecutorResource, {
          async execute(ctx, args, options) {
            await assertFileReadAllowed(args.path);
            return await accessor.get(readExecutorResource).execute(ctx, args, options);
          }
        })
      ]);
    },

    withNoMonitorComputerUse(accessor): ProductionGeneratedBoxAccessor {
      return new CombinedResourceAccessor(accessor, [
        resourceEntry(computerUseExecutorResource, noMonitorComputerUseExecutor)
      ]);
    }
  };
}

const productionBoxGeneratedPackageBindings: ProductionBoxGeneratedPackageBindings<
  Transport,
  PingRequest,
  UpdateEnvironmentVariablesRequest,
  LoadMcpServersRequest
> = {
  createConnectTransport: createConnectTransport as unknown as BoxTransportFactory<Transport>,
  createContextPropagatingClient: createContextPropagatingClient as unknown as GeneratedContextPropagatingClientFactory<
    Transport,
    PingRequest,
    UpdateEnvironmentVariablesRequest,
    LoadMcpServersRequest
  >,
  controlService: ControlService as unknown as GeneratedServiceDescriptor<"agent.v1.ControlService">,
  execService: ExecService as unknown as GeneratedServiceDescriptor<"agent.v1.ExecService">,
  PingRequest,
  UpdateEnvironmentVariablesRequest,
  LoadMcpServersRequest
};

export const productionBoxGeneratedPorts = createProductionBoxGeneratedPorts(
  productionBoxGeneratedPackageBindings
);
