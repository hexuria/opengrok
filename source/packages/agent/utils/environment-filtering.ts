import { AgentType } from "./agent-config.js";
import { filterByEnvironment, type EnvironmentScopedItem } from "../../cursor-plugins/environment-filter.js";

export function filterByAgentEnvironment<T extends EnvironmentScopedItem>(items: T[], agentType?: AgentType): T[] {
  if (agentType === undefined || agentType === AgentType.BUGBOT) {
    return items;
  }
  const envMap: Record<AgentType, string> = {
    [AgentType.BACKGROUND]: "cloud",
    [AgentType.BUGBOT]: "local",
    [AgentType.IDE]: "local",
    [AgentType.CLI]: "local",
  };
  return filterByEnvironment(items, envMap[agentType]);
}
