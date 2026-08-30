export const TRANSCRIPTS_SUBDIR = "agent-transcripts";
export const MAX_CONVERSATION_ID_LENGTH = 200;
export function getSafeConversationId(conversationId: string): string {
  let safe = encodeURIComponent(conversationId).replace(/%/g, "_");
  if (safe.length > MAX_CONVERSATION_ID_LENGTH) safe = safe.slice(0, MAX_CONVERSATION_ID_LENGTH);
  return safe;
}
