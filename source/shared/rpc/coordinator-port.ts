export const COORDINATOR_PROTOCOL_VERSION = 1;
export const COORDINATOR_UNKNOWN_METHOD = "unknown-method";
export const COORDINATOR_CANCELLED = "cancelled";

export type CoordinatorFailure = { code: string; message: string; transportKind?: string };
export type CoordinatorReplyOutcome = { status: "ok"; value: unknown } | { status: "failed"; failure: CoordinatorFailure };
export type CoordinatorFrame =
  | { kind: "lifecycle"; phase: "hello" | "ready"; protocolVersion: number }
  | { kind: "lifecycle"; phase: "shutdown"; reason: "requested" | "protocol-error"; detail: string | null }
  | { kind: "request"; requestId: string; method: string; args: unknown }
  | { kind: "cancel"; requestId: string }
  | { kind: "reply"; requestId: string; outcome: CoordinatorReplyOutcome }
  | { kind: "event"; family: string; payload: unknown };

export type CoordinatorFrameParseResult =
  | { accepted: true; frame: CoordinatorFrame }
  | { accepted: false; rejection: { code: "malformed-frame"; detail: string } };

function reject(detail: string): CoordinatorFrameParseResult {
  return { accepted: false, rejection: { code: "malformed-frame", detail } };
}

function accept(frame: CoordinatorFrame): CoordinatorFrameParseResult {
  return { accepted: true, frame };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseCoordinatorFrame(value: unknown): CoordinatorFrameParseResult {
  if (!isRecord(value)) return reject("frame must be an object");
  switch (value.kind) {
    case "lifecycle":
      return parseLifecycle(value);
    case "request": {
      if (!isNonEmptyString(value.requestId)) return reject("request.requestId must be a non-empty string");
      if (!isNonEmptyString(value.method)) return reject("request.method must be a non-empty string");
      if (!("args" in value)) return reject("request.args is missing");
      return accept({ kind: "request", requestId: value.requestId, method: value.method, args: value.args });
    }
    case "cancel":
      if (!isNonEmptyString(value.requestId)) return reject("cancel.requestId must be a non-empty string");
      return accept({ kind: "cancel", requestId: value.requestId });
    case "reply": {
      if (!isNonEmptyString(value.requestId)) return reject("reply.requestId must be a non-empty string");
      const outcome = parseReplyOutcome(value.outcome);
      if (outcome == null) return reject("reply.outcome is not a valid outcome");
      return accept({ kind: "reply", requestId: value.requestId, outcome });
    }
    case "event":
      if (!isNonEmptyString(value.family)) return reject("event.family must be a non-empty string");
      if (!("payload" in value)) return reject("event.payload is missing");
      return accept({ kind: "event", family: value.family, payload: value.payload });
    default:
      return reject("frame.kind must be lifecycle, request, cancel, reply, or event");
  }
}

function parseLifecycle(value: Record<string, unknown>): CoordinatorFrameParseResult {
  switch (value.phase) {
    case "hello":
    case "ready":
      if (typeof value.protocolVersion !== "number") return reject(`lifecycle.${value.phase}.protocolVersion must be a number`);
      return accept({ kind: "lifecycle", phase: value.phase, protocolVersion: value.protocolVersion });
    case "shutdown": {
      if (value.reason !== "requested" && value.reason !== "protocol-error") return reject("lifecycle.shutdown.reason must be requested or protocol-error");
      if (value.reason === "protocol-error") {
        if (typeof value.detail !== "string" || value.detail.length === 0) return reject("lifecycle.shutdown.detail must name the breach for a protocol-error shutdown");
      } else if (value.detail !== null) return reject("lifecycle.shutdown.detail must be null for a requested shutdown");
      return accept({ kind: "lifecycle", phase: "shutdown", reason: value.reason, detail: value.detail as string | null });
    }
    default:
      return reject("lifecycle.phase must be hello, ready, or shutdown");
  }
}

function parseReplyOutcome(value: unknown): CoordinatorReplyOutcome | null {
  if (!isRecord(value)) return null;
  if (value.status === "ok") return "value" in value ? { status: "ok", value: value.value } : null;
  if (value.status !== "failed" || !isRecord(value.failure)) return null;
  const { code, message, transportKind } = value.failure;
  if (!isNonEmptyString(code) || typeof message !== "string") return null;
  return { status: "failed", failure: { code, message, ...(isNonEmptyString(transportKind) ? { transportKind } : {}) } };
}

export interface CoordinatorBootstrap {
  processConfig: { appVersion: string; isPackaged: boolean; dataDir: string };
}

export type CoordinatorBootstrapParseResult =
  | { accepted: true; bootstrap: CoordinatorBootstrap }
  | { accepted: false; rejection: { code: "malformed-frame"; detail: string } };

export function parseCoordinatorBootstrap(value: unknown): CoordinatorBootstrapParseResult {
  const rejectField = (detail: string): CoordinatorBootstrapParseResult => ({ accepted: false, rejection: { code: "malformed-frame", detail } });
  if (!isRecord(value) || !isRecord(value.processConfig)) return rejectField("bootstrap.processConfig must be an object");
  const { appVersion, isPackaged, dataDir } = value.processConfig;
  if (!isNonEmptyString(appVersion)) return rejectField("bootstrap.processConfig.appVersion must be a non-empty string");
  if (typeof isPackaged !== "boolean") return rejectField("bootstrap.processConfig.isPackaged must be a boolean");
  if (!isNonEmptyString(dataDir)) return rejectField("bootstrap.processConfig.dataDir must be a non-empty string");
  return { accepted: true, bootstrap: { processConfig: { appVersion, isPackaged, dataDir } } };
}

export const COORDINATOR_TRANSPORT_STATE_FAMILY = "coordinator-transport-state";
/** "Are reads live or stale": the coordinator's read cache speaks on it. Never the transport state, which gates sends. */
export const COORDINATOR_SERVER_READS_FAMILY = "coordinator-server-reads";
export const COORDINATOR_CONTROL_CHANNEL = "coordinator-control";
export const COORDINATOR_MAIN_DATA_CHANNEL = "coordinator-main-data";

export function asCoordinatorControlEnvelope(value: unknown): { channel: typeof COORDINATOR_CONTROL_CHANNEL; frame: unknown } | null {
  if (!isRecord(value) || value.channel !== COORDINATOR_CONTROL_CHANNEL || !("frame" in value)) return null;
  return { channel: COORDINATOR_CONTROL_CHANNEL, frame: value.frame };
}

export function asCoordinatorMainDataEnvelope(value: unknown): { channel: typeof COORDINATOR_MAIN_DATA_CHANNEL; frame: unknown } | null {
  if (!isRecord(value) || value.channel !== COORDINATOR_MAIN_DATA_CHANNEL || !("frame" in value)) return null;
  return { channel: COORDINATOR_MAIN_DATA_CHANNEL, frame: value.frame };
}
