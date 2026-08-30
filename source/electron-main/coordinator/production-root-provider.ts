import type {
  ProductionAccountStatus,
  ProductionServiceContext,
} from "../main-production-services.js";
import {
  createProductionAccountAuthorization,
} from "../account/production-account-authorization.js";
import {
  createProductionCoordinatorGatewayBinding,
} from "../adapters/coordinator-gateway.js";
import {
  createProductionCoordinatorNativePorts,
  createElectronProductionCoordinatorNativePorts,
  type ElectronCoordinatorNativePorts,
  type ElectronCoordinatorNativeSource,
} from "../adapters/coordinator-native.js";
import {
  createProductionCoordinatorRevokeRefusedAccount,
} from "./account-revoke.js";
import {
  createProductionCoordinatorAuxiliaryPorts,
  type ProductionCoordinatorAuxiliaryPorts,
} from "./production-root-auxiliary-provider.js";
import type {
  ProductionCoordinatorAuthStatus,
  ProductionCoordinatorPorts,
} from "./production-provider.js";
import type {
  CoordinatorRendererPortIpcPorts,
} from "./production-provider.js";
import type {
  ElectronProductionCoordinatorBindingParts,
} from "../production-adapters.js";

export interface ElectronProductionCoordinatorBindingSource extends ElectronCoordinatorNativeSource {
  readonly ipcMain: CoordinatorRendererPortIpcPorts["ipcMain"];
}

function accountAuthorization(context: ProductionServiceContext) {
  return createProductionAccountAuthorization({
    env: context.env,
    isPackaged: context.native.app.isPackaged,
    userDataDir: context.native.app.getPath("userData"),
    store: context.settings.settingsStore,
    abandonForeignOnboardingMirror: () => context.hostSettingsFields.onAccountDeparted(),
    onBindingCleanupFailure: (error) => context.reportFailure("account", "descriptor-cleanup", error),
  });
}

function accountPorts(
  context: ProductionServiceContext,
): ProductionCoordinatorPorts<ProductionCoordinatorAuthStatus>["account"] {
  const authorization = accountAuthorization(context);
  const revoke = createProductionCoordinatorRevokeRefusedAccount<ProductionCoordinatorAuthStatus>(
    async () => context.requireAccount().getAuthService() as unknown as {
      revokeForAccountRefusal(): Promise<{
        readonly kind: string;
        readonly status: ProductionCoordinatorAuthStatus;
        readonly error?: unknown;
      }>;
    },
  );
  return {
    authorizeAccount: async (slot, transition) => {
      const authorizationContext = {
        isStartup: transition.isStartup,
        ...(transition.previousSlot === undefined ? {} : { previousSlot: transition.previousSlot }),
      };
      return await authorization.authorizeAccount(slot, authorizationContext);
    },
    revokeRefusedAccount: (receivedContext) => revoke.revokeRefusedAccount(),
    async prepareAccountTransition(transition, receivedContext): Promise<void> {
      if (transition.previousSlot == null) return;
      try {
        await receivedContext.coordinatorResync.pushHostSettings({
          mcpCustomInstructionsAccountScope: null,
          mcpCustomInstructions: {},
          mcpCustomInstructionsByServerId: {},
          mcpDisabledToolsByServerId: {},
        });
      } catch (error) {
        receivedContext.reportFailure("host-settings", "clear", error);
      } finally {
        receivedContext.settings.settingsStore.clearAccountScope();
        if (receivedContext.shouldPreserveComputers?.() !== true) {
          await receivedContext.clearGatewayDescriptor();
          await receivedContext.requireMcp().resetMcpManager();
        }
      }
    },
    resetAccountState: (receivedContext) => receivedContext.requireNotifications().resetAccountState(),
    deliverStatus: (status, receivedContext) => {
      receivedContext.requireAccount().deliverCursorAuthStatus(
        status as unknown as ProductionAccountStatus,
      );
    },
  };
}

/**
 * Composes the reviewed zero-input coordinator root.  It deliberately returns
 * the typed port object only; activation/manifest ownership remains outside
 * this provider so a missing external binding cannot become a fallback.
 */
export function createProductionCoordinatorPorts(
  context: ProductionServiceContext,
  native: ElectronCoordinatorNativePorts = createElectronProductionCoordinatorNativePorts(),
): ProductionCoordinatorPorts<ProductionCoordinatorAuthStatus> {
  const auxiliary: ProductionCoordinatorAuxiliaryPorts =
    createProductionCoordinatorAuxiliaryPorts(context, native);
  const gateway = createProductionCoordinatorGatewayBinding();
  return {
    electronMainModuleUrl: import.meta.url,
    ...auxiliary.native,
    createGatewayConnector: gateway.createGatewayConnector,
    getDataDir: auxiliary.getDataDir,
    account: accountPorts(context),
    resync: auxiliary.resync,
    events: auxiliary.events,
    telemetry: auxiliary.telemetry,
    reportProblem: context.reportProblem,
    reportFailure: context.reportFailure,
  };
}

/**
 * Manifest-ready coordinator owner.  The manifest is evaluated before the
 * production service context exists, so it receives a lazy factory rather
 * than prebuilding context-bound ports.  Both coordinator and renderer IPC
 * ports are created in one post-context operation and therefore share the
 * same native/context identity and lifecycle.
 */
export function createElectronProductionCoordinatorBinding(
  source?: ElectronProductionCoordinatorBindingSource,
): { create(context: ProductionServiceContext): ElectronProductionCoordinatorBindingParts } {
  return {
    create(context) {
      const electron = source ?? (require("electron") as ElectronProductionCoordinatorBindingSource);
      const native = createProductionCoordinatorNativePorts(electron);
      const coordinatorPorts = createProductionCoordinatorPorts(context, native);
      return {
        coordinatorPorts,
        rendererPortIpc: {
          ipcMain: electron.ipcMain,
          getTrustedContents: () => context.getTrustedContents() as ReturnType<NonNullable<CoordinatorRendererPortIpcPorts["getTrustedContents"]>>,
          reportHandoff: coordinatorPorts.telemetry.reportHandoff,
          reportFailure: context.reportFailure,
        },
      };
    },
  };
}

/** Test-only carrier constructor; production uses the Electron ABI factory. */
export { createProductionCoordinatorNativePorts };
