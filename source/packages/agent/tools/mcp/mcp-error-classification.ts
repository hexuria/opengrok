import { ToolErrorClassification } from "../core.js";

const MCP_JSON_RPC_ERROR_CODE_REGEX = /MCP error\s*(-\d+):/i;

const MCP_AUTH_ERROR_FRAGMENTS = [
  "requires authentication",
  "invalid refresh token",
  "invalid_grant",
  "unauthorized",
  "authentication failed",
  "oauth token exchange failed",
  "oauth token refresh failed",
  "authentication timed out",
  "authentication required",
  "not authenticated",
  "bad credentials",
  "credential error",
  "invalid_token",
  "invalid token",
  "token is expired",
  "token was revoked",
];

function isMcpAuthErrorMessage(errorMessage: string): boolean {
  const message = errorMessage.toLowerCase();
  return MCP_AUTH_ERROR_FRAGMENTS.some(fragment => message.includes(fragment)) || /\b401\b/.test(message);
}

function parseMcpJsonRpcErrorCode(errorMessage: string): number | undefined {
  const match = errorMessage.match(MCP_JSON_RPC_ERROR_CODE_REGEX);
  if (!match) return undefined;
  const code = Number.parseInt(match[1]!, 10);
  if (Number.isNaN(code)) return undefined;
  return code;
}

const MCP_ENVIRONMENT_ERROR_FRAGMENTS = [
  // Matched by message, not by its -32000 code: servers reuse that code for
  // application errors like rate limits.
  "connection closed",
  "econnrefused",
  "econnreset",
  "enotfound",
  "ehostunreach",
  "enetunreach",
  "epipe",
  "enoent",
  "no local mcp resource executor is configured",
  "unsupported operation:",
  "unsupported exec:",
  "unsupported cursor exec request",
  "did not advertise",
  "failed to reinitialize mcp session",
];

const MCP_TIMEOUT_ERROR_FRAGMENTS = ["connection timed out after", "etimedout"];

function isMcpEnvironmentErrorMessage(errorMessage: string): boolean {
  const message = errorMessage.toLowerCase();
  return MCP_ENVIRONMENT_ERROR_FRAGMENTS.some(fragment => message.includes(fragment));
}

function isMcpTimeoutErrorMessage(errorMessage: string): boolean {
  const message = errorMessage.toLowerCase();
  return MCP_TIMEOUT_ERROR_FRAGMENTS.some(fragment => message.includes(fragment));
}

export function classifyMcpErrorMessage(errorMessage: string): ToolErrorClassification | undefined {
  if (isMcpAuthErrorMessage(errorMessage)) return ToolErrorClassification.MCP_AUTH_ERROR;
  const code = parseMcpJsonRpcErrorCode(errorMessage);
  switch (code) {
    case -32700:
    case -32600:
    case -32602:
      return ToolErrorClassification.INVALID_ARGS;
    case -32601:
      return ToolErrorClassification.UNEXPECTED_ENVIRONMENT;
    case -32001:
      return ToolErrorClassification.TIMEOUT;
  }
  if (isMcpTimeoutErrorMessage(errorMessage)) return ToolErrorClassification.TIMEOUT;
  if (isMcpEnvironmentErrorMessage(errorMessage)) return ToolErrorClassification.UNEXPECTED_ENVIRONMENT;
  if (code === undefined) return undefined;
  return ToolErrorClassification.OTHER_ERROR;
}
