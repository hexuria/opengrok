import type { MethodInfoUnary } from "@bufbuild/protobuf";
import { DashboardService } from "../../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import {
  RecordSandAuditEventsRequest,
  type RecordSandAuditEventsResponse,
  SandAuditEvent,
  SandAuditEvent_BrowserNavigation,
  SandAuditEvent_ComputerUseSession,
  SandAuditEvent_McpToolCall,
  SandAuditEvent_ShellCommand
} from "../../../packages/proto/generated/aiserver/v1/dashboard_pb.js";
import { createSandCursorBackendClient } from "../../../shared/node/cursor-backend/cursor-inference.js";
import type { AuditEvent } from "./action-audit-service.js";

const rounded = (value: number) => BigInt(Math.max(0, Math.round(value)));

export function toProtoAuditEventData(event: AuditEvent): SandAuditEvent {
  const action = event.action;
  const base = {
    eventId: event.eventId,
    occurredAtMs: rounded(event.occurredAtMs),
    agentId: event.agentId,
    turnId: event.turnId,
    boxId: event.boxId
  };
  switch (action.kind) {
    case "mcpToolCall":
      return new SandAuditEvent({
        ...base,
        action: {
          case: "mcpToolCall",
          value: new SandAuditEvent_McpToolCall({
            toolCallId: action.toolCallId,
            serverIdentifier: action.serverIdentifier,
            serverName: action.serverName!,
            toolName: action.toolName,
            status: action.status,
            durationMs: rounded(action.durationMs)
          })
        }
      });
    case "shellCommand": {
      const allowed = action.allowed ?? true;
      return new SandAuditEvent({
        ...base,
        action: {
          case: "shellCommand",
          value: new SandAuditEvent_ShellCommand({
            command: action.command,
            kind: action.shellKind,
            target: action.target,
            allowed,
            blockedReason: allowed ? "" : action.blockedReason ?? "",
            classificationReasons: [...action.classificationReasons ?? []]
          })
        }
      });
    }
    case "browserNavigation":
      return new SandAuditEvent({
        ...base,
        action: {
          case: "browserNavigation",
          value: new SandAuditEvent_BrowserNavigation({ url: action.url, pageTitle: action.pageTitle })
        }
      });
    case "computerUseSession": {
      const actionCounts: Record<string, bigint> = {};
      for (const [kind, count] of Object.entries(action.actionCounts)) actionCounts[kind] = rounded(count);
      return new SandAuditEvent({
        ...base,
        action: {
          case: "computerUseSession",
          value: new SandAuditEvent_ComputerUseSession({
            toolCallId: action.toolCallId ?? "",
            actionCount: rounded(action.actionCount),
            actionCounts,
            durationMs: rounded(action.durationMs),
            screenshotCount: rounded(action.screenshotCount)
          })
        }
      });
    }
  }
}

export function createSandAuditBatchSender(deps: {
  readonly getAccessToken: (options: { readonly backendUrl: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>;
}): (events: readonly AuditEvent[]) => Promise<void> {
  const service = DashboardService as typeof DashboardService & {
    readonly methods: typeof DashboardService.methods & {
      readonly recordSandAuditEvents: MethodInfoUnary<RecordSandAuditEventsRequest, RecordSandAuditEventsResponse>;
    };
  };
  const client = createSandCursorBackendClient(service, {
    getAccessToken: deps.getAccessToken,
    getMachineId: deps.getMachineId
  });
  return async (events) => {
    if (events.length === 0) return;
    await client.recordSandAuditEvents(new RecordSandAuditEventsRequest({ events: events.map(toProtoAuditEventData) }));
  };
}
