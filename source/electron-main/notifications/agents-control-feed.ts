export interface AgentsControlFeedTarget {
  handleAgentsEvent(event: any): void;
  handleAgentUpsertedEvent(event: any): void;
}

function isAgentsEvent(value: unknown): value is { agents: unknown; activeAgentId: unknown } {
  return typeof value === "object" && value != null && "agents" in value && "activeAgentId" in value;
}

function isAgentUpsertedEvent(value: unknown): value is { agent: unknown; activeAgentId: unknown } {
  return typeof value === "object" && value != null && "agent" in value && "activeAgentId" in value;
}

export function createAgentsControlFeed(deps: {
  readonly osNotifications: AgentsControlFeedTarget & { seedBaseline(agents: readonly any[]): void };
  readonly dockBadge: AgentsControlFeedTarget & { seedRoster(agents: readonly any[]): void };
}): {
  readonly "agents-event": (payload: unknown) => void;
  readonly "agents-roster-seed": (payload: unknown) => void;
} {
  return {
    "agents-event": (payload) => {
      if (typeof payload !== "object" || payload == null) return;
      if ("kind" in payload && payload.kind === "agents" && "event" in payload && isAgentsEvent(payload.event)) {
        deps.osNotifications.handleAgentsEvent(payload.event);
        deps.dockBadge.handleAgentsEvent(payload.event);
        return;
      }
      if ("kind" in payload && payload.kind === "agent-upserted" && "event" in payload && isAgentUpsertedEvent(payload.event)) {
        deps.osNotifications.handleAgentUpsertedEvent(payload.event);
        deps.dockBadge.handleAgentUpsertedEvent(payload.event);
      }
    },
    "agents-roster-seed": (payload) => {
      if (typeof payload !== "object" || payload == null || !("agents" in payload) || !Array.isArray(payload.agents)) return;
      deps.osNotifications.seedBaseline(payload.agents);
      deps.dockBadge.seedRoster(payload.agents);
    },
  };
}
