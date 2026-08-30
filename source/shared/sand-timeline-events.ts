export const AUTOMATION_ACTION_VERB: Readonly<Record<string, string>> = {
  created: "Created",
  updated: "Updated",
  enabled: "Enabled",
  disabled: "Disabled",
  deleted: "Deleted",
};

export type SandTimelineEvent =
  | { readonly type: "name-changed"; readonly to: string }
  | { readonly type: "channel-connected"; readonly label: string }
  | { readonly type: "channel-disconnected"; readonly label: string }
  | {
      readonly type: "automation-changed";
      readonly action: string;
      readonly automationName: string;
    }
  | { readonly type: string; readonly [key: string]: unknown };

export function fallbackForUnknownTimelineEvent(
  _event: unknown,
  fallback: string,
): string {
  return fallback;
}

export function describeTimelineEvent(event: SandTimelineEvent): string {
  switch (event.type) {
    case "name-changed":
      return `Renamed to ${String(event.to)}`;
    case "channel-connected":
      return `Connected to ${String(event.label)}`;
    case "channel-disconnected":
      return `Disconnected from ${String(event.label)}`;
    case "automation-changed":
      return `${AUTOMATION_ACTION_VERB[String(event.action)] ?? "Changed"} automation "${String(event.automationName)}"`;
    default:
      return fallbackForUnknownTimelineEvent(event, "Updated this conversation");
  }
}

export const TIMELINE_EVENT_WAKE_CUE = "[event]";

export function buildTimelineEventWakePrompt(
  events: readonly SandTimelineEvent[],
): string {
  const lines = events.map((event) => `- ${describeTimelineEvent(event)}`);
  return [
    `${TIMELINE_EVENT_WAKE_CUE} Something about this conversation just changed.`,
    "This is a system event recorded in your timeline, not the user typing in this app, and possibly something you did yourself.",
    ...lines,
    "If it is worth acknowledging to the user, reply with SendMessage; otherwise it is fine to stay silent.",
  ].join("\n");
}
