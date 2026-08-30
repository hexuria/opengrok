import { Value } from "@bufbuild/protobuf";
import { McpDescriptor, McpMetaToolOptions, McpToolDescriptor, type McpDescriptor as McpDescriptorType } from "../../proto/generated/agent/v1/mcp_pb.js";
import { CUSTOM_USER_TOOLS_PROVIDER_ID } from "../../agent-exec/mcp.js";

export interface CustomUserMcpTool {
  readonly providerIdentifier: string;
  readonly toolName: string;
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
}

export interface CustomUserToolInstructionNames {
  readonly discoveryToolName: string;
  readonly invocationToolName: string;
  readonly useDynamicToolNamespaces: boolean;
}

function isCustomUserMcpTool(tool: CustomUserMcpTool): boolean {
  return tool.providerIdentifier === CUSTOM_USER_TOOLS_PROVIDER_ID;
}

function buildCustomUserToolsServerUseInstructions(
  customTools: readonly CustomUserMcpTool[],
  toolNames?: CustomUserToolInstructionNames,
): string {
  const toolLines = customTools.map(tool => {
    const description = typeof tool.description === "string" && tool.description.length > 0 ? tool.description : "(no description provided)";
    return `- ${tool.toolName}: ${description}`;
  }).join("\n");
  const discoveryInvocationLine = toolNames
    ? `Discover tool schemas with \`${toolNames.discoveryToolName}\`, then invoke via \`${toolNames.invocationToolName}\` with ${toolNames.useDynamicToolNamespaces ? "namespace" : "server"} "${CUSTOM_USER_TOOLS_PROVIDER_ID}".`
    : `Discover tool schemas via MCP meta-tool discovery for server "${CUSTOM_USER_TOOLS_PROVIDER_ID}", then invoke via the MCP invocation meta-tool with that server.`;
  return `User-defined tools for this session. ${discoveryInvocationLine}

Available tools:
${toolLines}`;
}

function buildCustomUserToolsMcpDescriptor(
  customTools: readonly CustomUserMcpTool[],
  toolNames?: CustomUserToolInstructionNames,
): McpDescriptorType {
  const toolDescriptors = customTools.map(tool => new McpToolDescriptor({
    toolName: tool.toolName,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: Value.fromJson(tool.inputSchema as never) } : {}),
  }));
  return new McpDescriptor({
    serverIdentifier: CUSTOM_USER_TOOLS_PROVIDER_ID,
    serverName: CUSTOM_USER_TOOLS_PROVIDER_ID,
    serverUseInstructions: buildCustomUserToolsServerUseInstructions(customTools, toolNames),
    tools: toolDescriptors,
  });
}

function mergeCustomUserToolsIntoMcpMetaToolOptions(
  mcpMetaToolOptions: McpMetaToolOptions | undefined,
  mcpTools: readonly CustomUserMcpTool[],
  instructionToolNames?: CustomUserToolInstructionNames,
): McpMetaToolOptions | undefined {
  const customTools = mcpTools.filter(isCustomUserMcpTool);
  if (customTools.length === 0 || mcpMetaToolOptions?.enabled !== true) {
    return mcpMetaToolOptions;
  }
  const existingDescriptors = mcpMetaToolOptions.mcpDescriptors ?? [];
  const customUserToolsDescriptor = buildCustomUserToolsMcpDescriptor(customTools, instructionToolNames);
  const otherDescriptors = existingDescriptors.filter(descriptor => descriptor.serverIdentifier !== CUSTOM_USER_TOOLS_PROVIDER_ID);
  return new McpMetaToolOptions({
    enabled: true,
    mcpDescriptors: [...otherDescriptors, customUserToolsDescriptor],
  });
}

export function getMcpMetaToolOptionsWithCustomUserTools(
  mcpMetaToolOptions: McpMetaToolOptions | undefined,
  mcpTools: readonly CustomUserMcpTool[],
  instructionToolNames?: CustomUserToolInstructionNames,
): McpMetaToolOptions | undefined {
  const hasCustomTools = mcpTools.some(isCustomUserMcpTool);
  if (!hasCustomTools) return mcpMetaToolOptions;
  const baseOptions = mcpMetaToolOptions?.enabled === true
    ? mcpMetaToolOptions
    : new McpMetaToolOptions({
      enabled: true,
      mcpDescriptors: mcpMetaToolOptions?.mcpDescriptors ?? [],
    });
  return mergeCustomUserToolsIntoMcpMetaToolOptions(baseOptions, mcpTools, instructionToolNames);
}
