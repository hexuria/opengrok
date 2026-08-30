import { McpDescriptor, type McpDescriptor as McpDescriptorType } from "../../proto/generated/agent/v1/mcp_pb.js";
import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.js";
import type { Context } from "../../context/core.js";
import { resolveProjectConversationContext } from "../utils/project-conversation.js";

const CURSOR_APP_CONTROL_SERVER = "cursor-app-control";
const WORKSPACE_MUTATION_TOOLS = new Set([
  "move_agent_to_root",
  "move_agent_to_cloned_root",
  "create_project",
]);

interface ProjectWorkspaceState {
  readonly mode?: AgentMode | undefined;
  readonly turns?: readonly {
    get(ctx: Context): Promise<unknown>;
  }[];
}

export async function isProjectWorkspaceConversation(
  ctx: Context,
  stateHandler: ProjectWorkspaceState,
): Promise<boolean> {
  if (stateHandler.mode === AgentMode.PROJECT) return true;
  if (!("turns" in stateHandler)) return false;
  return (await resolveProjectConversationContext(ctx, stateHandler as Parameters<typeof resolveProjectConversationContext>[1])).isRootProject;
}

function isProjectWorkspaceMutationMcpTool(args: {
  readonly serverIdentifier: string;
  readonly toolName: string;
}): boolean {
  return args.serverIdentifier.toLowerCase() === CURSOR_APP_CONTROL_SERVER &&
    WORKSPACE_MUTATION_TOOLS.has(args.toolName.toLowerCase());
}

export function filterProjectWorkspaceMutationMcpDescriptors(
  descriptors: readonly McpDescriptorType[],
): McpDescriptorType[] {
  return descriptors.map(descriptor => new McpDescriptor({
    ...descriptor,
    tools: descriptor.tools.filter(tool => !isProjectWorkspaceMutationMcpTool({
      serverIdentifier: descriptor.serverIdentifier,
      toolName: tool.toolName,
    })),
  }));
}
