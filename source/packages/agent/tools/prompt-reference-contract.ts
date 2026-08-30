import { createHash, randomInt } from "node:crypto";
export const PROMPT_REFERENCE_ID_LENGTH = 7;
export const PROMPT_REFERENCE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PROMPT_REFERENCE_ID_ALPHABET_LENGTH = PROMPT_REFERENCE_ID_ALPHABET.length;
const PROMPT_REFERENCE_ID_REGEX_SOURCE = `[A-Za-z0-9]{${PROMPT_REFERENCE_ID_LENGTH}}`;
const USER_MESSAGE_ID_TAG_TEXT_PREFIX = "<user_message_id>"; const USER_MESSAGE_ID_TAG_TEXT_SUFFIX = "</user_message_id>";
const TOOL_CALL_ID_TAG_TEXT_PREFIX = "<tool_call_id>"; const TOOL_CALL_ID_TAG_TEXT_SUFFIX = "</tool_call_id>";
const PROMPT_REFERENCE_ID_PATTERN = new RegExp(`^${PROMPT_REFERENCE_ID_REGEX_SOURCE}$`);
const LEADING_USER_MESSAGE_ID_TAG_PATTERN = new RegExp(`^${USER_MESSAGE_ID_TAG_TEXT_PREFIX}\\s*(${PROMPT_REFERENCE_ID_REGEX_SOURCE})\\s*${USER_MESSAGE_ID_TAG_TEXT_SUFFIX}\\n?`);
const LEADING_USER_MESSAGE_ID_TAG_LEGACY_PATTERN = new RegExp(`^${USER_MESSAGE_ID_TAG_TEXT_PREFIX}\\s*message_id=(${PROMPT_REFERENCE_ID_REGEX_SOURCE})\\s*${USER_MESSAGE_ID_TAG_TEXT_SUFFIX}\\n?`);
export function createPromptReferenceIdFromMessageId(messageId: string): string {
  const digest = createHash("sha256").update(messageId).digest();
  let id = "";
  for (let index = 0; index < PROMPT_REFERENCE_ID_LENGTH; index++) id += PROMPT_REFERENCE_ID_ALPHABET[digest[index] as number % PROMPT_REFERENCE_ID_ALPHABET_LENGTH];
  return id;
}
export function createPromptReferenceId(messageId?: string | null): string {
  const normalized = messageId?.trim();
  if (normalized !== undefined && normalized.length > 0) return createPromptReferenceIdFromMessageId(normalized);
  let id = "";
  for (let index = 0; index < PROMPT_REFERENCE_ID_LENGTH; index++) id += PROMPT_REFERENCE_ID_ALPHABET[randomInt(0, PROMPT_REFERENCE_ID_ALPHABET_LENGTH)];
  return id;
}
export function isValidPromptReferenceId(id: string): boolean { return PROMPT_REFERENCE_ID_PATTERN.test(id); }
export function renderUserMessageIdTag(id: string): string { return `${USER_MESSAGE_ID_TAG_TEXT_PREFIX}${id}${USER_MESSAGE_ID_TAG_TEXT_SUFFIX}`; }
export function createToolCallReferenceId(toolCallId: string): string {
  const normalized = toolCallId.trim();
  if (normalized.length === 0) return "";
  const separatorIndex = normalized.lastIndexOf("_");
  if (separatorIndex < 0) return normalized;
  const suffix = normalized.slice(separatorIndex + 1);
  if (suffix.length >= PROMPT_REFERENCE_ID_LENGTH) {
    const candidate = suffix.slice(0, PROMPT_REFERENCE_ID_LENGTH);
    if (isValidPromptReferenceId(candidate)) return candidate;
  }
  return normalized;
}
export function renderToolCallIdTag(id: string): string { return `${TOOL_CALL_ID_TAG_TEXT_PREFIX}${id}${TOOL_CALL_ID_TAG_TEXT_SUFFIX}`; }
export function parseLeadingUserMessageIdTag(text: string): { id: string; strippedText: string } | undefined {
  const match = LEADING_USER_MESSAGE_ID_TAG_PATTERN.exec(text) ?? LEADING_USER_MESSAGE_ID_TAG_LEGACY_PATTERN.exec(text);
  return match?.[1] === undefined ? undefined : { id: match[1], strippedText: text.slice(match[0].length) };
}
