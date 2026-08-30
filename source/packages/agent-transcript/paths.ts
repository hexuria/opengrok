import { getSafeConversationId, TRANSCRIPTS_SUBDIR } from "../utils/workspace-paths.js";
export function getTranscriptRelativePath(args: { conversationId: string; kind: string; parentConversationId?: string; ext: string }): string {
  const safeId = getSafeConversationId(args.conversationId);
  if (args.kind === "subagent" && args.parentConversationId) {
    const safeParentId = getSafeConversationId(args.parentConversationId);
    return `${TRANSCRIPTS_SUBDIR}/${safeParentId}/subagents/${safeId}.${args.ext}`;
  }
  return `${TRANSCRIPTS_SUBDIR}/${safeId}/${safeId}.${args.ext}`;
}
