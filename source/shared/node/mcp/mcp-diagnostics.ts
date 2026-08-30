export interface McpDiagnostic {
  readonly leg: string;
  readonly errorClass: string;
}

const PRE_PIN_BUFFER_CAP = 32;
export const MCP_ERROR_RESULT_CLASS = "mcp_error_result";
export const EXEC_ERROR_CLASS_CAP = 128;

/* @connectrpc/connect 1.6.1 Code, recovered from the immutable host bundle. */
const CONNECT_CODE_NAMES: Readonly<Record<number, string>> = {
  1: "Canceled",
  2: "Unknown",
  3: "InvalidArgument",
  4: "DeadlineExceeded",
  5: "NotFound",
  6: "AlreadyExists",
  7: "PermissionDenied",
  8: "ResourceExhausted",
  9: "FailedPrecondition",
  10: "Aborted",
  11: "OutOfRange",
  12: "Unimplemented",
  13: "Internal",
  14: "Unavailable",
  15: "DataLoss",
  16: "Unauthenticated",
};

let pinnedReporter: ((failure: McpDiagnostic) => void) | null = null;
let buffered: McpDiagnostic[] = [];
const execErrorClassByToolCallId = new Map<string, string>();

export function pinMcpDiagnosticsReporter(reporter: ((failure: McpDiagnostic) => void) | null): void {
  pinnedReporter = reporter;
  const backlog = buffered;
  buffered = [];
  if (reporter == null) return;
  for (const failure of backlog) reporter(failure);
}

function connectErrorCode(error: Error): { readonly matched: true; readonly code: unknown } | undefined {
  return error.name === "ConnectError" && "code" in error
    ? { matched: true, code: Reflect.get(error, "code") }
    : undefined;
}

export function mcpErrorClassOf(error: unknown): string {
  if (error instanceof Error) {
    const connectError = connectErrorCode(error);
    if (connectError !== undefined) {
      const name = typeof connectError.code === "number" ? CONNECT_CODE_NAMES[connectError.code] : undefined;
      return `ConnectError.${String(name)}`;
    }
    return error.name.length > 0 ? error.name : "Error";
  }
  return typeof error;
}

function emitMcpDiagnostic(failure: McpDiagnostic): void {
  if (pinnedReporter != null) {
    pinnedReporter(failure);
    return;
  }
  if (buffered.length >= PRE_PIN_BUFFER_CAP) return;
  buffered.push(failure);
}

export function reportMcpHostEdgeFailure(leg: string, error: unknown): void {
  emitMcpDiagnostic({ leg, errorClass: mcpErrorClassOf(error) });
}

export function reportMcpHostEdgeDegraded(leg: string, errorClass: string): void {
  emitMcpDiagnostic({ leg, errorClass });
}

export function recordMcpExecErrorClass(toolCallId: string, error: unknown): void {
  if (toolCallId.length === 0) return;
  if (execErrorClassByToolCallId.size >= EXEC_ERROR_CLASS_CAP) {
    const oldest = execErrorClassByToolCallId.keys().next().value;
    if (oldest != null) execErrorClassByToolCallId.delete(oldest);
  }
  execErrorClassByToolCallId.set(toolCallId, mcpErrorClassOf(error));
}

export function takeMcpExecErrorClass(toolCallId: string): string {
  const recorded = execErrorClassByToolCallId.get(toolCallId);
  if (recorded === undefined) return MCP_ERROR_RESULT_CLASS;
  execErrorClassByToolCallId.delete(toolCallId);
  return recorded;
}
