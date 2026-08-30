import type { McpDescriptor } from "../../proto/generated/agent/v1/mcp_pb.js";
import { McpMetaToolServerList } from "./user-info-mcp-catalog.js";
import { MCP_AUTH_INSTRUCTION } from "../utils/mcp-auth-instruction.js";

const TRUNCATED_DESCRIPTION_SUFFIX = "... [truncated]";

interface McpMetaToolInstructionNames {
  readonly discoveryToolName: string;
  readonly invocationToolName: string;
  readonly useDynamicToolNamespaces: boolean;
  readonly fetchMcpResourceToolName?: string | undefined;
  readonly listMcpResourcesToolName?: string | undefined;
}

function getMcpResourceAccessLine(toolNames: McpMetaToolInstructionNames): string | undefined {
  if (!toolNames.fetchMcpResourceToolName) return undefined;
  return toolNames.listMcpResourcesToolName
    ? `You also have access to MCP resources via \`${toolNames.listMcpResourcesToolName}\` and \`${toolNames.fetchMcpResourceToolName}\`.`
    : `You also have access to MCP resources via \`${toolNames.fetchMcpResourceToolName}\`.`;
}

function buildMcpMetaToolInstructions(
  toolNames: McpMetaToolInstructionNames,
  serverListSection: string,
): string {
  const { useDynamicToolNamespaces } = toolNames;
  const resourceAccessLine = getMcpResourceAccessLine(toolNames);
  const resourceAccessSection = resourceAccessLine ? `## MCP Resource Access

${resourceAccessLine}` : "";
  const mcpCapabilityFallbackLine = "\nIf the available MCP tools do not fully support what the user asked you to do, complete the work you can with the current tool set. In your work summary, include what you were unable to do with MCP and why. Do not use browser automation to work around missing or unavailable MCP tools unless the user explicitly asks you to use the browser.\n";
  const dynamicToolFallbackLine = "\nIf the available dynamic tools do not fully support what the user asked you to do, complete the work you can with the current tool set. In your work summary, include what you were unable to do and why. Do not use browser automation to work around missing tools unless the user explicitly asks you to use the browser.\n";
  if (useDynamicToolNamespaces) {
    return `<dynamic_tools>
You have access to tools through dynamic namespaces, e.g. MCP servers, using \`${toolNames.discoveryToolName}\` and \`${toolNames.invocationToolName}\`.

## Dynamic Tool Discovery and Invocation

Use \`${toolNames.discoveryToolName}\` to discover tool schemas, then \`${toolNames.invocationToolName}\` to invoke one tool. Aim to minimize round-trips: ideally one discovery call followed by one invocation.

If the user mentions a product or service represented by an available namespace, and the request likely depends on it, proactively inspect that namespace before answering. If you are unsure which namespace matches, search with a relevant pattern.

\`${toolNames.discoveryToolName}\` supports these modes:

1. \`{"namespace":"<id>"}\`: returns schemas and full descriptions for every tool in that namespace.
2. \`{"namespace":"<id>","toolName":"<name>"}\`: returns one tool schema with its full description.
3. \`{"pattern":"<regex>"}\`: searches namespace and tool names.
4. \`{"namespace":"<id>","pattern":"<regex>"}\`: searches tools within one namespace.
5. No arguments: returns the full catalog.

Pattern-search and catalog results shorten long descriptions, marked by a trailing "${TRUNCATED_DESCRIPTION_SUFFIX}"; namespace and single-tool lookups always return the complete description.

Always inspect a tool's schema before invoking it with \`${toolNames.invocationToolName}\`.
${dynamicToolFallbackLine}

${serverListSection}

${resourceAccessSection}
If an MCP-backed namespace requires authentication, call \`mcp_auth\` through \`${toolNames.invocationToolName}\` for that namespace, then inspect it again and retry if appropriate. Do not authenticate namespaces preemptively or repeatedly.
</dynamic_tools>`;
  }
  return `<mcp_meta_tools>
You have access to MCP (Model Context Protocol) tools through \`${toolNames.discoveryToolName}\` and \`${toolNames.invocationToolName}\`.

## MCP Tool Discovery and Invocation

Use \`${toolNames.discoveryToolName}\` to discover tool schemas, then \`${toolNames.invocationToolName}\` to invoke them. Aim to minimize round-trips: ideally one \`${toolNames.discoveryToolName}\` call followed by one \`${toolNames.invocationToolName}\` call.

If the user mentions, references, or links to a product or service that corresponds to an available MCP server, and the request likely depends on information from that service, proactively inspect that MCP server before answering. Do not wait for the user to explicitly ask you to use MCP. If you are unsure which server matches, use \`${toolNames.discoveryToolName}\` with a pattern based on the service name.

\`${toolNames.discoveryToolName}\` supports four modes:

1. \`{"server":"<id>"}\`: returns full input schemas and full descriptions for every tool on that server. Preferred when you know which server to use.
2. \`{"server":"<id>","toolName":"<name>"}\`: returns the full schema and full description for one tool.
3. \`{"pattern":"<regex>"}\`: searches tool and server names across all servers using RE2 syntax (no backreferences, lookahead, or lookbehind). Use when you're unsure which server has the tool you need.
4. No arguments: returns a catalog of all servers with tool names and short descriptions. Only use this if you have no idea which server or tool to look for — in most cases, prefer fetching by server or pattern instead.

Pattern-search and catalog results shorten long descriptions, marked by a trailing "${TRUNCATED_DESCRIPTION_SUFFIX}"; server and single-tool lookups always return the complete description.

MANDATORY - Always call \`${toolNames.discoveryToolName}\` to discover a tool's schema before invoking it with \`${toolNames.invocationToolName}\`. If you already know the server, go directly to it rather than listing the full catalog first.
${mcpCapabilityFallbackLine}

${serverListSection}

${resourceAccessSection}
${MCP_AUTH_INSTRUCTION}
</mcp_meta_tools>`;
}

export function McpMetaToolInstructions(
  mcpDescriptors: readonly McpDescriptor[],
  toolNames: McpMetaToolInstructionNames,
): string {
  if (mcpDescriptors.length === 0) return "";
  const { useDynamicToolNamespaces } = toolNames;
  const serverListSection = useDynamicToolNamespaces
    ? `Available dynamic tool namespaces:\n\n${McpMetaToolServerList(mcpDescriptors, true)}`
    : `Available MCP servers:\n\n${McpMetaToolServerList(mcpDescriptors)}`;
  return buildMcpMetaToolInstructions(toolNames, serverListSection);
}
