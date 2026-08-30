export const SSE_CHANNEL_BY_FAMILY = {
  transcript: "transcript",
  "client-side-tool-v2": "client-side-tool-v2",
  agents: "agents",
  "agent-upserted": "agent-upserted",
  tray: "tray",
  "agents-workflow": "workflows",
  subagents: "subagents",
  "async-tasks": "async-tasks",
  "agents-automation": "automations",
  "mcp-servers-updated": "mcp-servers",
  "forever-box": "forever-box",
  "teach-recording": "teach-recording",
  "box-disk-pressure": "box-disk-pressure",
  "computer-action": "computer-action",
  outline: "outline",
  sharing: "sharing",
  "host-settings": "host-settings"
} as const;

export type CoordinatorEventFamily = keyof typeof SSE_CHANNEL_BY_FAMILY;
export type CoordinatorSseChannel = (typeof SSE_CHANNEL_BY_FAMILY)[CoordinatorEventFamily];

const FAMILY_BY_SSE_CHANNEL = new Map<string, CoordinatorEventFamily>(
  Object.entries(SSE_CHANNEL_BY_FAMILY).map(([family, channel]) => [channel, family as CoordinatorEventFamily])
);

export function coordinatorEventFamilyForSseChannel(channel: string): CoordinatorEventFamily | null {
  return FAMILY_BY_SSE_CHANNEL.get(channel) ?? null;
}
