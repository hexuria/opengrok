import { errorLogTag } from "../../shared/errors.js";
import { reportHostDiagnostic } from "../host-diagnostics.js";
import type { HostBoxInner } from "../extensions/forever-box/host-box.js";
import {
  applyBoxEnvironmentViaTransport,
  type BoxEnvironmentControlClient,
  type BoxEnvironmentUpdate
} from "./box-env.js";
import { uploadFileViaExecDaemon, type FileTransferAccessor } from "./box-file-transfer.js";
import { applySharedDesktop, createSandBox } from "./box-factory.js";
import {
  loadBoxMcpServersViaTransport,
  type BoxMcpControlClient
} from "./box-mcp.js";
import {
  createBoxRemoteResourceAccessorFromTransport,
  createBoxTransport,
  pingBoxTransportClassified,
  type BoxControlClientFactory,
  type BoxPingControlClient,
  type BoxRemoteExecClient,
  type BoxRemoteExecManager,
  type BoxTransportFactory
} from "./box-remote-accessor.js";
import type {
  BoxEndpoint,
  LoopbackTelemetry,
  PingResult
} from "./loopback-sand-box.js";
import type { ShellAccessor } from "./box-windows.js";

export type ProductionBoxControlClient = BoxPingControlClient &
  BoxEnvironmentControlClient &
  BoxMcpControlClient;

/**
 * The erased generated/runtime constructors at the exact host-bundle boundary.
 * This deliberately exposes no lifecycle or whole-box implementation port.
 */
export interface ProductionBoxGeneratedPorts<
  Transport,
  Accessor extends ShellAccessor & FileTransferAccessor
> {
  readonly createTransport: BoxTransportFactory<Transport>;
  createControlClient(transport: Transport): ProductionBoxControlClient;
  createExecClient(transport: Transport): BoxRemoteExecClient;
  createResourceAccessor(manager: BoxRemoteExecManager): Accessor;
  withFileReadGuard(
    accessor: Accessor,
    assertFileReadAllowed: (path: string) => Promise<void>
  ): Accessor;
  withNoMonitorComputerUse(accessor: Accessor): Accessor;
}

export type ErasedProductionBoxGeneratedPorts = ProductionBoxGeneratedPorts<
  unknown,
  ShellAccessor & FileTransferAccessor
>;

export interface ProductionBoxProviderOptions<
  Transport,
  Accessor extends ShellAccessor & FileTransferAccessor
> {
  readonly generated: ProductionBoxGeneratedPorts<Transport, Accessor>;
  readonly telemetry: LoopbackTelemetry;
  readonly protectedBoxPaths: readonly string[];
  readonly host?: string;
  readonly authToken?: string;
  /**
   * The shipped co-resident image owns fork desktops and the 1339 router. The
   * reconstructed standalone exec daemon intentionally does not advertise
   * those absent capabilities, so agents use its authenticated primary
   * accessor instead of attempting /usr/local/bin/start-window.
   */
  readonly sharedDesktop?: boolean;
}

export type ProductionBoxInner = HostBoxInner & {
  dispose(): Promise<void>;
};

function createStandaloneProductionBoxInner<
  Accessor extends ShellAccessor & FileTransferAccessor
>(
  loopback: ReturnType<typeof createSandBox<Accessor>>,
  withNoMonitorComputerUse: (accessor: Accessor) => Accessor
): ProductionBoxInner {
  return {
    ensureReady: async (ctx, agentId) => {
      const primary = await loopback.ensureReady(ctx, agentId);
      return {
        ...primary,
        remoteAccessor: withNoMonitorComputerUse(primary.remoteAccessor),
        vncUrl: "",
      };
    },
    runState: () => loopback.runState(),
    listBoxes: () => loopback.listBoxes(),
    uploadFile: (ctx, agentId, boxPath, data) =>
      loopback.uploadFile(ctx, agentId, boxPath, data),
    downloadFile: (ctx, agentId, boxPath) =>
      loopback.downloadFile(ctx, agentId, boxPath),
    releaseWindow: async () => {},
    getAgentWindowIndex: () => 1,
    maxWindows: () => 1,
    getTerminalsFolder: () => loopback.getTerminalsFolder(),
    isAvailable: () => loopback.isAvailable(),
    describe: () => loopback.describe(),
    applyEnvironment: (ctx, update) =>
      loopback.applyEnvironment(ctx, decodeBoxEnvironmentUpdate(update)),
    loadMcpServers: (ctx, configJson) =>
      loopback.loadMcpServers(ctx, configJson),
    mcpResourceAccessor: ctx => loopback.mcpResourceAccessor(ctx),
    dispose: () => loopback.dispose(),
  };
}

function decodeBoxEnvironmentUpdate(value: unknown): BoxEnvironmentUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("box environment update must be an object");
  }
  const rawEnvironment = Reflect.get(value, "env");
  const replace = Reflect.get(value, "replace");
  if (
    typeof rawEnvironment !== "object" ||
    rawEnvironment === null ||
    Array.isArray(rawEnvironment) ||
    typeof replace !== "boolean"
  ) {
    throw new TypeError("box environment update has an invalid shape");
  }
  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(rawEnvironment)) {
    if (typeof entry !== "string") {
      throw new TypeError(`box environment value for ${name} must be a string`);
    }
    env[name] = entry;
  }
  return { env, replace };
}

/**
 * Rebuilds the artifact's production construction:
 * HostBox(applySharedDesktop(createSandBox(...), { persistAssignments: true })).
 *
 * Artifact anchors:
 * - src/app/dist/host/host-main.cjs:614442-615551 (box primitives/factory)
 * - src/app/dist/host/host-main.cjs:616596-616605 (production composition)
 */
export function createProductionBoxInner<
  Transport,
  Accessor extends ShellAccessor & FileTransferAccessor
>(
  options: ProductionBoxProviderOptions<Transport, Accessor>
): ProductionBoxInner {
  const { generated } = options;
  const createControlClient: BoxControlClientFactory<Transport> = transport =>
    generated.createControlClient(transport);
  const transportFor = (endpoint: BoxEndpoint): Transport =>
    createBoxTransport(endpoint, generated.createTransport);

  const loopback = createSandBox<Accessor>({
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
    telemetry: options.telemetry,
    protectedBoxPaths: options.protectedBoxPaths,
    operations: {
      async ping(ctx, endpoint): Promise<PingResult> {
        const result = await pingBoxTransportClassified(
          ctx,
          transportFor(endpoint),
          createControlClient
        );
        return result.causeSummary === undefined
          ? { outcome: result.outcome }
          : { outcome: result.outcome, causeSummary: result.causeSummary };
      },
      createRemoteAccessor(endpoint): Accessor {
        const transport = transportFor(endpoint);
        return createBoxRemoteResourceAccessorFromTransport(transport, {
          createExecClient: generated.createExecClient,
          createResourceAccessor: generated.createResourceAccessor
        });
      },
      protectRemoteAccessor(accessor, assertFileReadAllowed): Accessor {
        return generated.withFileReadGuard(accessor, assertFileReadAllowed);
      },
      async applyEnvironment(ctx, endpoint, update): Promise<void> {
        await applyBoxEnvironmentViaTransport(
          ctx,
          transportFor(endpoint),
          update,
          generated.createControlClient
        );
      },
      async loadMcpServers(ctx, endpoint, configJson): Promise<string[]> {
        return await loadBoxMcpServersViaTransport(
          ctx,
          transportFor(endpoint),
          configJson,
          generated.createControlClient
        );
      },
      async uploadFile(ctx, accessor, path, data): Promise<void> {
        await uploadFileViaExecDaemon(ctx, accessor, path, data);
      }
    }
  });

  if (options.sharedDesktop === false) {
    return createStandaloneProductionBoxInner(
      loopback,
      accessor => generated.withNoMonitorComputerUse(accessor)
    );
  }

  const composed = applySharedDesktop(loopback, {
    persistAssignments: true,
    gateComputerUse(primary) {
      return {
        ...primary,
        remoteAccessor: generated.withNoMonitorComputerUse(
          primary.remoteAccessor
        )
      };
    },
    reportPersistFailure(error) {
      reportHostDiagnostic({
        kind: "window_assignment_persist_failed",
        errorClass: errorLogTag(error)
      });
    }
  });
  return composed;
}
