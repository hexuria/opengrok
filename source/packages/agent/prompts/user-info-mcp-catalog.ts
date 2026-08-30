/**
 * MCP catalog prompt helpers recovered from the immutable host artifact.
 * Mac/Windows evidence: src/app/dist/host/host-main.cjs:550312-550330,
 * 550402-550415, and 555183-555190.
 *
 * The descriptor snapshot is already the normalized, gated input. These
 * helpers intentionally do not add auth, disabled-server, description, or
 * truncation policy; those belong to the snapshot/discovery owners.
 */
import { McpDescriptor } from "../../proto/generated/agent/v1/mcp_pb.js";
import type { McpDescriptor as McpDescriptorType } from "../../proto/generated/agent/v1/mcp_pb.js";
import { jsx, jsxs, Fragment } from "../../prompt-jsx/jsx-runtime.js";
import type { PromptNode } from "../../prompt-jsx/jsx-runtime.js";

const CURSOR_DYNAMIC_TOOLS_NAMESPACE = "cursor";
const CURSOR_APP_CONTROL_SERVER = "cursor-app-control";
const WORKSPACE_MUTATION_TOOLS = new Set([
  "move_agent_to_root",
  "move_agent_to_cloned_root",
  "create_project",
]);

function buildMcpMetaToolServerEntries(
  mcpDescriptors: readonly McpDescriptorType[],
  useDynamicToolNamespaces: boolean,
): string {
  return mcpDescriptors.map(d => {
    const attrs = [`name="${d.serverIdentifier}"`];
    const serverToolNames = d.tools.map(tool => tool.toolName).join(", ");
    if (serverToolNames.length > 0) attrs.push(`tools="${serverToolNames}"`);
    if (useDynamicToolNamespaces) {
      if (d.serverUseInstructions) {
        attrs.push(`namespaceUseInstructions="${d.serverUseInstructions}"`);
      }
      attrs.push(`source="${d.serverIdentifier === CURSOR_DYNAMIC_TOOLS_NAMESPACE ? "cursor" : "mcp"}"`);
      return `<namespace ${attrs.join(" ")} />`;
    }
    if (d.serverUseInstructions) {
      attrs.push(`serverUseInstructions="${d.serverUseInstructions}"`);
    }
    return `<mcp_meta_tool_server ${attrs.join(" ")} />`;
  }).join("\n");
}

export function McpMetaToolServerList(
  mcpDescriptors: readonly McpDescriptor[],
  useDynamicToolNamespaces = false,
): string {
  if (mcpDescriptors.length === 0) return "";
  const serverEntries = buildMcpMetaToolServerEntries(mcpDescriptors, useDynamicToolNamespaces);
  if (useDynamicToolNamespaces) {
    return `<dynamic_tool_namespaces>\n${serverEntries}\n</dynamic_tool_namespaces>`;
  }
  return `<mcp_meta_tool_servers>\n${serverEntries}\n</mcp_meta_tool_servers>`;
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

interface SnapshotToolNames {
  readonly discoveryToolName?: string | undefined;
  readonly invocationToolName?: string | undefined;
  readonly useDynamicToolNamespaces?: boolean | undefined;
}

interface McpMetaToolCatalogOptions {
  readonly mcpDescriptors: readonly McpDescriptorType[];
  readonly snapshotToolNames?: SnapshotToolNames | undefined;
}

export function McpMetaToolServersSection({
  mcpMetaToolOptions,
  mcpInfoComplete,
}: {
  readonly mcpMetaToolOptions: McpMetaToolCatalogOptions;
  readonly mcpInfoComplete?: boolean | undefined;
}): PromptNode {
  const useDynamicToolNamespaces = mcpMetaToolOptions.snapshotToolNames?.useDynamicToolNamespaces ?? false;
  const serverList = McpMetaToolServerList(mcpMetaToolOptions.mcpDescriptors, useDynamicToolNamespaces);
  if (serverList.length === 0 && mcpInfoComplete !== false) return null;
  return jsxs("section", {
    title: useDynamicToolNamespaces ? "dynamic_tool_catalog" : "mcp_server_catalog",
    children: [
      mcpInfoComplete === false && jsx("p", {
        children: useDynamicToolNamespaces
          ? "Dynamic namespace discovery is still warming. The namespace and tool list may be incomplete."
          : "MCP server discovery is still warming. The server and tool list below may be incomplete; additional servers may become available shortly.",
      }),
      jsxs("p", {
        children: [
          useDynamicToolNamespaces
            ? "These dynamic tool namespaces were available when this conversation started. Availability may have changed, so "
            : "These were the available MCP servers and tools when this conversation started. Tool availability may have changed since then, so ",
          mcpMetaToolOptions.snapshotToolNames
            ? jsxs(Fragment, {
              children: [
                "use `",
                mcpMetaToolOptions.snapshotToolNames.discoveryToolName,
                "` to check current state before calling `",
                mcpMetaToolOptions.snapshotToolNames.invocationToolName,
                "`.",
              ],
            })
            : jsx(Fragment, {
              children: "use the MCP tool-discovery meta tool to check current state before calling the MCP tool-invocation meta tool.",
            }),
        ],
      }),
      serverList,
    ],
  });
}
