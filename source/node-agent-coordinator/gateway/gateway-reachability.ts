import { DeadlineExceededError } from "../../internal/scheduling.js";
import {
  GATEWAY_ACCESS_DENIED_MESSAGE_MARKER,
  GATEWAY_NO_STORAGE_MESSAGE_MARKER,
  hasSandBoxBlockedMarker
} from "../../shared/gateway-reachability.js";
import { findSystemErrno } from "../../shared/system-errno.js";

export type GatewayReachabilityOutcome = "no_storage" | "box_blocked" | "access_denied" | "refused" | "dns" | "timeout" | "network" | "http_5xx";

export class SandGatewayUnreachableError extends Error {
  readonly httpStatus?: number;
  readonly causeSummary?: string;
  readonly attemptedBaseUrl?: string;
  readonly isPreDispatch?: boolean;

  constructor(
    readonly kind: GatewayReachabilityOutcome,
    message: string,
    options?: { cause?: unknown; httpStatus?: number; causeSummary?: string; attemptedBaseUrl?: string; isPreDispatch?: boolean }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SandGatewayUnreachableError";
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options?.causeSummary !== undefined) this.causeSummary = options.causeSummary;
    if (options?.attemptedBaseUrl !== undefined) this.attemptedBaseUrl = options.attemptedBaseUrl;
    if (options?.isPreDispatch !== undefined) this.isPreDispatch = options.isPreDispatch;
  }
}

export function outcomeForHttpStatus(status: number): GatewayReachabilityOutcome | undefined {
  if (status >= 500) return "http_5xx";
  if (status === 401 || status === 403) return "access_denied";
  return undefined;
}

function hasFetchTimeoutSignal(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current != null && typeof current === "object" && !seen.has(current)) {
    if (current instanceof DeadlineExceededError) return true;
    seen.add(current);
    const node = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (typeof node.name === "string" && (node.name === "AbortError" || node.name === "TimeoutError" || /TimeoutError$/.test(node.name))) return true;
    if (typeof node.code === "string" && /TIMEOUT/.test(node.code)) return true;
    current = node.cause;
  }
  return false;
}

function hasMarkerInCauseChain(error: unknown, matches: (message: string) => boolean): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current != null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const node = current as { message?: unknown; cause?: unknown };
    if (typeof node.message === "string" && matches(node.message)) return true;
    current = node.cause;
  }
  return false;
}

export interface GatewayFailureClassification {
  outcome: GatewayReachabilityOutcome;
  causeSummary?: string;
}

export interface GatewayFetchFailureClassification extends GatewayFailureClassification {
  causeSummary: string;
}

export function classifyGatewayFetchFailure(error: unknown): GatewayFetchFailureClassification {
  const errno = findSystemErrno(error);
  const name = error instanceof Error ? error.name : "";
  const causeSummary = [name, errno].filter((part) => part != null && part.length > 0).join("/") || "unknown";
  if (hasMarkerInCauseChain(error, (message) => message.includes(GATEWAY_NO_STORAGE_MESSAGE_MARKER))) return { outcome: "no_storage", causeSummary };
  if (hasMarkerInCauseChain(error, hasSandBoxBlockedMarker)) return { outcome: "box_blocked", causeSummary };
  if (hasMarkerInCauseChain(error, (message) => message.includes(GATEWAY_ACCESS_DENIED_MESSAGE_MARKER))) return { outcome: "access_denied", causeSummary };
  if (errno === "ECONNREFUSED") return { outcome: "refused", causeSummary };
  if (errno === "ENOTFOUND" || errno === "EAI_AGAIN") return { outcome: "dns", causeSummary };
  if (errno === "ETIMEDOUT" || hasFetchTimeoutSignal(error)) return { outcome: "timeout", causeSummary };
  return { outcome: "network", causeSummary };
}

export function classifyStreamDown(input: { clientPaused: boolean; stalled: boolean; forced: boolean; devInducedOffline: boolean; error: unknown }): { reason: string; cause: string | null } {
  if (input.clientPaused) return { reason: "box_blocked", cause: "client-paused" };
  if (input.stalled) return { reason: "stall-timeout", cause: null };
  if (input.forced || input.devInducedOffline) return { reason: "forced-reconnect", cause: input.devInducedOffline ? "dev-induced-offline" : null };
  const classified = classifyGatewayFetchFailure(input.error);
  return { reason: classified.outcome, cause: classified.causeSummary };
}

export function classifyGatewayError(error: unknown): GatewayFailureClassification & { httpStatus?: number } {
  if (error instanceof SandGatewayUnreachableError) {
    return {
      outcome: error.kind,
      ...(error.causeSummary === undefined ? {} : { causeSummary: error.causeSummary }),
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus })
    };
  }
  return classifyGatewayFetchFailure(error);
}

export function classifyBaseUrlKind(baseUrl: string | null | undefined): "unknown" | "loopback" | "pod_proxy" {
  if (baseUrl == null || baseUrl.length === 0) return "unknown";
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]" ? "loopback" : "pod_proxy";
  } catch {
    return "unknown";
  }
}
