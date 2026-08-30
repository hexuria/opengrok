import {
  estimateTokenCount as estimateBaseTokenCount,
  type TokenEstimateOptions,
} from "../../agent-summarization/token-estimate.js";
import { DataClassification, PrivacyCapability } from "../../redaction/classification.js";
import { createRedactedString, safeString } from "../../redaction/factory.js";
import type { PrivacyMode } from "../../redaction/privacy-mode.js";
import { isRedactedString, type RedactedString } from "../../redaction/types.js";
import { stripThinkingTags } from "../loop-detection/agent-loop-detector.js";

export interface SelfSummaryMessage {
  readonly content: unknown;
  readonly _privacyMode: PrivacyMode;
  readonly [key: string]: unknown;
}

interface TextContentPart {
  readonly type?: unknown;
  readonly text: RedactedString;
}

export function extractTextContent(message: SelfSummaryMessage): RedactedString {
  const content = message.content;
  if (isRedactedString(content)) {
    return content.safeTransform(value => stripThinkingTags(value));
  }
  if (typeof content === "string") {
    return createRedactedString(
      stripThinkingTags(content),
      DataClassification.CODE,
      "extractedTextContent",
      message._privacyMode,
    );
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part: TextContentPart) => {
        if (part.type === "text") {
          return part.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return createRedactedString(
      stripThinkingTags(text),
      DataClassification.CODE,
      "extractedTextContent",
      message._privacyMode,
    );
  }
  return safeString("");
}

export function estimateTokenCount(
  messages: readonly SelfSummaryMessage[],
  options?: Omit<TokenEstimateOptions, "textContentLengthFn"> | null,
): number {
  return estimateBaseTokenCount(messages, {
    ...options,
    textContentLengthFn: message => extractTextContent(message as SelfSummaryMessage).length,
  });
}
