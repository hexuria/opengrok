import { InputTokenLimitError, OutputTokensLimitExceededError } from "../chat-inference/prompt-executor.js";

export class NoSummaryResponseError extends Error {
  constructor() {
    super("No assistant response received");
    this.name = "NoSummaryResponseError";
    Object.setPrototypeOf(this, NoSummaryResponseError.prototype);
  }
}

const CONNECT_ERROR_CODES = {
  InvalidArgument: 3,
  NotFound: 5,
  ResourceExhausted: 8,
  Aborted: 10,
  Unavailable: 14,
  Unauthenticated: 16,
};

function* iterateErrorChain(error: unknown): Generator<unknown> {
  let current = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    yield current;
    if (current instanceof Error) current = current.cause;
    else break;
  }
}

function hasErrorName(error: unknown, targetName: string): boolean {
  for (const current of iterateErrorChain(error)) {
    if (current instanceof Error && current.name === targetName) return true;
  }
  return false;
}

function errorMessageIncludes(error: unknown, needle: string): boolean {
  const normalizedNeedle = needle.toLowerCase();
  for (const current of iterateErrorChain(error)) {
    if (current instanceof Error && current.message.toLowerCase().includes(normalizedNeedle)) return true;
  }
  return false;
}

function hasConnectCode(error: unknown, targetCode: number): boolean {
  for (const current of iterateErrorChain(error)) {
    if (typeof current === "object" && current !== null && "code" in current && current.code === targetCode) return true;
  }
  return false;
}

function isTextFieldsTooLargeError(error: unknown): boolean {
  return errorMessageIncludes(error, "request contains text fields that are too large");
}

function isInvalidJsonError(error: unknown): boolean {
  return errorMessageIncludes(error, "not valid json") || errorMessageIncludes(error, "invalid json");
}

function isInvalidArgumentError(error: unknown): boolean {
  return errorMessageIncludes(error, "invalid argument");
}

function isUserApiKeyRateLimitExceededError(error: unknown): boolean {
  return errorMessageIncludes(error, "User API Key Rate limit exceeded");
}

const TOO_MANY_IMAGES_OR_DOCUMENTS_MESSAGE_MARKERS = [
  "request contained too many images or documents",
  "too many images or documents error",
  "too many images and documents",
  "too much media",
];

export function isTooManyImagesOrDocumentsError(error: unknown): boolean {
  return TOO_MANY_IMAGES_OR_DOCUMENTS_MESSAGE_MARKERS.some(marker => errorMessageIncludes(error, marker));
}

export class CannotTruncatePromptError extends Error {
  declare readonly totalMessages: number;
  declare readonly originalChars: number;
  declare readonly budgetChars: number;

  constructor(message: string, details: { totalMessages: number; originalChars: number; budgetChars: number }) {
    super(message);
    this.name = "CannotTruncatePromptError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.totalMessages = details.totalMessages;
    this.originalChars = details.originalChars;
    this.budgetChars = details.budgetChars;
  }
}

export interface SummarizationRetryOptions {
  readonly transientRetryDelayMs: number;
  readonly enableRetryOutputTokenLimit?: boolean | undefined;
  readonly enableReduceInputsRetry?: boolean | undefined;
  readonly enableRetryNoSummaryResponse?: boolean | undefined;
  readonly enableRetryUncategorizedErrors?: boolean | undefined;
}

export interface SummarizationRetryDirective {
  readonly errorType: string;
  readonly shouldRetry: boolean;
  readonly retryDelayMs: number;
  readonly requestShorterOutput: boolean;
  readonly reduceInputs: boolean;
}

export function getRetryDirective(error: unknown, options: SummarizationRetryOptions): SummarizationRetryDirective {
  if (error instanceof OutputTokensLimitExceededError || hasErrorName(error, "OutputTokensLimitExceededError")) {
    const enableRetryOutputTokenLimit = options.enableRetryOutputTokenLimit ?? true;
    return {
      errorType: "OutputTokensLimitExceededError",
      shouldRetry: enableRetryOutputTokenLimit,
      retryDelayMs: enableRetryOutputTokenLimit ? options.transientRetryDelayMs : 0,
      requestShorterOutput: enableRetryOutputTokenLimit,
      reduceInputs: false,
    };
  }
  if (error instanceof InputTokenLimitError || hasErrorName(error, "InputTokenLimitError")) {
    const reduceInputs = options.enableReduceInputsRetry ?? false;
    return { errorType: "InputTokenLimitError", shouldRetry: reduceInputs, retryDelayMs: 0, requestShorterOutput: false, reduceInputs };
  }
  if (hasConnectCode(error, CONNECT_ERROR_CODES.ResourceExhausted) || hasErrorName(error, "ResourceExhausted")) {
    if (isTextFieldsTooLargeError(error)) {
      const reduceInputs = options.enableReduceInputsRetry ?? false;
      return { errorType: "InputTooLargeError", shouldRetry: reduceInputs, retryDelayMs: 0, requestShorterOutput: false, reduceInputs };
    }
    if (isInvalidJsonError(error)) {
      return { errorType: "InvalidJson", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
    }
    if (isInvalidArgumentError(error)) {
      return { errorType: "InvalidArgument", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
    }
    return { errorType: "ResourceExhausted", shouldRetry: true, retryDelayMs: options.transientRetryDelayMs, requestShorterOutput: false, reduceInputs: false };
  }
  if (hasConnectCode(error, CONNECT_ERROR_CODES.Unavailable) || hasErrorName(error, "Unavailable")) {
    return { errorType: "Unavailable", shouldRetry: true, retryDelayMs: options.transientRetryDelayMs, requestShorterOutput: false, reduceInputs: false };
  }
  if (hasConnectCode(error, CONNECT_ERROR_CODES.Aborted) || hasErrorName(error, "UserAbortedError") || hasErrorName(error, "AbortError")) {
    return { errorType: "AbortError", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
  }
  if (hasErrorName(error, "InteractionListenerStreamClosedError")) {
    return { errorType: "InteractionListenerStreamClosedError", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
  }
  if (hasConnectCode(error, CONNECT_ERROR_CODES.Unauthenticated) || hasErrorName(error, "Unauthenticated")) {
    return { errorType: "Unauthenticated", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
  }
  if (hasConnectCode(error, CONNECT_ERROR_CODES.InvalidArgument) || hasErrorName(error, "InvalidArgument")) {
    if (isUserApiKeyRateLimitExceededError(error)) {
      return { errorType: "InvalidArgument", shouldRetry: true, retryDelayMs: options.transientRetryDelayMs, requestShorterOutput: false, reduceInputs: false };
    }
    return { errorType: "InvalidArgument", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
  }
  if (hasConnectCode(error, CONNECT_ERROR_CODES.NotFound) || hasErrorName(error, "NotFound") || hasErrorName(error, "StringNotFoundError")) {
    return { errorType: "NotFound", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
  }
  if (error instanceof NoSummaryResponseError || hasErrorName(error, "NoSummaryResponseError")) {
    return { errorType: "NoSummaryResponseError", shouldRetry: options.enableRetryNoSummaryResponse ?? false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
  }
  if (error instanceof CannotTruncatePromptError || hasErrorName(error, "CannotTruncatePromptError")) {
    return { errorType: "CannotTruncatePromptError", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
  }
  if (error instanceof Error) {
    const shouldRetry = options.enableRetryUncategorizedErrors ?? true;
    return {
      errorType: error.name || "UncategorizedError",
      shouldRetry,
      retryDelayMs: shouldRetry ? options.transientRetryDelayMs : 0,
      requestShorterOutput: false,
      reduceInputs: false,
    };
  }
  return { errorType: "UnknownError", shouldRetry: false, retryDelayMs: 0, requestShorterOutput: false, reduceInputs: false };
}
