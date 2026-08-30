import { Code } from "@connectrpc/connect";

import { ErrorDetails, ErrorDetails_Error } from "../proto/generated/aiserver/v1/utils_pb.js";
import { findBlobNotFoundError } from "../agent-kv/blob-not-found-error.js";

export interface AgentErrorDisplayInfo {
  readonly title?: string | undefined;
  readonly detail?: string | undefined;
  readonly isRetryable?: boolean | undefined;
  readonly connectCode?: number | undefined;
  readonly errorCode?: ErrorDetails_Error | undefined;
  readonly inferenceRequestErrorType?: string | undefined;
  readonly errorDetails?: ErrorDetails | undefined;
}

export interface AgentErrorOptions {
  readonly cause?: unknown;
  readonly requestId?: string | undefined;
  readonly displayInfo?: AgentErrorDisplayInfo | undefined;
  readonly isTransport?: boolean | undefined;
}

export class AgentError extends Error {
  readonly cause: unknown;
  readonly requestId: string | undefined;
  readonly displayInfo: AgentErrorDisplayInfo | undefined;
  readonly isTransport: boolean | undefined;

  constructor(message: string, options: AgentErrorOptions = {}) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.cause = options.cause;
    this.requestId = options.requestId;
    this.displayInfo = options.displayInfo;
    this.isTransport = options.isTransport;
  }

  get name(): string {
    return (this as AgentError & { readonly kind?: string }).kind as string;
  }
}

export class RetriableError extends AgentError {
  protected get kind(): string {
    return "RetriableError";
  }
}

export class ActionRequiredError extends AgentError {
  readonly action: string;

  constructor(message: string, action: string, options: AgentErrorOptions = {}) {
    super(message, options);
    this.action = action;
  }

  protected get kind(): string {
    return "ActionRequiredError";
  }
}

export class NonRetriableError extends AgentError {
  protected get kind(): string {
    return "NonRetriableError";
  }
}

export class CancelledError extends AgentError {
  protected get kind(): string {
    return "CancelledError";
  }
}

const AUTH_CODES = new Set<ErrorDetails_Error>([
  ErrorDetails_Error.NOT_LOGGED_IN,
  ErrorDetails_Error.AGENT_REQUIRES_LOGIN,
  ErrorDetails_Error.AUTH_TOKEN_NOT_FOUND,
  ErrorDetails_Error.AUTH_TOKEN_EXPIRED,
  ErrorDetails_Error.INVALID_AUTH_ID,
  ErrorDetails_Error.UNAUTHORIZED,
  ErrorDetails_Error.GITHUB_NO_USER_CREDENTIALS,
  ErrorDetails_Error.GITHUB_USER_NO_ACCESS,
]);
const UPGRADE_CODES = new Set<ErrorDetails_Error>([
  ErrorDetails_Error.FREE_USER_USAGE_LIMIT,
  ErrorDetails_Error.FREE_USER_RATE_LIMIT_EXCEEDED,
  ErrorDetails_Error.PRO_USER_ONLY,
  ErrorDetails_Error.PRO_USER_USAGE_LIMIT,
  ErrorDetails_Error.PRO_USER_RATE_LIMIT_EXCEEDED,
  ErrorDetails_Error.RATE_LIMITED,
  ErrorDetails_Error.RATE_LIMITED_CHANGEABLE,
  ErrorDetails_Error.GENERIC_RATE_LIMIT_EXCEEDED,
]);
const PAYMENT_CODES = new Set<ErrorDetails_Error>([
  ErrorDetails_Error.USAGE_PRICING_REQUIRED,
  ErrorDetails_Error.USAGE_PRICING_REQUIRED_CHANGEABLE,
]);
const CONFIG_CODES = new Set<ErrorDetails_Error>([
  ErrorDetails_Error.BAD_API_KEY,
  ErrorDetails_Error.BAD_USER_API_KEY,
  ErrorDetails_Error.OUTDATED_CLIENT,
]);
const CANCELLED_CODES = new Set<ErrorDetails_Error>([
  ErrorDetails_Error.USER_ABORTED_REQUEST,
  ErrorDetails_Error.DEBOUNCED,
]);
const TERMINAL_MESSAGE_CODES = new Set<ErrorDetails_Error>([ErrorDetails_Error.CUSTOM_MESSAGE]);
const TRANSPORT_PATTERNS = [
  "NGHTTP2",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "socket hang up",
  "Premature close",
  "ERR_STREAM",
  "protocol error",
  "http/2 stream",
  "ERR_HTTP2_SESSION_ERROR",
  "Session closed with error code",
  "connection aborted",
] as const;
const NETWORK_ERRNO_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "ENODATA",
  "ESERVFAIL",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
]);
const NETWORK_ERRNO_RE = new RegExp(`\\b(${[...NETWORK_ERRNO_CODES].join("|")})\\b`);
const INFERENCE_REQUEST_ERROR_TYPE_HEADER = "x-cursor-inference-request-error-type";

interface ConnectErrorLike {
  readonly name: string;
  readonly code: number;
  readonly message: string;
  readonly metadata: { get(name: string): string | null };
  readonly cause?: unknown;
  findDetails(type: typeof ErrorDetails): readonly ErrorDetails[];
}

export function classifyError(error: unknown, options: { readonly requestId?: string } = {}): AgentError {
  const { requestId } = options;
  if (error instanceof AgentError) return error;
  if (isConnectError(error)) return classifyConnectError(error, requestId);
  const blobNotFound = findBlobNotFoundError(error);
  if (blobNotFound !== undefined) {
    return new NonRetriableError(blobNotFound.message, {
      cause: error instanceof Error ? error : undefined,
      requestId,
      displayInfo: {
        title: "Conversation data missing",
        detail: blobNotFound.message,
        isRetryable: false,
      },
    });
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return new CancelledError(error.message, { cause: error, requestId });
    if (matchesTransportPattern(error)) return new RetriableError(error.message, { cause: error, requestId });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new RetriableError(message, { cause: error instanceof Error ? error : undefined, requestId });
}

function isConnectError(error: unknown): error is ConnectErrorLike {
  return error !== null && typeof error === "object" && "code" in error && "name" in error && error.name === "ConnectError";
}

function classifyConnectError(error: ConnectErrorLike, requestId: string | undefined): AgentError {
  const details = getErrorDetails(error);
  const displayInfo: AgentErrorDisplayInfo = {
    title: details?.details?.title,
    detail: details?.details?.detail,
    isRetryable: details?.details?.isRetryable,
    connectCode: error.code,
    errorCode: details?.error,
    inferenceRequestErrorType: error.metadata.get(INFERENCE_REQUEST_ERROR_TYPE_HEADER) ?? undefined,
    errorDetails: details,
  };
  const options: AgentErrorOptions = { cause: error, requestId, displayInfo };
  if (error.code === Code.Canceled || error.code === Code.Aborted) {
    if (matchesTransportPattern(error)) return new RetriableError(error.message, options);
    return new CancelledError(error.message, options);
  }
  if (details?.error !== undefined) {
    const code = details.error;
    if (CANCELLED_CODES.has(code)) return new CancelledError(extractMessage(error, details), options);
    const backendAction = details.details?.analyticsMetadata?.actionRequired;
    if (backendAction !== undefined && backendAction !== "") return new ActionRequiredError(extractMessage(error, details), backendAction, options);
    if (AUTH_CODES.has(code)) return new ActionRequiredError(extractMessage(error, details), "login", options);
    if (UPGRADE_CODES.has(code)) return new ActionRequiredError(extractMessage(error, details), "upgrade", options);
    if (PAYMENT_CODES.has(code)) return new ActionRequiredError(extractMessage(error, details), "payment", options);
    if (CONFIG_CODES.has(code)) return new ActionRequiredError(extractMessage(error, details), "config", options);
    if (TERMINAL_MESSAGE_CODES.has(code) && details.details?.isRetryable !== true) return new NonRetriableError(extractMessage(error, details), options);
    if (details.details?.isRetryable === false) return new NonRetriableError(extractMessage(error, details), options);
  }
  if (error.code === Code.Unauthenticated) return new ActionRequiredError(error.message, "login", options);
  return new RetriableError(error.message, options);
}

function getErrorDetails(error: ConnectErrorLike): ErrorDetails | undefined {
  const details = error.findDetails(ErrorDetails);
  if (details.length > 0) return details[0];
  try {
    const cause = error.cause;
    if (cause !== null && typeof cause === "object" && "findDetails" in cause && typeof cause.findDetails === "function") {
      const causeDetails = cause.findDetails(ErrorDetails) as readonly ErrorDetails[];
      return causeDetails[0];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function extractMessage(error: ConnectErrorLike, details: ErrorDetails | undefined): string {
  if (details?.details !== undefined) {
    const { title, detail } = details.details;
    if (title && detail) return `${title} ${detail}`;
    return title || detail || error.message;
  }
  return error.message;
}

function matchesTransportPattern(error: Error | ConnectErrorLike): boolean {
  const seen = new Set<Error>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const errorString = `${current.name}: ${current.message}`;
    if (TRANSPORT_PATTERNS.some((pattern) => errorString.includes(pattern)) || NETWORK_ERRNO_RE.test(errorString)) return true;
    const errorCode = (current as Error & { readonly code?: unknown }).code;
    if (typeof errorCode === "string" && (TRANSPORT_PATTERNS.some((pattern) => errorCode.includes(pattern)) || NETWORK_ERRNO_CODES.has(errorCode))) return true;
    current = current.cause;
  }
  return false;
}
