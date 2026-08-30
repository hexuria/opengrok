import { AgentMode } from "../proto/generated/agent/v1/agent_pb.js";

export interface AgentNotesPromptInput {
  readonly mode: AgentMode;
  readonly enableAgentNotes: boolean;
  readonly metaAgentNotes: boolean;
  readonly conversationNotesListing?: string | undefined;
  readonly sharedNotesListing?: string | undefined;
}

export interface AgentNotesTextContent {
  readonly type: "text";
  readonly text: string;
}

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed agent-notes prompt leaf. The parent processSelectedContext
// function remains absent.
export function renderAgentNotesContext({
  mode,
  enableAgentNotes,
  metaAgentNotes,
  conversationNotesListing,
  sharedNotesListing,
}: AgentNotesPromptInput): AgentNotesTextContent | undefined {
  if (mode !== AgentMode.PROJECT && enableAgentNotes && (conversationNotesListing || sharedNotesListing)) {
    if (metaAgentNotes) {
      return undefined;
    }
    const parts = ["<agent_notes>\nAgent notes for this conversation:\n"];
    if (conversationNotesListing) {
      parts.push(`
Conversation notes:
${conversationNotesListing}
`);
    }
    if (sharedNotesListing) {
      parts.push(`
Shared notes:
${sharedNotesListing}
`);
    }
    parts.push("</agent_notes>");
    return {
      type: "text",
      text: parts.join(""),
    };
  }
  return undefined;
}
