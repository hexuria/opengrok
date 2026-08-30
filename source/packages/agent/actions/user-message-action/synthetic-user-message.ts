import { SYSTEM_NOTIFICATION_TAG } from "../../../constants/system-notification.js";

interface Message { role: string; content?: unknown; providerOptions?: { cursor?: { isSummary?: boolean } } }
export function extractCursorProviderOptions(message: Message): { isSummary?: boolean } | undefined { return message.providerOptions?.cursor; }
export function getUserMessageTextContent(message: Message): string | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content.filter((part): part is { type: "text"; text: string } => part !== null && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string").map((part) => part.text).join("");
}
export const NOTIFICATION_TAG_NAMES = ["system_notification", "agent_notification", "task_notification", "side_chat_boundary"];
const XML_TAG_REGEX = /<(?:(\/)\s*([A-Za-z_][\w:.-]*)\s*>|([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?(\/)?\>)/g;
export function isNotificationOnlyUserMessage(message: Message): boolean {
  const text = getUserMessageTextContent(message);
  if (text === undefined || text.length === 0) return false;
  const stack: string[] = [];
  for (const match of text.matchAll(XML_TAG_REGEX)) {
    const [, closingSlash, closingTagName, openingTagName, selfClosingSlash] = match;
    if (closingSlash !== undefined && closingTagName !== undefined) { if (stack.at(-1) === closingTagName) stack.pop(); continue; }
    if (openingTagName === undefined) continue;
    if (stack.length === 0 && NOTIFICATION_TAG_NAMES.includes(openingTagName)) return true;
    if (selfClosingSlash === undefined) stack.push(openingTagName);
  }
  return false;
}
export function isGoalContinuationNotificationMessage(message: Message): boolean {
  return getUserMessageTextContent(message)?.includes(`<${SYSTEM_NOTIFICATION_TAG} source="goal"`) === true;
}
export function isSyntheticUserMessage(message: Message): boolean {
  return extractCursorProviderOptions(message)?.isSummary === true || isNotificationOnlyUserMessage(message);
}
