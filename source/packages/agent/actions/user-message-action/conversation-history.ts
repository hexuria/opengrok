import { PrivacyCapability } from "../../../redaction/classification.js";
import { toRedactedCoreMessages } from "../../../redaction/core-message.js";
import { fromRedactedConversationHistory } from "../../../redacted-protos/generated/agent/v1/agent_redacted.js";

type Any = any;

function getDataUrlBase64(data: string): string | undefined {
  return /^data:image\/[^;,]+;base64,(.*)$/iu.exec(data)?.[1];
}

function toCoreUserImage(data: string, mimeType: string | undefined): string {
  if (getDataUrlBase64(data) !== undefined || mimeType === undefined) return data;
  return `data:${mimeType};base64,${data}`;
}

function toCoreToolImageData(data: string): string { return getDataUrlBase64(data) ?? data; }

function toCoreUserContent(content: readonly Any[]): Any[] {
  const parts: Any[] = [];
  for (const part of content) {
    switch (part.content.case) {
      case "text": parts.push({ type: "text", text: part.content.value.text }); break;
      case "image": parts.push({ type: "image", image: toCoreUserImage(part.content.value.data, part.content.value.mimeType), mimeType: part.content.value.mimeType }); break;
      case undefined: break;
      default: return part.content;
    }
  }
  return parts;
}

function toCoreToolResultContent(content: readonly Any[]): { result: string | undefined; experimentalContent: Any[] } {
  const experimentalContent: Any[] = [];
  const textParts: string[] = [];
  for (const part of content) {
    switch (part.content.case) {
      case "text":
        textParts.push(part.content.value.text);
        experimentalContent.push({ type: "text", text: part.content.value.text });
        break;
      case "image":
        experimentalContent.push({ type: "image", data: toCoreToolImageData(part.content.value.data), mimeType: part.content.value.mimeType });
        break;
      case undefined: break;
      default: return { result: undefined, experimentalContent: [part.content] };
    }
  }
  return { result: textParts.length > 0 ? textParts.join("\n") : undefined, experimentalContent };
}

function toCoreAssistantContent(content: readonly Any[]): Any {
  const parts: Any[] = [];
  for (const part of content) {
    switch (part.content.case) {
      case "text": parts.push({ type: "text", text: part.content.value.text }); break;
      case "reasoning": parts.push({ type: "reasoning", text: part.content.value.text, signature: part.content.value.signature }); break;
      case "redactedReasoning": parts.push({ type: "redacted-reasoning", data: part.content.value.data }); break;
      case "toolCall": parts.push({ type: "tool-call", toolCallId: part.content.value.toolCallId, toolName: part.content.value.toolName, args: JSON.parse(part.content.value.argsJson) }); break;
      case undefined: break;
      default: return part.content;
    }
  }
  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0]?.type === "text") return parts[0].text;
  return parts;
}

export function conversationHistoryToCoreMessages(history: Any | undefined): Any[] {
  if (history === undefined) return [];
  const messages: Any[] = [];
  for (const message of history.messages) {
    switch (message.message.case) {
      case "user": messages.push({ role: "user", content: toCoreUserContent(message.message.value.content) }); break;
      case "assistant": messages.push({ role: "assistant", content: toCoreAssistantContent(message.message.value.content) }); break;
      case "tool": {
        const { toolCallId, toolName, content, isError } = message.message.value;
        const { result, experimentalContent } = toCoreToolResultContent(content);
        messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId, toolName, result, experimental_content: experimentalContent, ...(isError !== undefined ? { isError } : {}) }] });
        break;
      }
      case undefined: break;
      default: return message.message;
    }
  }
  return messages;
}

export function deserializeConversationHistoryMessages(action: Any, privacyMode: Any): Any[] {
  const history = action.conversationHistory === undefined ? undefined : fromRedactedConversationHistory(action.conversationHistory, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined);
  return toRedactedCoreMessages(conversationHistoryToCoreMessages(history), privacyMode);
}
