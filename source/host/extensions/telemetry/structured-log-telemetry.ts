import { autoReviewApprovalTelemetry } from "./auto-review-approval-telemetry.js";
import {
  automationFireDroppedTelemetry,
  automationRunTelemetry,
} from "./automation-fire-telemetry.js";
import { automationShadowPruneTelemetry } from "./automation-shadow-prune-telemetry.js";
import { boxLogShipTelemetry } from "./box-log-ship-telemetry.js";
import { conversationGcTelemetry } from "./conversation-gc-telemetry.js";
import { diskPressureTelemetry } from "./disk-pressure-telemetry.js";
import { eventLoopWindowTelemetry } from "./event-loop-telemetry.js";
import { experimentsDiagnosticTelemetry } from "./experiments-diagnostic-telemetry.js";
import {
  hostCrashMarkerMetadata,
  type HostCrashMarker,
} from "./host-crash-marker.js";
import { hostDiagnosticTelemetry } from "./host-diagnostic-telemetry.js";
import { hostEventBusTelemetry } from "./host-event-bus-telemetry.js";
import { hostExtensionDiagnosticTelemetry } from "./host-extension-diagnostic-telemetry.js";
import {
  boxImageCheckTelemetry,
  boxInfrastructureTelemetry,
  daemonPingTelemetry,
  hostLifecycleTelemetry,
  hostStartupTelemetry,
} from "./lifecycle-telemetry.js";
import {
  localExecFailedTelemetry,
  localExecProviderTelemetry,
  localExecRefusedTelemetry,
} from "./local-exec-telemetry.js";
import { memorySynthesisTelemetry } from "./memory-synthesis-telemetry.js";
import {
  ackObligationTelemetry,
  pendingWakeTelemetry,
  queueAcceptedTelemetry,
  queueDequeuedTelemetry,
  queueWatchdogTelemetry,
  sendDispatchTelemetry,
} from "./queue-telemetry-mappers.js";
import {
  shellRevivalTelemetry,
  subagentRevivalTelemetry,
} from "./revival-telemetry-mappers.js";
import { searchIndexHealthTelemetry } from "./search-index-health-telemetry.js";
import { sessionDiagnosticTelemetry } from "./session-diagnostic-telemetry.js";
import { turnEmptyDeliveryTelemetry } from "./turn-empty-delivery-telemetry.js";
import {
  closingSendNudgeTelemetry,
  computerUseUsageTelemetry,
  ttftTelemetry,
  turnAwaitTelemetry,
  turnInterruptTelemetry,
  turnRetryTelemetry,
  turnUsageTelemetry,
  userMessageReceivedTelemetry,
} from "./turn-telemetry-mappers.js";
import { webauthnProxyTelemetry } from "./webauthn-proxy-telemetry.js";
import type {
  DeadlinePolicy,
  ExpiryPolicy,
  PollingPolicy,
} from "../../../internal/scheduling.js";
import {
  StructuredLogTransport,
  type StructuredLogClient,
} from "../../../shared/observability/structured-log-transport.js";
import {
  connectorAuthTelemetry,
  type ConnectorAuthReport,
} from "../../../shared/observability/connector-auth-telemetry.js";
import {
  sandErrorTags,
  sandErrorWireCode,
  type SandErrorValue,
} from "../../../shared/errors/registry.js";
import {
  AGENT_ERROR_DETAIL_EVENT,
  AGENT_ERROR_EVENT,
  AGENT_OPEN_EVENT,
  AUTOMATION_LIFECYCLE_EVENT,
  AUTO_REVIEW_DISPLAY_RECHECK_FAILED_EVENT,
  AUTO_REVIEW_EXPIRE_SWEEP_FAILED_EVENT,
  BOT_BLOCK_DETAIL_EVENT,
  BOT_BLOCK_EVENT,
  BOX_LOG_EVENT,
  BOX_COPY_IN_EVENT,
  BOX_HELP_EVENT,
  BOX_RECREATE_DECIDED_EVENT,
  BOX_STORE_DB_CAPTURE_EVENT,
  BOX_STORE_MANIFEST_CONFLICT_EVENT,
  BOX_STORE_SYNC_EVENT,
  CHROME_SESSION_STAGE_EVENT,
  CLIENT_RESOURCE_EVENT,
  CONNECTOR_AUTH_EVENT,
  GATEWAY_COMMAND_ERROR_EVENT,
  GATEWAY_COMMAND_TIMING_EVENT,
  HOST_CRASH_EVENT,
  HOST_INVARIANT_VIOLATION_EVENT,
  HOST_LOG_EVENT,
  HOST_UPGRADE_EVENT,
  INFERENCE_CREDENTIAL_RENEWAL_EVENT,
  MCP_AUTH_CLEANUP_EVENT,
  MCP_DISCOVERY_FAILED_EVENT,
  PLUGIN_SKILLS_SYNC_EVENT,
  SAND_LOG_KEY,
  SKILL_PUBLISH_EDGE_FAILED_EVENT,
  TEACH_RECORDING_CAP_STOP_FAILED_EVENT,
  TEACH_RECORDING_START_FAILED_EVENT,
  TOOL_CALL_ERROR_EVENT,
  TOOL_CALL_STALLED_EVENT,
  TOOL_CALL_STARTED_EVENT,
  TURN_OUTCOME_DETAIL_EVENT,
  TURN_OUTCOME_EVENT,
  TURN_START_EVENT,
  DESKTOP_HEALTH_EVENT,
} from "../../../shared/observability/telemetry-events.js";
import {
  SAND_CLIENT_TYPE,
  getSandClientVersion,
} from "../../../shared/node/sand-client-metadata.js";
import { journalOutcomeTelemetry } from "./journal-outcome-telemetry.js";
import { resolveSandBoxIdentityTags } from "../../ports/telemetry.js";
import { AnalyticsService } from "../../../packages/proto/generated/aiserver/v1/analytics_connect.js";
import { createSandCursorBackendClient } from "../../../shared/node/cursor-backend/cursor-inference.js";

export type LogLevel = "info" | "warn" | "error";
export type Metadata = Record<string, string | undefined>;
export interface StructuredLogTransportLike {
  enqueue(
    level: LogLevel,
    message: string,
    metadata: Metadata,
    onSettled?: (settlement: "delivered" | "dropped") => void,
  ): void;
  shipConfirmed(
    level: LogLevel,
    message: string,
    metadata: Metadata,
  ): Promise<boolean>;
  setIdentityTags(tags: Metadata): void;
  setFlushTickListener(listener?: () => void): void;
  dispose(): Promise<unknown>;
}
export class InMemoryStructuredLogTransport implements StructuredLogTransportLike {
  readonly entries: Array<{
    level: LogLevel;
    message: string;
    metadata: Metadata;
  }> = [];
  identityTags: Metadata = {};
  private flushTickListener: (() => void) | undefined;
  enqueue(
    level: LogLevel,
    message: string,
    metadata: Metadata,
    onSettled?: (settlement: "delivered" | "dropped") => void,
  ): void {
    this.entries.push({
      level,
      message,
      metadata: { ...this.identityTags, ...metadata },
    });
    onSettled?.("delivered");
  }
  async shipConfirmed(
    level: LogLevel,
    message: string,
    metadata: Metadata,
  ): Promise<boolean> {
    this.enqueue(level, message, metadata);
    return true;
  }
  setIdentityTags(tags: Metadata): void {
    const clean: Metadata = {};
    for (const [key, value] of Object.entries(tags)) {
      if (value !== undefined && value.length > 0) {
        clean[key] = value;
      }
    }
    this.identityTags = clean;
  }
  setFlushTickListener(listener?: () => void): void {
    this.flushTickListener = listener;
  }
  tick(): void {
    this.flushTickListener?.();
  }
  async dispose(): Promise<void> {}
}
export const TELEMETRY_FLUSH_TICK_MS = 3_000,
  HOST_IDENTITY_HOLD_BACKSTOP_MS = 90_000,
  MAX_HOST_LOG_LENGTH = 2_048,
  MAX_ERROR_DETAIL_MESSAGE_LENGTH = 1_024,
  MAX_ERROR_DETAIL_STACK_LENGTH = 4_096,
  TOOL_CALL_MS_CAP = 24 * 60 * 60 * 1_000;
export function getHostBuiltAtMs(): string {
  return "1786556440000";
}
export function truncateStructuredLogValue(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
export function cappedToolCallMs(ms: number): string {
  return String(Math.min(Math.max(0, Math.round(ms)), TOOL_CALL_MS_CAP));
}
export function structuredErrorCode(error: unknown): string {
  return sandErrorWireCode(
    typeof error === "object" && error !== null ? error : {},
  );
}
export function errorDetailTags(
  error: unknown,
  detail: { message: string; stack?: string },
) {
  return {
    error_code: structuredErrorCode(error),
    error_message: truncateStructuredLogValue(
      detail.message,
      MAX_ERROR_DETAIL_MESSAGE_LENGTH,
    ),
    error_stack:
      detail.stack !== undefined
        ? truncateStructuredLogValue(
            detail.stack,
            MAX_ERROR_DETAIL_STACK_LENGTH,
          )
        : undefined,
  };
}
type Fields = Record<string, unknown>;
type MapperResult = {
  level: string;
  event?: string;
  message?: string;
  metadata: Record<string, unknown>;
};

export interface SandStructuredLogTelemetryOptions {
  readonly transport?: StructuredLogTransportLike;
  readonly identityTags?: Metadata;
  readonly appVersion?: string;
  readonly getAccessToken?: (request: unknown) => Promise<string>;
  readonly getMachineId?: () => Promise<string>;
  readonly createClient?: () => StructuredLogClient;
  readonly flushPolling?: PollingPolicy;
  readonly submitDeadline?: DeadlinePolicy;
  readonly identityHoldExpiry?: ExpiryPolicy;
  readonly holdFlushForHostBundleIdentity?: boolean;
}

function canCreateProductionTransport(
  options: SandStructuredLogTelemetryOptions,
): options is SandStructuredLogTelemetryOptions & {
  flushPolling: PollingPolicy;
  submitDeadline: DeadlinePolicy;
} {
  return (
    (options.createClient !== undefined ||
      (options.getAccessToken !== undefined && options.getMachineId !== undefined)) &&
    options.flushPolling !== undefined &&
    options.submitDeadline !== undefined &&
    (options.holdFlushForHostBundleIdentity !== true || options.identityHoldExpiry !== undefined)
  );
}

export class SandStructuredLogTelemetry {
  readonly transport: StructuredLogTransportLike;
  readonly activeTurnsByConversation = new Map<string, SandTurnTelemetryImpl>();
  constructor(options: SandStructuredLogTelemetryOptions) {
    if (options.transport !== undefined) {
      this.transport = options.transport;
      if (options.identityTags !== undefined)
        this.transport.setIdentityTags(options.identityTags);
      return;
    }

    if (canCreateProductionTransport(options)) {
      const platformTags: Metadata = {
        client: SAND_CLIENT_TYPE,
        "client.type": SAND_CLIENT_TYPE,
        client_version: getSandClientVersion(),
        app_version: options.appVersion ?? "0.18.0",
        arch: process.arch,
        platform: process.platform,
        ...(options.identityTags ?? resolveSandBoxIdentityTags()),
      };
      const createClient = options.createClient ?? (() =>
        createSandCursorBackendClient(AnalyticsService, {
          getAccessToken: async (request) => {
            try {
              return await options.getAccessToken!(request);
            } catch {
              return "";
            }
          },
          getMachineId: options.getMachineId!,
        }) as unknown as StructuredLogClient
      );
      this.transport = new StructuredLogTransport({
        key: SAND_LOG_KEY,
        platformTags,
        createClient,
        polling: options.flushPolling,
        submitDeadline: options.submitDeadline,
        holdForIdentity: options.holdFlushForHostBundleIdentity === true,
        disabled: process.env.SAND_DISABLE_TELEMETRY === "1",
        ...(options.identityHoldExpiry === undefined
          ? {}
          : { identityHoldExpiry: options.identityHoldExpiry }),
      });
      return;
    }

    this.transport = new InMemoryStructuredLogTransport();
    if (options.identityTags !== undefined)
      this.transport.setIdentityTags(options.identityTags);
  }
  setHostBundleIdentity(identity: {
    hostBundleVersion?: string;
    boxStoreId?: string;
  }): void {
    this.transport.setIdentityTags({
      host_bundle_version: identity.hostBundleVersion,
      host_built_at_ms: getHostBuiltAtMs(),
      box_store_id: identity.boxStoreId,
    });
  }
  startTurn(start: {
    conversationId: string;
    turnType: string;
    model?: string;
  }): SandTurnTelemetryImpl {
    let turn: SandTurnTelemetryImpl;
    turn = new SandTurnTelemetryImpl(this, start, () => {
      if (this.activeTurnsByConversation.get(start.conversationId) === turn)
        this.activeTurnsByConversation.delete(start.conversationId);
    });
    this.activeTurnsByConversation.set(start.conversationId, turn);
    return turn;
  }
  private mapped(result: MapperResult): void {
    this.enqueue(
      result.level as LogLevel,
      result.event ?? result.message ?? "",
      result.metadata,
    );
  }
  reportAutoReviewApproval(
    r: Parameters<typeof autoReviewApprovalTelemetry>[0],
  ): void {
    const e = autoReviewApprovalTelemetry(r);
    this.enqueue("info", e.event, e.metadata);
  }
  reportAutomationRun(r: Parameters<typeof automationRunTelemetry>[0]): void {
    this.mapped(automationRunTelemetry(r));
  }
  reportAutomationFireDropped(
    r: Parameters<typeof automationFireDroppedTelemetry>[0],
  ): void {
    this.mapped(automationFireDroppedTelemetry(r));
  }
  reportAutomationShadowPrune(
    r: Parameters<typeof automationShadowPruneTelemetry>[0],
  ): void {
    this.mapped(automationShadowPruneTelemetry(r));
  }
  reportConversationGc(r: Parameters<typeof conversationGcTelemetry>[0]): void {
    this.mapped(conversationGcTelemetry(r));
  }
  reportBoxDiskPressure(r: Parameters<typeof diskPressureTelemetry>[0]): void {
    const e = diskPressureTelemetry(r);
    this.enqueue(e.level, "sand.box.disk_pressure", e.metadata);
  }
  reportHostEventLoop(r: Parameters<typeof eventLoopWindowTelemetry>[0]): void {
    this.mapped(eventLoopWindowTelemetry(r));
  }
  reportExperimentsDiagnostic(
    r: Parameters<typeof experimentsDiagnosticTelemetry>[0],
  ): void {
    this.mapped(experimentsDiagnosticTelemetry(r));
  }
  reportHostDiagnostic(r: Parameters<typeof hostDiagnosticTelemetry>[0]): void {
    this.mapped(hostDiagnosticTelemetry(r));
  }
  reportHostEventBusFailure(
    r: Parameters<typeof hostEventBusTelemetry>[0],
  ): void {
    this.mapped(hostEventBusTelemetry(r));
  }
  reportHostExtensionDiagnostic(
    r: Parameters<typeof hostExtensionDiagnosticTelemetry>[0],
  ): void {
    const e = hostExtensionDiagnosticTelemetry(r);
    if (e !== undefined) this.mapped(e);
  }
  reportSessionDiagnostic(
    r: Parameters<typeof sessionDiagnosticTelemetry>[0],
  ): void {
    this.mapped(sessionDiagnosticTelemetry(r));
  }
  reportSearchIndexHealth(
    r: Parameters<typeof searchIndexHealthTelemetry>[0],
  ): void {
    this.mapped(searchIndexHealthTelemetry(r));
  }
  reportLocalExecRefused(
    r: Parameters<typeof localExecRefusedTelemetry>[0],
  ): void {
    this.mapped(localExecRefusedTelemetry(r));
  }
  reportLocalExecProvider(
    r: Parameters<typeof localExecProviderTelemetry>[0],
  ): void {
    this.mapped(localExecProviderTelemetry(r));
  }
  reportLocalExecFailed(
    r: Parameters<typeof localExecFailedTelemetry>[0],
  ): void {
    this.mapped(localExecFailedTelemetry(r));
  }
  reportWebAuthnProxy(r: Parameters<typeof webauthnProxyTelemetry>[0]): void {
    this.mapped(webauthnProxyTelemetry(r));
  }
  reportMemorySynthesis(
    r: Parameters<typeof memorySynthesisTelemetry>[0],
  ): void {
    this.mapped(memorySynthesisTelemetry(r));
  }
  reportHostStartup(metadata: Record<string, string>): void {
    this.mapped(hostStartupTelemetry(metadata, getHostBuiltAtMs()));
  }
  reportHostLifecycle(r: Parameters<typeof hostLifecycleTelemetry>[0]): void {
    this.mapped(hostLifecycleTelemetry(r));
  }
  reportDaemonPing(r: Parameters<typeof daemonPingTelemetry>[0]): void {
    this.mapped(daemonPingTelemetry(r));
  }
  reportBoxImageCheck(r: Parameters<typeof boxImageCheckTelemetry>[0]): void {
    this.mapped(boxImageCheckTelemetry(r));
  }
  enqueueBoxInfrastructureEvent(
    event: Parameters<typeof boxInfrastructureTelemetry>[0],
    onSettled?: (settlement: "delivered" | "dropped") => void,
  ): void {
    const e = boxInfrastructureTelemetry(event);
    if ("level" in e && "event" in e && "metadata" in e)
      this.enqueue(
        e.level as LogLevel,
        String(e.event),
        e.metadata as Metadata,
        onSettled,
      );
  }
  reportBoxBootStage(r: Fields): void {
    this.enqueueBoxInfrastructureEvent({
      kind: "boot_stage",
      ...r,
    } as Parameters<typeof boxInfrastructureTelemetry>[0]);
  }
  reportBoxBootFailure(r: Fields): void {
    this.enqueueBoxInfrastructureEvent({
      kind: "boot_failure",
      ...r,
    } as Parameters<typeof boxInfrastructureTelemetry>[0]);
  }
  reportEgressTunnel(r: Fields): void {
    this.enqueueBoxInfrastructureEvent({
      kind: "egress_tunnel",
      ...r,
    } as Parameters<typeof boxInfrastructureTelemetry>[0]);
  }
  reportHostBootFetch(r: Fields): void {
    this.enqueueBoxInfrastructureEvent({
      kind: "host_boot_fetch",
      ...r,
    } as Parameters<typeof boxInfrastructureTelemetry>[0]);
  }
  reportExecDaemonRestart(r: Fields): void {
    this.enqueueBoxInfrastructureEvent({
      kind: "exec_daemon_restart",
      ...r,
    } as Parameters<typeof boxInfrastructureTelemetry>[0]);
  }
  reportSupervisorRestart(r: Fields): void {
    this.enqueueBoxInfrastructureEvent({
      kind: "supervisor_restart",
      ...r,
    } as Parameters<typeof boxInfrastructureTelemetry>[0]);
  }
  async reportBoxBootStageConfirmed(r: Fields): Promise<boolean> {
    const e = boxInfrastructureTelemetry({
      kind: "boot_stage",
      ...r,
    } as Parameters<typeof boxInfrastructureTelemetry>[0]);
    return "level" in e && "event" in e && "metadata" in e
      ? this.transport.shipConfirmed(
          e.level as LogLevel,
          String(e.event),
          e.metadata as Metadata,
        )
      : false;
  }
  reportTurnInterrupt(r: Parameters<typeof turnInterruptTelemetry>[0]): void {
    this.mapped(turnInterruptTelemetry(r));
  }
  reportTurnAwait(r: Parameters<typeof turnAwaitTelemetry>[0]): void {
    this.mapped(turnAwaitTelemetry(r));
  }
  reportTurnRetry(r: Parameters<typeof turnRetryTelemetry>[0]): void {
    if (r.outcome === "retried")
      this.activeTurnsByConversation
        .get(String(r.conversationId))
        ?.noteRetry(r);
    this.mapped(turnRetryTelemetry(r));
  }
  reportUserMessageReceived(
    r: Parameters<typeof userMessageReceivedTelemetry>[0],
  ): void {
    this.mapped(userMessageReceivedTelemetry(r));
  }
  reportClosingSendNudge(
    r: Parameters<typeof closingSendNudgeTelemetry>[0],
  ): void {
    this.mapped(closingSendNudgeTelemetry(r));
  }
  reportSubagentRevival(
    r: Parameters<typeof subagentRevivalTelemetry>[0],
  ): void {
    this.mapped(subagentRevivalTelemetry(r));
  }
  reportShellRevival(r: Parameters<typeof shellRevivalTelemetry>[0]): void {
    this.mapped(shellRevivalTelemetry(r));
  }
  reportTtft(r: Parameters<typeof ttftTelemetry>[0]): void {
    this.mapped(ttftTelemetry(r));
  }
  reportSendDispatch(r: Parameters<typeof sendDispatchTelemetry>[0]): void {
    this.mapped(sendDispatchTelemetry(r));
  }
  reportQueueAccepted(r: Parameters<typeof queueAcceptedTelemetry>[0]): void {
    this.mapped(queueAcceptedTelemetry(r));
  }
  reportQueueDequeued(r: Parameters<typeof queueDequeuedTelemetry>[0]): void {
    this.mapped(queueDequeuedTelemetry(r));
  }
  reportQueueWatchdog(r: Parameters<typeof queueWatchdogTelemetry>[0]): void {
    this.mapped(queueWatchdogTelemetry(r));
  }
  reportAckObligation(r: Parameters<typeof ackObligationTelemetry>[0]): void {
    this.mapped(ackObligationTelemetry(r));
  }
  reportPendingWake(r: Parameters<typeof pendingWakeTelemetry>[0]): void {
    this.mapped(pendingWakeTelemetry(r));
  }
  reportTurnUsage(r: Parameters<typeof turnUsageTelemetry>[0]): void {
    this.mapped(turnUsageTelemetry(r));
  }
  reportTurnEmptyDelivery(
    r: Parameters<typeof turnEmptyDeliveryTelemetry>[0],
  ): void {
    this.mapped(turnEmptyDeliveryTelemetry(r));
  }
  reportJournalOutcome(r: Parameters<typeof journalOutcomeTelemetry>[0]): void {
    this.mapped(journalOutcomeTelemetry(r));
  }
  reportComputerUseUsage(
    r: Parameters<typeof computerUseUsageTelemetry>[0],
  ): void {
    this.mapped(computerUseUsageTelemetry(r));
  }
  reportToolCallError(r: Fields): void {
    this.enqueue("error", TOOL_CALL_ERROR_EVENT, {
      conversation_id: String(r.conversationId),
      request_id: r.requestId as string | undefined,
      tool_name: r.toolName as string | undefined,
      tool_call_id: r.toolCallId as string | undefined,
      error_class: r.errorClass as string | undefined,
      duration_ms:
        r.durationMs !== undefined
          ? cappedToolCallMs(r.durationMs as number)
          : undefined,
      connector: r.connector as string | undefined,
    });
  }
  reportToolCallStalled(r: Fields): void {
    this.enqueue("warn", TOOL_CALL_STALLED_EVENT, {
      conversation_id: String(r.conversationId),
      request_id: r.requestId as string | undefined,
      tool_name: r.toolName as string | undefined,
      tool_call_id: r.toolCallId as string | undefined,
      connector: r.connector as string | undefined,
      elapsed_ms: cappedToolCallMs(r.elapsedMs as number),
    });
  }
  reportToolCallStarted(r: Fields): void {
    this.enqueue("info", TOOL_CALL_STARTED_EVENT, {
      conversation_id: String(r.conversationId),
      request_id: r.requestId as string | undefined,
      tool_name: r.toolName as string | undefined,
      tool_call_id: r.toolCallId as string | undefined,
      surface: r.surface as string | undefined,
    });
  }
  reportAgentError(report: {
    source: string;
    conversationId: string;
    requestId?: string;
    error: SandErrorValue;
    detail?: { message: string; stack?: string };
  }): void {
    this.enqueue("error", AGENT_ERROR_EVENT, {
      source: report.source,
      conversation_id: report.conversationId,
      request_id: report.requestId,
      ...sandErrorTags(report.error),
    });
    if (report.detail !== undefined) {
      this.enqueue("error", AGENT_ERROR_DETAIL_EVENT, {
        source: report.source,
        conversation_id: report.conversationId,
        request_id: report.requestId,
        ...errorDetailTags(report.error, report.detail),
      });
    }
  }
  reportAutoReviewDisplayRecheckFailed(report: {
    conversationId: string;
  }): void {
    this.enqueue("info", AUTO_REVIEW_DISPLAY_RECHECK_FAILED_EVENT, {
      conversation_id: report.conversationId,
      surface: "computer",
    });
  }
  reportAutoReviewExpireSweepFailed(report: {
    stage: string;
    errorClass: string;
  }): void {
    this.enqueue("warn", AUTO_REVIEW_EXPIRE_SWEEP_FAILED_EVENT, {
      stage: report.stage,
      error_class: report.errorClass,
    });
  }
  reportBoxStoreSyncCycle(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, BOX_STORE_SYNC_EVENT, metadata);
  }
  reportBoxStoreDbCapture(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, BOX_STORE_DB_CAPTURE_EVENT, metadata);
  }
  reportBoxStoreManifestConflict(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, BOX_STORE_MANIFEST_CONFLICT_EVENT, metadata);
  }
  reportChromeSessionStage(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, CHROME_SESSION_STAGE_EVENT, metadata);
  }
  reportMcpAuthCleanup(outcome: "ok" | "error", removedCount: number): void {
    this.enqueue(
      outcome === "error" ? "warn" : "info",
      MCP_AUTH_CLEANUP_EVENT,
      {
        outcome,
        removed_count: String(removedCount),
      },
    );
  }
  reportMcpDiscoveryFailed(report: {
    errorClass: string;
    elapsedMs: number;
    servedStale: boolean;
  }): void {
    this.enqueue("warn", MCP_DISCOVERY_FAILED_EVENT, {
      error_class: report.errorClass,
      elapsed_ms: String(Math.round(report.elapsedMs)),
      served_stale: String(report.servedStale),
    });
  }
  reportConnectorAuth(report: ConnectorAuthReport): void {
    const { level, metadata } = connectorAuthTelemetry(report, "host");
    this.enqueue(level, CONNECTOR_AUTH_EVENT, metadata);
  }
  reportLocalToolPermissionStrandedRetirement(): void {
    this.enqueue("warn", CLIENT_RESOURCE_EVENT, {
      domain: "permissions",
      operation: "resolveLocalToolPermission",
      state: "failed",
      failure_code: "permissions/stranded-ask-retired",
      boundary: "host",
      retry_owner: "none",
    });
  }
  reportSkillPublishEdgeFailed(report: {
    stage: string;
    errorClass: string;
  }): void {
    this.enqueue("warn", SKILL_PUBLISH_EDGE_FAILED_EVENT, {
      stage: report.stage,
      error_class: report.errorClass,
    });
  }
  reportPluginSkillsSync(report: {
    trigger: string;
    outcome: string;
    changed?: boolean;
    skillCount?: number;
    errorClass?: string;
    durationMs: number;
  }): void {
    this.enqueue(
      report.outcome === "failed" ? "warn" : "info",
      PLUGIN_SKILLS_SYNC_EVENT,
      {
        trigger: report.trigger,
        outcome: report.outcome,
        changed:
          report.changed === undefined ? undefined : String(report.changed),
        skill_count:
          report.skillCount === undefined
            ? undefined
            : String(report.skillCount),
        error_class: report.errorClass,
        duration_ms: String(Math.round(report.durationMs)),
      },
    );
  }
  reportTeachRecordingCapStopFailed(report: { errorClass: string }): void {
    this.enqueue("warn", TEACH_RECORDING_CAP_STOP_FAILED_EVENT, {
      error_class: report.errorClass,
    });
  }
  reportTeachRecordingStartFailed(report: {
    kind: string;
    errorClass: string;
    windowIndex?: number;
    entryPoint?: string;
  }): void {
    this.enqueue("warn", TEACH_RECORDING_START_FAILED_EVENT, {
      kind: report.kind,
      error_class: report.errorClass,
      window_index:
        report.windowIndex === undefined
          ? undefined
          : String(report.windowIndex),
      entry_point: report.entryPoint,
    });
  }
  reportBoxCopyIn(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, BOX_COPY_IN_EVENT, metadata);
  }
  reportBoxRecreateDecided(metadata: Metadata): void {
    this.enqueue("info", BOX_RECREATE_DECIDED_EVENT, metadata);
  }
  reportInferenceCredentialRenewal(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, INFERENCE_CREDENTIAL_RENEWAL_EVENT, metadata);
  }
  reportGatewayCommandError(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, GATEWAY_COMMAND_ERROR_EVENT, metadata);
  }
  reportGatewayCommandTiming(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, GATEWAY_COMMAND_TIMING_EVENT, metadata);
  }
  reportAutomationLifecycle(report: {
    conversationId: string;
    automationId: string;
    action: string;
    source: string;
    triggerType: string;
    scheduledFiresNext7Days?: number | null;
    firesOnWeekend?: boolean | null;
    firesOvernight?: boolean | null;
    ageMs: number;
    recordedRunCount: number;
  }): void {
    this.enqueue("info", AUTOMATION_LIFECYCLE_EVENT, {
      conversation_id: report.conversationId,
      automation_id: report.automationId,
      action: report.action,
      source: report.source,
      trigger_type: report.triggerType,
      scheduled_fires_next_7_days:
        report.scheduledFiresNext7Days == null
          ? undefined
          : String(report.scheduledFiresNext7Days),
      fires_on_weekend:
        report.firesOnWeekend == null
          ? undefined
          : String(report.firesOnWeekend),
      fires_overnight:
        report.firesOvernight == null
          ? undefined
          : String(report.firesOvernight),
      age_ms: String(report.ageMs),
      recorded_run_count: String(report.recordedRunCount),
    });
  }
  reportHostLog(level: LogLevel, line: string, metadata: Metadata = {}): void {
    this.enqueue(level, HOST_LOG_EVENT, {
      text: truncateStructuredLogValue(line, MAX_HOST_LOG_LENGTH),
      ...metadata,
    });
  }
  reportBoxLogBatch(
    records: Array<{
      kind: string;
      source?: string;
      line?: string;
      event?: Fields;
    }>,
    onEntrySettled: (settlement: "delivered" | "dropped") => void,
  ): void {
    for (const record of records) {
      if (record.kind === "log")
        this.enqueue(
          "info",
          BOX_LOG_EVENT,
          {
            source: record.source,
            text: truncateStructuredLogValue(
              record.line ?? "",
              MAX_HOST_LOG_LENGTH,
            ),
          },
          onEntrySettled,
        );
      else if (record.kind === "infrastructure" && record.event !== undefined)
        this.enqueueBoxInfrastructureEvent(
          record.event as Parameters<typeof boxInfrastructureTelemetry>[0],
          onEntrySettled,
        );
    }
  }
  reportBoxLogShip(
    r: Parameters<typeof boxLogShipTelemetry>[0],
    onSettled?: (settlement: "delivered" | "dropped") => void,
  ): void {
    const e = boxLogShipTelemetry(r);
    this.enqueue(e.level as LogLevel, e.message, e.metadata, onSettled);
  }
  reportDesktopHealth(level: LogLevel, metadata: Metadata): void {
    this.enqueue(level, DESKTOP_HEALTH_EVENT, metadata);
  }
  reportAgentOpen(report: {
    conversationId: string;
    durationMs: number;
    entryCount: number;
    wasActive: boolean;
  }): void {
    this.enqueue("info", AGENT_OPEN_EVENT, {
      conversation_id: report.conversationId,
      duration_ms: String(report.durationMs),
      entry_count: String(report.entryCount),
      was_active: String(report.wasActive),
    });
  }
  reportHostCrash(kind: string): void {
    this.enqueue("error", HOST_CRASH_EVENT, { kind });
  }
  async reportHostProcessExitConfirmed(
    marker: HostCrashMarker,
  ): Promise<boolean> {
    return this.transport.shipConfirmed("error", HOST_CRASH_EVENT, {
      ...hostCrashMarkerMetadata(marker),
      error_code: "SAND-E0001",
      error_domain: "registry",
      error_retryable: "false",
    });
  }
  reportInvariantViolation({ name }: { name: string }): void {
    this.enqueue("error", HOST_INVARIANT_VIOLATION_EVENT, { name });
  }
  reportHostUpgrade(metadata: Metadata & { outcome: string }): void {
    this.enqueue(
      metadata.outcome === "failed" ? "warn" : "info",
      HOST_UPGRADE_EVENT,
      metadata,
    );
  }
  async reportHostUpgradeConfirmed(
    metadata: Metadata & { outcome: string },
  ): Promise<boolean> {
    return await this.transport.shipConfirmed(
      metadata.outcome === "failed" ? "warn" : "info",
      HOST_UPGRADE_EVENT,
      metadata,
    );
  }
  reportBoxHelp(report: {
    conversationId: string;
    snapshotCaptured: boolean;
    reason: string;
  }): void {
    this.enqueue("info", BOX_HELP_EVENT, {
      conversation_id: report.conversationId,
      snapshot_captured: String(report.snapshotCaptured),
      "meta.reason": report.reason,
    });
  }
  reportBotBlock(report: {
    conversationId: string;
    family: string;
    confidence: string;
    blockedHost: string;
    blockedUrl: string;
  }): void {
    this.enqueue("warn", BOT_BLOCK_EVENT, {
      conversation_id: report.conversationId,
      family: report.family,
      confidence: report.confidence,
    });
    this.enqueue("warn", BOT_BLOCK_DETAIL_EVENT, {
      conversation_id: report.conversationId,
      family: report.family,
      blocked_host: report.blockedHost,
      blocked_url: report.blockedUrl,
    });
  }
  emitTurnEvent(event: string, metadata: Metadata): void {
    this.enqueue("info", event, metadata);
  }
  setFlushTickListener(listener?: () => void): void {
    this.transport.setFlushTickListener(listener);
  }
  async dispose(): Promise<void> {
    await this.transport.dispose();
  }
  enqueue(
    level: LogLevel,
    message: string,
    metadata: Record<string, unknown>,
    onSettled?: (settlement: "delivered" | "dropped") => void,
  ): void {
    const clean: Metadata = {};
    for (const [key, value] of Object.entries(metadata))
      if (value !== undefined) clean[key] = String(value);
    this.transport.enqueue(level, message, clean, onSettled);
  }
}
export class SandTurnTelemetryImpl {
  private readonly startedAt = Date.now();
  private model: string | undefined;
  private requestId: string | undefined;
  private startEmitted = false;
  private finalized = false;
  private retryCount = 0;
  private backoffTotalMs = 0;
  private retryCause: string | undefined;
  constructor(
    private readonly telemetry: SandStructuredLogTelemetry,
    private readonly start: {
      conversationId: string;
      turnType: string;
      model?: string;
    },
    private readonly onFinalized: () => void,
  ) {
    this.model = start.model;
    if (this.model !== undefined) this.emitStart();
  }
  noteRetry(report: Record<string, unknown>): void {
    if (this.finalized) return;
    this.retryCount += 1;
    this.backoffTotalMs +=
      typeof report.delayMs === "number" ? report.delayMs : 0;
    if (typeof report.cause === "string") this.retryCause = report.cause;
  }
  setModel(modelId: string): void {
    if (modelId.length === 0) return;
    this.model = modelId;
    this.emitStart();
  }
  setRequestId(requestId: string): void {
    if (this.requestId === undefined && requestId.length > 0)
      this.requestId = requestId;
  }
  finalize(
    outcome: string,
    error?: SandErrorValue,
    detail?: { message: string; stack?: string },
  ): void {
    if (this.finalized) return;
    this.finalized = true;
    this.onFinalized();
    this.emitStart();
    const metadata: Metadata = {
      ...this.baseTags(),
      outcome: error !== undefined ? "error" : outcome,
      duration_ms: String(Date.now() - this.startedAt),
    };
    if (this.retryCount > 0) {
      metadata.retry_count = String(this.retryCount);
      metadata.backoff_total_ms = String(Math.round(this.backoffTotalMs));
      metadata.retry_cause = this.retryCause;
    }
    if (error !== undefined) Object.assign(metadata, sandErrorTags(error));
    this.telemetry.emitTurnEvent(TURN_OUTCOME_EVENT, metadata);
    if (error !== undefined && detail !== undefined)
      this.telemetry.emitTurnEvent(TURN_OUTCOME_DETAIL_EVENT, {
        ...this.baseTags(),
        ...errorDetailTags(error, detail),
      });
  }
  baseTags(): Metadata {
    return {
      turn_type: this.start.turnType,
      conversation_id: this.start.conversationId,
      request_id: this.requestId,
      model_intent: this.model,
    };
  }
  emitStart(): void {
    if (this.startEmitted) return;
    this.startEmitted = true;
    this.telemetry.emitTurnEvent(TURN_START_EVENT, this.baseTags());
  }
}
