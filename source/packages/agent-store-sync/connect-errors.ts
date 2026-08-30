import { Code, ConnectError } from "@connectrpc/connect";

function getAgentStoreConnectCode(error: unknown): number | undefined {
  if (error instanceof ConnectError) return error.code;
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return normalizeConnectCode(error.code);
}

export function isAgentStoreConnectCode(error: unknown, code: number): boolean {
  return getAgentStoreConnectCode(error) === code;
}

export function isAgentStoreMintNegativeCacheable(error: unknown): boolean {
  const code = getAgentStoreConnectCode(error);
  return code === Code.InvalidArgument || code === Code.NotFound || code === Code.FailedPrecondition;
}

export function isAgentStoreSyncDisabledError(error: unknown): boolean {
  if (!messageLooksLikeSyncDisabled(errorMessageOf(error))) return false;
  const code = getAgentStoreConnectCode(error);
  return code === undefined || code === Code.InvalidArgument || code === Code.PermissionDenied;
}

function messageLooksLikeSyncDisabled(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("agent store sync is not enabled") ||
    lower.includes("agent store sync is not available in legacy privacy mode") ||
    lower.includes("private worker agent-store sync is not enabled");
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function normalizeConnectCode(code: unknown): number | undefined {
  if (typeof code === "number" && typeof Code[code] === "string") return code;
  if (typeof code !== "string" || code.length === 0) return undefined;
  for (const value of Object.values(Code)) {
    if (typeof value === "number" && Code[value] === code) return value;
  }
  return undefined;
}
