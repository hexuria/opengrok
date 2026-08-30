import { AgentType } from "./utils/agent-config.js";

// Extracted from ../packages/agent/dist/state.js as an uncomposed state-support leaf.
export function parseAgentType(agentType: AgentType | string | undefined): AgentType | undefined {
  switch (agentType) {
    case AgentType.IDE:
    case AgentType.CLI:
    case AgentType.BACKGROUND:
    case AgentType.BUGBOT:
      return agentType;
    case undefined:
      return undefined;
    default:
      return undefined;
  }
}
