export const LONG_RUNNING_TOOL_NAMES = new Set(["task", "mcp_task", "subagent"]);
export const EXTRA_SHORT_TOOL_TIMEOUT_MS = 5 * 60 * 1_000;
export const SHORT_TOOL_TIMEOUT_MS = 15 * 60 * 1_000;
export const MEDIUM_TOOL_TIMEOUT_MS = 30 * 60 * 1_000;
export const LONG_TOOL_TIMEOUT_MS = 60 * 60 * 1_000;
export const EXTRA_LONG_TOOL_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
export const BACKGROUND_SHELL_DEFAULT_BLOCK_UNTIL_MS = 10 * 60 * 1_000;

export class FusedStepGuardTimeoutError extends Error {
  readonly fuseGuardMs: number;
  constructor(fuseGuardMs: number) {
    super(`Fused model/tool step exceeded guard timeout after ${Math.round(fuseGuardMs / 1_000)} seconds`);
    this.name = "FusedStepGuardTimeoutError";
    this.fuseGuardMs = fuseGuardMs;
  }
}
export function isFusedStepGuardTimeoutReason(reason: unknown): reason is FusedStepGuardTimeoutError {
  return reason instanceof FusedStepGuardTimeoutError || (reason instanceof Error && reason.name === "FusedStepGuardTimeoutError" && "fuseGuardMs" in reason && typeof reason.fuseGuardMs === "number");
}
const TIMEOUT_BUFFER_MS = 60 * 1_000;
export const TOOL_CALL_TIMEOUT_TIERS_MS = [EXTRA_SHORT_TOOL_TIMEOUT_MS, SHORT_TOOL_TIMEOUT_MS, MEDIUM_TOOL_TIMEOUT_MS, LONG_TOOL_TIMEOUT_MS, EXTRA_LONG_TOOL_TIMEOUT_MS];
const TOOL_CALL_GUARD_HEADROOM_MS = 60 * 1_000;
const TOOL_CALL_GUARD_BLOCK_GRACE_MS = 30 * 1_000;
export function parseBlockUntilMs(args: unknown): number | undefined {
  if (args === null || args === undefined) return undefined;
  let parsed: unknown;
  if (typeof args === "string") { try { parsed = JSON.parse(args); } catch { return undefined; } } else parsed = args;
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const raw = (parsed as Record<string, unknown>)["block_until_ms"];
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}
export function isSubagentToolName(toolName: string): boolean { return LONG_RUNNING_TOOL_NAMES.has(toolName.toLowerCase()); }
export function suggestedToolTimeoutMs(toolName: string, args: unknown): number {
  if (isSubagentToolName(toolName)) return LONG_TOOL_TIMEOUT_MS;
  const blockMs = parseBlockUntilMs(args);
  return blockMs === undefined ? SHORT_TOOL_TIMEOUT_MS : Math.max(0, blockMs + TIMEOUT_BUFFER_MS);
}
export function pickToolCallTimeoutTierMs(suggestedMs: number): number {
  return TOOL_CALL_TIMEOUT_TIERS_MS.find((tierMs) => tierMs >= suggestedMs) ?? EXTRA_LONG_TOOL_TIMEOUT_MS;
}
export function toolCallExecutionGuardMs(toolName: string, args: unknown): number {
  const tierMs = pickToolCallTimeoutTierMs(suggestedToolTimeoutMs(toolName, args));
  const tierHeadroomMs = tierMs - TOOL_CALL_GUARD_HEADROOM_MS;
  const blockMs = parseBlockUntilMs(args);
  if (blockMs === undefined) return tierHeadroomMs;
  const requestedMs = Math.max(tierHeadroomMs, blockMs + TOOL_CALL_GUARD_BLOCK_GRACE_MS);
  return requestedMs >= tierMs ? tierHeadroomMs : requestedMs;
}
export function buildToolCallExecutionTimedOutMessage({ toolName, executionTimeoutMs }: { toolName: string; executionTimeoutMs: number }): string {
  const shellHint = toolName.toLowerCase() === "shell" ? " For long-running commands, re-run with block_until_ms set to a small value (or 0) so the command runs in the background, then poll its output instead of blocking on it." : "";
  return executionTimeoutMs === 0
    ? `The ${toolName} tool call could not start because activity setup exceeded the per-call time limit. The execution environment may be slow or overloaded.${shellHint}`
    : `The ${toolName} tool call timed out after ${Math.round(executionTimeoutMs / 1_000)} seconds and was terminated. The execution environment may be unresponsive, or the operation needs longer than the per-call time limit.${shellHint}`;
}
