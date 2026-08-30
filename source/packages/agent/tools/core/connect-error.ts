import { Code, ConnectError } from "@connectrpc/connect";

import { ErrorDetails, ErrorDetails_Error } from "../../../proto/generated/aiserver/v1/utils_pb.js";
import {
  CustomToolCallError,
  RetryableToolEnvironmentOrchestrationError,
  ToolCallAbortedError,
} from "../common.js";
import { ToolErrorClassification } from "../core.js";

const AGENT_STREAM_START_TIMEOUT_TITLE = "Workspace Disconnected";
const AGENT_STREAM_START_TIMEOUT_DETAIL = "Cursor lost connection to the workspace while starting tool execution. Reload the window and try again.";
const AGENT_STREAM_START_TIMEOUT_ERROR_NAME = "AgentExecStreamStartTimeoutError";

export function maybeNormalizeExecBoundaryError(error: unknown): unknown {
  if (error instanceof Error && error.message.includes("signal is aborted without reason")) {
    const normalized = new ToolCallAbortedError();
    setErrorCause(normalized, error);
    return normalized;
  }
  if (isExecBackendUnavailableError(error)) {
    const normalized = new CustomToolCallError(ToolErrorClassification.EXEC_BACKEND_UNAVAILABLE, {
      clientVisibleErrorMessage: "The execution backend is unavailable. The extension host may have disconnected or stopped responding.",
      modelVisibleErrorMessage: "Execution backend unavailable. Do not retry tool calls — the execution environment is down. Inform the user and stop.",
      error: "Execution backend unavailable",
    });
    setErrorCause(normalized, error);
    return normalized;
  }
  if (isPodNotFoundExecBoundaryError(error) || isExecDaemonUnreachableExecBoundaryError(error) || isBridgeTransportClosedExecBoundaryError(error) || isEnvironmentUnreachableMessageError(error)) {
    return new RetryableToolEnvironmentOrchestrationError("The execution environment has become unreachable.", { cause: error });
  }
  const code = getConnectErrorCode(error);
  if (code === undefined) return error;
  let message: string;
  let classification: ToolErrorClassification;
  switch (code) {
    case Code.DeadlineExceeded:
      message = "Tool failed; this may be temporary. Try again.";
      classification = ToolErrorClassification.OTHER_ERROR;
      break;
    case Code.ResourceExhausted:
      if (shouldUseRateLimitMessage(error)) {
        message = "Service is currently rate limited. This may be temporary; try again.";
        classification = ToolErrorClassification.PROVIDER_ERROR;
      } else {
        message = "Tool failed; this may be temporary. Try again.";
        classification = ToolErrorClassification.OTHER_ERROR;
      }
      break;
    case Code.Unavailable:
      message = "Service temporarily unavailable. This may be temporary; try again.";
      classification = ToolErrorClassification.OTHER_ERROR;
      break;
    case Code.NotFound:
      message = "Requested resource was not found. Check model selection and access.";
      classification = ToolErrorClassification.OTHER_ERROR;
      break;
    case Code.Canceled:
    case Code.Aborted:
      message = "Aborted";
      classification = ToolErrorClassification.ABORTED;
      break;
    default:
      message = "Tool failed; this may be temporary. Try again.";
      classification = ToolErrorClassification.OTHER_ERROR;
  }
  const normalized = new CustomToolCallError(classification, { clientVisibleErrorMessage: message, modelVisibleErrorMessage: message, error: message });
  setErrorCause(normalized, error);
  return normalized;
}

export function maybeCreateAgentStreamStartTimeoutTurnError(error: unknown): ConnectError | undefined {
  if (!isAgentStreamStartTimeoutError(error)) return undefined;
  return new ConnectError(AGENT_STREAM_START_TIMEOUT_TITLE, Code.DeadlineExceeded, undefined, [
    new ErrorDetails({
      error: ErrorDetails_Error.EXTENSION_HOST_TIMEOUT,
      details: { title: AGENT_STREAM_START_TIMEOUT_TITLE, detail: AGENT_STREAM_START_TIMEOUT_DETAIL, isRetryable: false, shouldShowImmediateError: true },
    }),
  ], error instanceof Error ? error : undefined);
}

function isPodNotFoundExecBoundaryError(error: unknown): boolean { return collectErrorText(error).some(text => text.toLowerCase().includes("object not found: pod")); }
function isExecDaemonUnreachableExecBoundaryError(error: unknown): boolean { return collectErrorText(error).some(text => text.toLowerCase().includes("exec-daemon is unreachable")); }
function isBridgeTransportClosedExecBoundaryError(error: unknown): boolean { return collectErrorText(error).some(text => text.toLowerCase().includes("bridge transport is closed")); }
function isEnvironmentUnreachableMessageError(error: unknown): boolean { return collectErrorText(error).some(text => text.toLowerCase().includes("execution environment has become unreachable")); }

function isExecBackendUnavailableError(error: unknown): boolean {
  if (error instanceof Error && (error.name === "ExecBackendUnavailableError" || error.name === "ControlledExecDisposedError" || error.name === AGENT_STREAM_START_TIMEOUT_ERROR_NAME)) return true;
  if (isAgentStreamStartTimeoutError(error) || isExtensionHostTimeoutConnectError(error) || isLegacyAgentStreamStartTimeoutError(error)) return true;
  return collectErrorText(error).map(text => text.toLowerCase()).some(text => text.includes("mainthreadcursor disposed") || text.includes("agent execution timed out") || text.includes("extension host is not running or is unresponsive") || text.includes("controlledexecdisposederror"));
}

export function isAgentStreamStartTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === AGENT_STREAM_START_TIMEOUT_ERROR_NAME;
}

export function isAgentStreamStartTimeoutRecoveryTurnError(error: unknown): boolean {
  if (isAgentStreamStartTimeoutError(error)) return true;
  if (!(error instanceof ConnectError) || error.code !== Code.DeadlineExceeded) return false;
  return error.findDetails(ErrorDetails).some(detail => detail.error === ErrorDetails_Error.EXTENSION_HOST_TIMEOUT && detail.details?.title === AGENT_STREAM_START_TIMEOUT_TITLE);
}

function isExtensionHostTimeoutConnectError(error: unknown): boolean {
  return error instanceof ConnectError && error.findDetails(ErrorDetails).some(detail => detail.error === ErrorDetails_Error.EXTENSION_HOST_TIMEOUT);
}
function isLegacyAgentStreamStartTimeoutError(error: unknown): boolean { return collectErrorText(error).some(text => text.toLowerCase().includes("agent stream start timeout")); }
function setErrorCause(target: Error, cause: unknown): void { target.cause = cause; }
function shouldUseRateLimitMessage(error: unknown): boolean {
  const texts = collectErrorText(error).map(text => text.toLowerCase());
  return texts.length > 0 && texts.some(text => text.includes("resource exhausted") || text.includes("high load") || text.includes("rate limit") || text.includes("rate-limited") || text.includes("too many requests") || text.includes("overloaded") || text.includes("overload") || text.includes("econnreset"));
}

function collectErrorText(error: unknown): string[] {
  const texts: string[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof Error) {
      texts.push(current.message);
      if (current.cause !== undefined) queue.push(current.cause);
    }
    if (current instanceof ConnectError) {
      if (typeof current.rawMessage === "string") texts.push(current.rawMessage);
      for (const detail of current.findDetails(ErrorDetails)) {
        if (typeof detail.details?.title === "string") texts.push(detail.details.title);
        if (typeof detail.details?.detail === "string") texts.push(detail.details.detail);
      }
    }
  }
  return texts.filter(text => text.length > 0);
}

const CONNECT_CODE_BY_NAME = new Map<string, Code>(Array.from(Object.values(Code).filter((value): value is Code => typeof value === "number")).map(code => {
  const name = Code[code];
  const snake = typeof name === "string" ? name[0]!.toLowerCase() + name.substring(1).replace(/[A-Z]/g, character => `_${character.toLowerCase()}`) : String(code);
  return [snake, code];
}));

export function getConnectErrorCode(error: unknown): Code | undefined {
  if (!(error instanceof Error)) return undefined;
  const messageMatch = /^\[([a-z_]+)\](?:\s|$)/.exec(error.message);
  if (messageMatch) return CONNECT_CODE_BY_NAME.get(messageMatch[1]!);
  const stackMatch = typeof error.stack === "string" ? /(?:^|\n)\s*ConnectError:\s*\[([a-z_]+)\](?:\s|$)/.exec(error.stack) : null;
  if (stackMatch) return CONNECT_CODE_BY_NAME.get(stackMatch[1]!);
  const loweredTexts = collectErrorText(error).map(text => text.toLowerCase());
  if (loweredTexts.some(text => text.includes("user aborted request"))) return Code.Aborted;
  if (loweredTexts.some(text => text === "canceled" || text.includes("request canceled") || text.includes("request cancelled"))) return Code.Canceled;
  return undefined;
}
