import path from "node:path";

// Extracted from ../packages/agent/dist/prompts/user-info.js.
// The broader user-info prompt remains separate; this helper only projects the
// enabled session's notes directory.
export function resolveMetaAgentNotesDirectory(props: {
  readonly metaAgentNotesEnabled?: boolean | undefined;
  readonly agentConversationNotesFolder?: string | undefined;
  readonly notesSessionId?: string | undefined;
  readonly env?: { readonly projectFolder?: string | undefined } | undefined;
}): string | undefined {
  if (props.metaAgentNotesEnabled !== true) {
    return undefined;
  }
  const conversationNotesFolder = props.agentConversationNotesFolder;
  if (conversationNotesFolder && conversationNotesFolder.length > 0) {
    return props.agentConversationNotesFolder;
  }
  const notesSessionId = props.notesSessionId;
  const projectFolder = props.env?.projectFolder;
  if (notesSessionId && notesSessionId.length > 0 && projectFolder && projectFolder.length > 0) {
    return path.join(projectFolder, "agent-notes", notesSessionId);
  }
  return undefined;
}
