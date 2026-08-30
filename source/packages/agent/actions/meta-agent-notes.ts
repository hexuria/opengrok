import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.js";

export interface MetaAgentNotesConfig {
  readonly notesSessionId?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly featureFlags?: unknown;
  readonly actorIdentity?: { readonly email: string } | undefined;
  readonly enableAgentNotes?: boolean | undefined;
}

export function formatMetaAgentNotesDirectoryInstruction(notesDirectory: string): string {
  return `Write notes which may be useful for other agents working on the same problem to the ${notesDirectory}. If relevant note files already exist, read them and consider extending them.

Use informatively named files to make the notes easily navigable. Group notes about similar concepts underneath the same directories. Focus on information related to the design or functionality of the system which is likely to be helpful to other agents in the future.

If you write to note file(s), reference the key note(s) in your responses to the user.`;
}

export function isMetaAgentNotesEnabled(
  featureFlags: unknown,
): boolean {
  return typeof featureFlags === "object" && featureFlags !== null &&
    "metaAgentNotes" in featureFlags && featureFlags.metaAgentNotes === true;
}

export function buildRequestContextNotesOptions(config: MetaAgentNotesConfig): {
  readonly notesSessionId: string | undefined;
  readonly metaAgentNotesEnabled: boolean;
} {
  return {
    notesSessionId: config.notesSessionId ?? config.conversationId,
    metaAgentNotesEnabled: isMetaAgentNotesEnabled(config.featureFlags),
  };
}

export function buildRequestContextOptions(config: MetaAgentNotesConfig): {
  readonly notesSessionId: string | undefined;
  readonly metaAgentNotesEnabled: boolean;
  readonly actorIdentity: { readonly email: string } | undefined;
} {
  return {
    ...buildRequestContextNotesOptions(config),
    actorIdentity: config.actorIdentity,
  };
}

export function buildUserInfoAgentNotesProps(
  config: MetaAgentNotesConfig,
  mode: AgentMode,
  env: { readonly agentConversationNotesFolder?: string | undefined; readonly agentSharedNotesFolder?: string | undefined } | undefined,
): {
  readonly notesSessionId: string | undefined;
  readonly metaAgentNotesEnabled: boolean;
  readonly agentConversationNotesFolder?: string | undefined;
  readonly agentSharedNotesFolder?: string | undefined;
} {
  const includeAgentNotesPaths = mode === AgentMode.PROJECT || config.enableAgentNotes !== false;
  const baseProps = buildRequestContextNotesOptions(config);
  if (!includeAgentNotesPaths) return baseProps;
  if (mode === AgentMode.PROJECT) {
    return {
      ...baseProps,
      agentConversationNotesFolder: env?.agentConversationNotesFolder,
    };
  }
  return {
    ...baseProps,
    agentSharedNotesFolder: env?.agentSharedNotesFolder,
    agentConversationNotesFolder: env?.agentConversationNotesFolder,
  };
}
