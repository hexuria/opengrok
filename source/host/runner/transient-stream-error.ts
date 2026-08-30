export const TRANSIENT_ERRNO_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNABORTED", "ECONNREFUSED", "ENETRESET", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN"]);
export const TRANSIENT_MESSAGE_TOKENS = ["econnreset", "etimedout", "epipe", "econnaborted", "econnrefused", "enetreset", "enetunreach", "ehostunreach", "socket hang up", "premature close", "stream closed", "closed stream", "connection reset", "connection closed", "connection terminated", "network error", "the operation was aborted", "[aborted]", "[unavailable]", "[deadline_exceeded]"];

interface ErrorLike { readonly code?: unknown; readonly message?: unknown; readonly cause?: unknown; readonly errors?: unknown; readonly name?: unknown; readonly reason?: unknown; readonly isStepRetriesExhausted?: unknown; readonly isConversationTooLarge?: unknown; readonly isTranscriptAppendAfterCheckpointError?: unknown; readonly retryable?: unknown; readonly terminal?: unknown; readonly displayInfo?: unknown; readonly metadata?: unknown }
function asErrorLike(value: unknown): ErrorLike | null { return typeof value === "object" && value != null ? value : null; }
function children(error: ErrorLike): unknown[] { return [error.cause, ...(Array.isArray(error.errors) ? error.errors : [])].filter((value) => value != null); }
function visit(error: unknown, predicate: (value: ErrorLike) => boolean, seen = new Set<unknown>()): boolean {
  const value = asErrorLike(error);
  if (value == null || seen.has(value)) return false;
  seen.add(value);
  return predicate(value) || children(value).some((child) => visit(child, predicate, seen));
}

export function messageLooksTransient(message: string): boolean { const lower = message.toLowerCase(); return TRANSIENT_MESSAGE_TOKENS.some((token) => lower.includes(token)); }
export function isTransientStreamError(error: unknown): boolean {
  if (typeof error === "string") return messageLooksTransient(error);
  return visit(error, (value) => typeof value.code === "string" && TRANSIENT_ERRNO_CODES.has(value.code.toUpperCase()) || typeof value.message === "string" && messageLooksTransient(value.message));
}
export function isConversationTooLargeRefusal(error: unknown): boolean { return visit(error, (value) => value.isConversationTooLarge === true); }
export function isContextOverflowDeadEnd(error: unknown): boolean {
  return visit(error, (value) => value.name === "InputTokenLimitError" || ((value.isStepRetriesExhausted === true || value.name === "StepRetriesExhaustedError") && value.reason === "summarization-retries"));
}
export function isRetryableProviderError(error: unknown): boolean {
  if (isContextOverflowDeadEnd(error) || isConversationTooLargeRefusal(error)) return false;
  const retryable = isTransientStreamError(error) || visit(error, (value) => value.retryable === true);
  if (!retryable) return false;
  return !visit(error, (value) => value.terminal === true || value.name === "NonRetriableError" || value.name === "ActionRequiredError");
}
export function isProviderCapacityError(error: unknown): boolean {
  if (!isRetryableProviderError(error)) return false;
  return visit(error, (value) => {
    if (typeof value.displayInfo !== "object" || value.displayInfo == null) return false;
    const info = value.displayInfo as Record<string, unknown>;
    return info.connectCode === "Unavailable" || info.connectCode === 14 || (info.connectCode === "ResourceExhausted" || info.connectCode === 8) && (info.errorCode === "RESOURCE_EXHAUSTED" || info.errorCode === 8);
  });
}

export class FirstTokenStallError extends Error {
  readonly isFirstTokenStall = true;
  constructor(deadlineMs: number) { super(`The model provider did not start responding within ${Math.round(deadlineMs / 1_000)}s.`); this.name = "FirstTokenStallError"; }
}
export function isFirstTokenStallError(error: unknown): boolean { return error instanceof FirstTokenStallError || asErrorLike(error)?.name === "FirstTokenStallError" || (asErrorLike(error) as { isFirstTokenStall?: unknown } | null)?.isFirstTokenStall === true; }
export function shouldRetryTurnAttempt(input: { canceled: boolean; error: unknown; streamOutputProduced: boolean; resumeCheckpointAvailable: boolean; automationIsRetryable?: (error: unknown) => boolean }): boolean {
  if (input.canceled || asErrorLike(input.error)?.isTranscriptAppendAfterCheckpointError === true) return false;
  const safe = !input.streamOutputProduced || input.resumeCheckpointAvailable;
  if (safe && (isRetryableProviderError(input.error) || isFirstTokenStallError(input.error))) return true;
  return input.automationIsRetryable?.(input.error) ?? false;
}

export function computeBackoffDelayMs(params: { attempt: number; baseDelayMs: number; maxDelayMs: number; random?: () => number }): number {
  const random = params.random ?? Math.random, base = Math.max(0, params.baseDelayMs), cap = Math.max(base, params.maxDelayMs);
  const exponential = Math.min(cap, base * 2 ** Math.max(0, params.attempt - 1));
  return Math.min(cap, Math.round(exponential / 2 + random() * exponential / 2));
}
export const MAX_SERVER_RETRY_AFTER_MS = 30_000;
export function computeServerPacedDelayMs(params: { retryAfterMs: number; random?: () => number }): number { return Math.min(Math.round(params.retryAfterMs + (params.random ?? Math.random)() * params.retryAfterMs / 2), MAX_SERVER_RETRY_AFTER_MS); }
export function serverRetryAfterMsFromError(error: unknown): number | undefined {
  let found: number | undefined;
  visit(error, (value) => {
    const metadata = value.metadata;
    let raw: unknown;
    if (metadata instanceof Map) raw = metadata.get("retry-after");
    else if (typeof metadata === "object" && metadata != null && "get" in metadata && typeof metadata.get === "function") raw = (metadata.get as (key: string) => unknown)("retry-after");
    if (raw == null || raw === "") return false;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) found = Math.min(Math.round(seconds * 1_000), MAX_SERVER_RETRY_AFTER_MS);
    return found != null;
  });
  return found;
}

export interface RetryPolicy {
  readonly maxAttempts: number; readonly baseDelayMs: number; readonly maxDelayMs: number;
  readonly isRetryable?: (error: unknown) => boolean; readonly sleep?: (delayMs: number) => Promise<void>; readonly random?: () => number;
  readonly onRetry?: (info: { attempt: number; delayMs: number; serverPaced: boolean; error: unknown }) => void;
}
export async function runWithTransientRetry<T>(run: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts));
  for (let attempt = 1; ; attempt += 1) {
    try { return await run(); } catch (error) {
      if (attempt >= maxAttempts || !(policy.isRetryable ?? isTransientStreamError)(error)) throw error;
      const server = serverRetryAfterMsFromError(error);
      const delayMs = server == null ? computeBackoffDelayMs({ attempt, baseDelayMs: policy.baseDelayMs, maxDelayMs: policy.maxDelayMs, ...(policy.random == null ? {} : { random: policy.random }) }) : computeServerPacedDelayMs({ retryAfterMs: server, ...(policy.random == null ? {} : { random: policy.random }) });
      policy.onRetry?.({ attempt, delayMs, serverPaced: server != null, error });
      await (policy.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delayMs);
    }
  }
}

export const DEFAULT_AUTOMATION_STREAM_RETRY_MAX_ATTEMPTS = 4;
export const DEFAULT_AUTOMATION_STREAM_RETRY_BASE_DELAY_MS = 1_000;
export const DEFAULT_AUTOMATION_STREAM_RETRY_MAX_DELAY_MS = 15_000;
export const DEFAULT_OVERLOAD_STREAM_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_OVERLOAD_STREAM_RETRY_BASE_DELAY_MS = 750;
export const DEFAULT_OVERLOAD_STREAM_RETRY_MAX_DELAY_MS = 6_000;
export const DEFAULT_FIRST_TOKEN_STALL_DEADLINE_MS = 150_000;
function readIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number { const parsed = Number.parseInt(env[name]?.trim() ?? "", 10); return Number.isFinite(parsed) && parsed >= min ? parsed : fallback; }
export function resolveAutomationStreamRetryPolicy(overrides: Partial<RetryPolicy> = {}, env: NodeJS.ProcessEnv = process.env): RetryPolicy { return { maxAttempts: readIntEnv(env, "SAND_AUTOMATION_STREAM_RETRY_ATTEMPTS", 4, 1), baseDelayMs: readIntEnv(env, "SAND_AUTOMATION_STREAM_RETRY_BASE_MS", 1_000, 0), maxDelayMs: readIntEnv(env, "SAND_AUTOMATION_STREAM_RETRY_MAX_MS", 15_000, 0), ...overrides }; }
export function resolveOverloadStreamRetryPolicy(overrides: Partial<RetryPolicy> = {}, env: NodeJS.ProcessEnv = process.env): RetryPolicy { return { maxAttempts: readIntEnv(env, "SAND_OVERLOAD_STREAM_RETRY_ATTEMPTS", 3, 1), baseDelayMs: readIntEnv(env, "SAND_OVERLOAD_STREAM_RETRY_BASE_MS", 750, 0), maxDelayMs: readIntEnv(env, "SAND_OVERLOAD_STREAM_RETRY_MAX_MS", 6_000, 0), ...overrides }; }
export function resolveFirstTokenStallDeadlineMs(env: NodeJS.ProcessEnv = process.env): number { return readIntEnv(env, "SAND_FIRST_TOKEN_STALL_DEADLINE_MS", DEFAULT_FIRST_TOKEN_STALL_DEADLINE_MS, 0); }
