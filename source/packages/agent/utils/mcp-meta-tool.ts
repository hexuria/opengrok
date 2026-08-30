import { McpDescriptor, type McpDescriptor as McpDescriptorType } from "../../proto/generated/agent/v1/mcp_pb.js";
import { CUSTOM_USER_TOOLS_PROVIDER_ID, CURSOR_DYNAMIC_TOOLS_NAMESPACE } from "../../agent-exec/mcp.js";

export interface McpSnapshotToolNames {
  readonly discoveryToolName: string;
  readonly invocationToolName: string;
  readonly useDynamicToolNamespaces: boolean;
  readonly fetchMcpResourceToolName?: string | undefined;
  readonly listMcpResourcesToolName?: string | undefined;
}

export interface McpSnapshotTool {
  readonly name: string;
  readonly dynamicToolMetaRole?: string | undefined;
}

export interface McpSnapshotToolSetHandle {
  getStaticTools(): readonly McpSnapshotTool[];
  getStaticTool(identifier: string): McpSnapshotTool | undefined;
  getDynamicToolRegistry(): {
    getMcpDescriptor(toolNames: McpSnapshotToolNames | undefined): McpDescriptorType | undefined;
  } | undefined;
}

export interface SnapshotMcpMetaToolOptions {
  readonly enabled: boolean;
  readonly mcpDescriptors: readonly McpDescriptorType[];
  readonly snapshotToolNames?: McpSnapshotToolNames | undefined;
}

function buildCustomUserToolsServerUseInstructions(
  customTools: readonly { readonly toolName: string; readonly description?: string | undefined }[],
  toolNames: McpSnapshotToolNames | undefined,
): string {
  const toolLines = customTools.map(tool => {
    const description = typeof tool.description === "string" && tool.description.length > 0 ? tool.description : "(no description provided)";
    return `- ${tool.toolName}: ${description}`;
  }).join("\n");
  const discoveryInvocationLine = toolNames
    ? `Discover tool schemas with \`${toolNames.discoveryToolName}\`, then invoke via \`${toolNames.invocationToolName}\` with ${toolNames.useDynamicToolNamespaces ? "namespace" : "server"} "${CUSTOM_USER_TOOLS_PROVIDER_ID}".`
    : `Discover tool schemas via MCP meta-tool discovery for server "${CUSTOM_USER_TOOLS_PROVIDER_ID}", then invoke via the MCP invocation meta-tool with that server.`;
  return `User-defined tools for this session. ${discoveryInvocationLine}\n\nAvailable tools:\n${toolLines}`;
}

function patchCustomUserToolsDescriptorInstructions(
  descriptors: readonly McpDescriptorType[],
  toolNames: McpSnapshotToolNames,
): McpDescriptorType[] {
  return descriptors.map(descriptor => {
    if (descriptor.serverIdentifier !== CUSTOM_USER_TOOLS_PROVIDER_ID) return descriptor;
    return new McpDescriptor({
      ...descriptor,
      serverUseInstructions: buildCustomUserToolsServerUseInstructions(descriptor.tools, toolNames),
    });
  });
}

function isReservedDynamicToolsNamespace(namespace: string): boolean {
  return namespace === CURSOR_DYNAMIC_TOOLS_NAMESPACE;
}

function withMcpMetaToolSnapshotToolNames(
  mcpMetaToolOptions: SnapshotMcpMetaToolOptions | undefined,
  snapshotToolNames: McpSnapshotToolNames | undefined,
  builtinToolsDescriptor: McpDescriptorType | undefined,
): SnapshotMcpMetaToolOptions | undefined {
  if (!mcpMetaToolOptions) return undefined;
  let mcpDescriptors = snapshotToolNames && mcpMetaToolOptions.mcpDescriptors.some(descriptor => descriptor.serverIdentifier === CUSTOM_USER_TOOLS_PROVIDER_ID)
    ? patchCustomUserToolsDescriptorInstructions(mcpMetaToolOptions.mcpDescriptors, {
      discoveryToolName: snapshotToolNames.discoveryToolName,
      invocationToolName: snapshotToolNames.invocationToolName,
      useDynamicToolNamespaces: snapshotToolNames.useDynamicToolNamespaces,
    })
    : mcpMetaToolOptions.mcpDescriptors;
  if (builtinToolsDescriptor !== undefined) {
    mcpDescriptors = [
      ...mcpDescriptors.filter(descriptor => !isReservedDynamicToolsNamespace(descriptor.serverIdentifier)),
      builtinToolsDescriptor,
    ];
  }
  return {
    ...mcpMetaToolOptions,
    mcpDescriptors,
    ...(snapshotToolNames ? { snapshotToolNames } : {}),
  };
}

export function getMcpMetaToolSnapshotToolNames(toolSetHandle: McpSnapshotToolSetHandle): McpSnapshotToolNames | undefined {
  const tools = toolSetHandle.getStaticTools();
  const getMcpToolsToolName = tools.find(tool => tool.dynamicToolMetaRole === "discovery")?.name;
  const callMcpToolName = tools.find(tool => tool.dynamicToolMetaRole === "invocation")?.name;
  const fetchMcpResourceName = toolSetHandle.getStaticTool("FETCH_MCP_RESOURCE")?.name;
  const useDynamicToolNamespaces = toolSetHandle.getDynamicToolRegistry() !== undefined;
  if (!getMcpToolsToolName || !callMcpToolName || !useDynamicToolNamespaces && !fetchMcpResourceName) return undefined;
  const listMcpResourcesName = toolSetHandle.getStaticTool("LIST_MCP_RESOURCES")?.name;
  return {
    discoveryToolName: getMcpToolsToolName,
    invocationToolName: callMcpToolName,
    useDynamicToolNamespaces,
    ...(fetchMcpResourceName ? { fetchMcpResourceToolName: fetchMcpResourceName } : {}),
    ...(listMcpResourcesName ? { listMcpResourcesToolName: listMcpResourcesName } : {}),
  };
}

export function withToolSetMcpSnapshot(
  mcpMetaToolOptions: SnapshotMcpMetaToolOptions | undefined,
  toolSetHandle: McpSnapshotToolSetHandle,
): SnapshotMcpMetaToolOptions | undefined {
  const toolNames = getMcpMetaToolSnapshotToolNames(toolSetHandle);
  return withMcpMetaToolSnapshotToolNames(
    mcpMetaToolOptions,
    toolNames,
    toolSetHandle.getDynamicToolRegistry()?.getMcpDescriptor(toolNames),
  );
}
