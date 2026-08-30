import { isRedactedString } from "../redaction/types.js";

const CHARS_PER_TOKEN = 2.5;
const MESSAGE_OVERHEAD_CHARS = 25;
const TOOL_CALL_OVERHEAD_CHARS = 50;

export interface TokenEstimateMessage {
  readonly content: unknown;
  readonly [key: string]: unknown;
}

export interface TokenEstimateOptions {
  readonly includeNonTextContent?: boolean | undefined;
  readonly textContentLengthFn?: ((message: TokenEstimateMessage) => number) | undefined;
}

interface TokenEstimatePart {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly args?: unknown;
  readonly result?: unknown;
  readonly data?: unknown;
}

function safeLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (typeof value === "object" && value !== null && "length" in value) {
    try {
      const length = value.length;
      return typeof length === "number" ? length : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

function estimatePartChars(part: TokenEstimatePart): number {
  switch (part.type) {
    case "text":
      return safeLength(part.text);
    case "tool-call":
      return safeLength(part.args) + TOOL_CALL_OVERHEAD_CHARS;
    case "tool-result":
      return safeLength(part.result) + TOOL_CALL_OVERHEAD_CHARS;
    case "unknown":
      return safeLength(part.data);
    default:
      return 0;
  }
}

function defaultTextContentLength(message: TokenEstimateMessage): number {
  const content = message.content;
  if (isRedactedString(content) || typeof content === "string") return safeLength(content);
  if (Array.isArray(content)) {
    let length = 0;
    for (const part of content) {
      const candidate = part as TokenEstimatePart;
      if (candidate.type === "text") length += safeLength(candidate.text);
    }
    return length;
  }
  return 0;
}

export function estimateTokenCount(
  messages: readonly TokenEstimateMessage[],
  options?: TokenEstimateOptions | null,
): number {
  const includeNonText = options?.includeNonTextContent ?? false;
  const getTextLength = options?.textContentLengthFn ?? defaultTextContentLength;
  let totalChars = 0;
  for (const message of messages) {
    const content = message.content;
    if (isRedactedString(content) || typeof content === "string") {
      totalChars += getTextLength(message);
    } else if (Array.isArray(content)) {
      if (includeNonText) {
        for (const part of content) totalChars += estimatePartChars(part as TokenEstimatePart);
      } else {
        totalChars += getTextLength(message);
      }
    }
    totalChars += MESSAGE_OVERHEAD_CHARS;
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}
