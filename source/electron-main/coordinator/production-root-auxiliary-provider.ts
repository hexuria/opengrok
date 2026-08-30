import { getSandRootDir } from "../../host/host-paths.js";
import {
  isSandAgentModelSelection,
  resolveComputerUseModelSelection,
} from "../../shared/agents/sand-agent-model.js";
import { getSandRpcTraceWindowTraceparent } from "../../shared/node/cursor-backend/rpc-tracing.js";
import type {
  ProductionCoordinatorAuthStatus,
  ProductionCoordinatorPorts,
  ProductionCoordinatorTelemetryUploader,
} from "./production-provider.js";
import type { ProductionServiceContext } from "../main-production-services.js";
import {
  createElectronProductionCoordinatorNativePorts,
  type ElectronCoordinatorNativePorts,
} from "../adapters/coordinator-native.js";
import { recordGatewayCommandSpan, recordSendStageSpan } from "../telemetry/desktop-send-trace.js";
import { captureSandCoordinatorCrash } from "../telemetry/sentry.js";

/**
 * The root-owned coordinator inputs that are independent of account/gateway
 * authorization.  Keeping this tranche separate makes the missing root join
 * fail closed without manufacturing a ProductionCoordinatorPorts adapter.
 */
export interface ProductionCoordinatorAuxiliaryPorts {
  readonly native: ElectronCoordinatorNativePorts;
  readonly getDataDir: (context: ProductionServiceContext) => string;
  readonly resync: Pick<
    ProductionCoordinatorPorts<ProductionCoordinatorAuthStatus>["resync"],
    | "getMcpCustomInstructionsAccountScope"
    | "getMcpCustomInstructionsByServerId"
    | "getMcpDisabledToolsByServerId"
    | "setMcpCustomInstructionsByServerId"
    | "setMcpDisabledToolsByServerId"
    | "detectTimeZone"
    | "getUserTimeZoneOverride"
    | "getComputerUseModel"
    | "getAutoReviewInstructions"
    | "getLocalToolPermission"
    | "getWebauthnProxyEnabled"
    | "getFeatureFlagOverrides"
    | "pushBoxSecrets"
    | "onHostSettingsTransportConnected"
    | "onHostSettingsTransportDown"
  >;
  readonly events: ProductionCoordinatorPorts<ProductionCoordinatorAuthStatus>["events"];
  readonly telemetry: ProductionCoordinatorPorts<ProductionCoordinatorAuthStatus>["telemetry"];
}

const TELEMETRY_UPLOADER_METHODS = [
  "reportBoxReachability",
  "reportBoxDnsDiagnostic",
  "reportTransportStreamDown",
  "reportCoordinatorLifecycle",
  "reportRecoveryAction",
  "reportBoxMigrationWatch",
  "reportBoxRebuildEscalation",
  "reportBoxRebuildPendingStall",
  "reportReplicaResync",
  "reportSendJournalRestore",
  "reportResyncCompleted",
  "reportAgentsUnreachable",
] as const;

function telemetryService(context: ProductionServiceContext): Record<string, unknown> | undefined {
  return context.readTelemetry()?.telemetry as unknown as Record<string, unknown> | undefined;
}

function telemetryMethod(
  context: ProductionServiceContext,
  name: string,
): (...args: unknown[]) => unknown {
  const sink = telemetryService(context);
  const method = sink?.[name];
  if (typeof method !== "function") {
    throw new Error(`Electron coordinator telemetry is missing ${name}.`);
  }
  return method.bind(sink) as (...args: unknown[]) => unknown;
}

function getUploader(
  context: ProductionServiceContext,
): ProductionCoordinatorTelemetryUploader | null {
  const sink = telemetryService(context);
  if (sink === undefined) return null;
  if (TELEMETRY_UPLOADER_METHODS.some((name) => typeof sink[name] !== "function")) return null;
  return sink as unknown as ProductionCoordinatorTelemetryUploader;
}

function computerUseModel(context: ProductionServiceContext): unknown {
  const stored = context.settings.settingsStore.getComputerUseModel();
  const override = context.requireExperiments().getComputerUseModelOverride();
  return resolveComputerUseModelSelection({
    ...(isSandAgentModelSelection(stored) ? { storedModel: stored } : {}),
    ...(isSandAgentModelSelection(override) ? { overrideModel: override } : {}),
  }) ?? null;
}

/**
 * Exact root composition for native, resync, event and coordinator telemetry
 * ports.  The optional native argument is test-only; production calls use the
 * Electron carrier directly and therefore retain its fail-closed validation.
 */
export function createProductionCoordinatorAuxiliaryPorts(
  context: ProductionServiceContext,
  native: ElectronCoordinatorNativePorts = createElectronProductionCoordinatorNativePorts(),
): ProductionCoordinatorAuxiliaryPorts {
  const settings = context.settings.settingsStore;
  const notifications = context.requireNotifications();
  return {
    native,
    getDataDir: () => getSandRootDir(),
    resync: {
      getMcpCustomInstructionsAccountScope: () => settings.getMcpCustomInstructionsAccountScope(),
      getMcpCustomInstructionsByServerId: () => settings.getMcpCustomInstructionsByServerId(),
      getMcpDisabledToolsByServerId: () => settings.getMcpDisabledToolsByServerId(),
      setMcpCustomInstructionsByServerId: (value) => settings.setMcpCustomInstructionsByServerId(value),
      setMcpDisabledToolsByServerId: (value) => settings.setMcpDisabledToolsByServerId(value as Record<string, string[]>),
      detectTimeZone: () => {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return zone.length === 0 ? null : zone;
      },
      getUserTimeZoneOverride: () => settings.getUserTimeZoneOverride(),
      getComputerUseModel: () => computerUseModel(context),
      getAutoReviewInstructions: () => settings.getAutoReviewInstructions(),
      getLocalToolPermission: () => settings.getLocalToolPermission(),
      getWebauthnProxyEnabled: () => settings.getWebauthnProxyEnabled(),
      getFeatureFlagOverrides: () => context.requireExperiments().getFeatureFlagOverridesRecord(),
      pushBoxSecrets: () => context.secretsStores.pushBoxSecrets.push("resync"),
      onHostSettingsTransportConnected: () => context.hostSettingsFields.onTransportConnected(),
      onHostSettingsTransportDown: () => context.hostSettingsFields.setBoxStreamLive(false),
    },
    events: {
      onAgentsEvent: (payload) => notifications.onAgentsEvent(payload),
      onAgentsRosterSeed: (payload) => notifications.onAgentsRosterSeed(payload),
      onCoordinatorLaunched: () => context.onCoordinatorLaunched(),
    },
    telemetry: {
      getUploader: () => getUploader(context),
      isQuitting: () => context.isQuitting(),
      isRebuildInFlight: () => context.boxVisibilityTracker.isRecreateCoverOpen(),
      reportHandoff: (level, metadata) => {
        telemetryMethod(context, "reportDesktopCoordinatorHandoff")(level, metadata);
      },
      recordSendStage: (report) => recordSendStageSpan(report),
      recordGatewayCommandSpan: (report) => recordGatewayCommandSpan(report as Parameters<typeof recordGatewayCommandSpan>[0]),
      reportProcessCrash: (report) => captureSandCoordinatorCrash(report as Parameters<typeof captureSandCoordinatorCrash>[0]),
      getRpcTraceWindowTraceparent: () => getSandRpcTraceWindowTraceparent(),
      flushNow: () => { void telemetryMethod(context, "flushNow")(); },
    },
  };
}
