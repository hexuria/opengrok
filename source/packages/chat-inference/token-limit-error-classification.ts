import { InputTokenLimitError, OutputTokensLimitExceededError } from "./prompt-executor.js";

const OUTPUT_TOKEN_LIMIT_ERROR_SUBSTRING = "exceeded max output tokens";
const CANONICAL_INPUT_TOKEN_LIMIT_MESSAGE = "input token limit exceeded";

const includesAll = (haystack: string, needles: readonly string[]): boolean =>
  needles.every((needle) => haystack.includes(needle));

function isObservedInputTokenLimitMessage(message: string): boolean {
  return includesAll(message, ["input tokens exceed the configured limit", "your messages resulted in", "tokens"]) ||
    message.includes("input token count") && message.includes("exceeds the maximum number of tokens allowed") ||
    includesAll(message, ["input token count", "exceeds", "maximum context length"]) ||
    includesAll(message, ["maximum prompt length", "request contains", "tokens"]) ||
    message.includes("prompt is too long") ||
    includesAll(message, ["input", "token", "longer than", "context length"]) ||
    includesAll(message, ["input token count", "plus", "requested output count", "exceeds", "maximum context length"]) ||
    includesAll(message, ["input exceeds", "context window"]) ||
    message.includes("input is too long for requested model") ||
    includesAll(message, ["input length", "exceeds the maximum allowed input length"]) ||
    includesAll(message, ["request size cannot exceed", "bytes", "please shorten the request"]) ||
    includesAll(message, ["input length", "max_tokens", "exceed context limit"]) ||
    message.includes("input is too long") ||
    message.includes("request size exceeds model context window") ||
    includesAll(message, ["message size", "bytes", "exceeds", "mb limit"]) ||
    message.includes("context_length_exceeded") ||
    message.includes("payload too large") ||
    /max tokens of \d+ exceeded/.test(message);
}

export function isInputTokenLimitErrorMessage(errorMessage: string): boolean {
  return isObservedInputTokenLimitMessage(errorMessage.toLowerCase());
}

export function isOutputTokenLimitErrorMessage(errorMessage: string): boolean {
  return errorMessage.toLowerCase().includes(OUTPUT_TOKEN_LIMIT_ERROR_SUBSTRING);
}

export function classifyTokenLimitErrorFromMessage(errorMessage: string): Error | undefined {
  if (isOutputTokenLimitErrorMessage(errorMessage)) return new OutputTokensLimitExceededError(errorMessage);
  if (isInputTokenLimitErrorMessage(errorMessage) || errorMessage.toLowerCase().includes(CANONICAL_INPUT_TOKEN_LIMIT_MESSAGE)) {
    return new InputTokenLimitError(errorMessage);
  }
  return undefined;
}
