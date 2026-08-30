import { BackgroundComposerSource } from "../../../proto/generated/aiserver/v1/background_composer_pb.js";
import {
  CURSOR_SUBSCRIPTIONS_MCP_SERVER_NAME,
  NAMED_AGENT_STORE_SELF_PATH,
} from "../../constants.js";

type NamedAgentSessionProps = {
  readonly backgroundAgentSource?: BackgroundComposerSource | undefined;
  readonly namedAgentSessionKind?: string | undefined;
  readonly isCloudMetaAgentParent?: boolean | undefined;
  readonly subagentType?: unknown;
};

export type NamedAgentSessionPromptContext = {
  readonly namedAgentId: string;
  readonly sessionKey: string;
  readonly sessionKind: string;
};

const NAMED_AGENT_HOME_SESSION_KIND = "home";

export function isNamedAgentHomePromptSession(props: NamedAgentSessionProps): boolean {
  return props.backgroundAgentSource === BackgroundComposerSource.CLOUD_META_AGENT &&
    props.namedAgentSessionKind?.trim() === NAMED_AGENT_HOME_SESSION_KIND &&
    props.isCloudMetaAgentParent !== true &&
    props.subagentType === undefined;
}

export function getNamedAgentSessionPromptContext(
  props: Pick<NamedAgentSessionProps, "namedAgentSessionKind"> & {
    readonly namedAgentId?: string | undefined;
    readonly namedAgentSessionKey?: string | undefined;
  },
): NamedAgentSessionPromptContext | undefined {
  const namedAgentId = props.namedAgentId?.trim();
  const sessionKey = props.namedAgentSessionKey?.trim();
  const sessionKind = props.namedAgentSessionKind?.trim();
  if (!namedAgentId || !sessionKey || !sessionKind) {
    return undefined;
  }
  return { namedAgentId, sessionKey, sessionKind };
}

export function renderNamedAgentHomeUserTurnReminder(): string {
  return `<system_reminder>
This is your configuration conversation. Treat the user message as durable configuration, not task-specific work, and reply as yourself in plain language. Update ${NAMED_AGENT_STORE_SELF_PATH} with your file tools. For an explicit subscription change, register it through the ${CURSOR_SUBSCRIPTIONS_MCP_SERVER_NAME} subscribe tools immediately and report the authoritative result; you may read other MCP servers for details like a channel id, but do not post messages through them. Questions and hypothetical examples must not mutate subscriptions. Do not perform or delegate repository or implementation work from this conversation.
</system_reminder>`;
}

export function renderCloudMetaParentUserTurnReminder(
  taskToolName: string,
  session: NamedAgentSessionPromptContext | undefined,
): string {
  const sessionReminder = session !== undefined
    ? ` You are a session of Named Agent ${session.namedAgentId}; stay focused on session ${session.sessionKind}/${session.sessionKey}.`
    : "";
  return `<system_reminder>
You are the Named Agent parent. For substantive work, delegate to the ${taskToolName} tool instead of doing the work yourself. Use MCP tools directly only for quick external/service actions such as sending a Slack message or creating/listing subscriptions. Subscriptions managed through ${CURSOR_SUBSCRIPTIONS_MCP_SERVER_NAME} deliver their events to this session; timers keep the default sessionStrategy wake_self, and each fire wakes this session (the new_session and per_thread strategies are not available to this session). For notification- or subscription-triggered turns, only surface material updates, decisions, action items, or user-relevant changes; do not send user-visible replies just to report that you checked an event, nothing changed, or a case was irrelevant. Keep replies concise and chat-native, without narrating internal process or tool choices.${sessionReminder}
</system_reminder>`;
}
