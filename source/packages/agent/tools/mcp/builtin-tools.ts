import { Value } from "@bufbuild/protobuf";

import { CURSOR_DYNAMIC_TOOLS_NAMESPACE } from "../../../agent-exec/mcp.js";
import {
  McpImageContent,
  McpResult as McpToolResult,
  McpSuccess,
  McpTextContent,
  McpToolResultContentItem,
} from "../../../proto/generated/agent/v1/mcp_exec_pb.js";
import { McpDescriptor, McpToolDescriptor } from "../../../proto/generated/agent/v1/mcp_pb.js";
import { getConciseStaticContext, buildDescriptionGeneratorProps } from "../core.js";

interface BuiltinTool {
  readonly name: string;
  readonly toolIdentifier?: string | undefined;
  readonly description?: string | undefined;
  readonly descriptionGenerator?: (props: Record<string, unknown>, options: { promptVisible: boolean }) => string;
  readonly contextType?: { readonly type?: string; readonly conciseStaticContext?: string } | undefined;
  readonly parameters: { readonly jsonSchema?: unknown };
}

interface DynamicToolRegistryOptions { readonly directToolRecoveryEnabled?: boolean | undefined }

function resolveToolDescription(tool: BuiltinTool, props: Record<string, unknown>): string | undefined {
  if ("descriptionGenerator" in tool) {
    return tool.descriptionGenerator!(props, { promptVisible: false });
  }
  return tool.description;
}

const BUILTIN_TOOLS_SERVER_USE_INSTRUCTIONS = "Native Cursor tools for this session. These are highly recommended and useful tools that you should use when the right situation arises. Don't be afraid to look at one if it seems relevant, even if you don't end up using it. You MUST read the tool schemas before calling them.";

function buildBuiltinToolsServerUseInstructions(tools: BuiltinTool[]): string {
  const lines = tools.flatMap(tool => {
    const text = getConciseStaticContext(tool.contextType);
    return text === undefined ? [] : [`- ${tool.name}: ${text}`];
  });
  if (lines.length === 0) return BUILTIN_TOOLS_SERVER_USE_INSTRUCTIONS;
  return [BUILTIN_TOOLS_SERVER_USE_INSTRUCTIONS, "", "Here are some crucial instructions:", ...lines].join("\n");
}

export class DynamicToolRegistry {
  private readonly options: DynamicToolRegistryOptions;
  private toolsByName = new Map<string, BuiltinTool>();
  private staticToolNames = new Set<string>();
  private descriptionProps: Record<string, unknown> = { allTools: {} };
  private cachedMcpDescriptors = new Map<string, McpDescriptor>();

  constructor(options: DynamicToolRegistryOptions = {}) {
    this.options = options;
  }

  replaceTools({ dynamicTools, allTools }: { dynamicTools: BuiltinTool[]; allTools: BuiltinTool[] }): void {
    const nextToolsByName = new Map<string, BuiltinTool>();
    for (const tool of dynamicTools) nextToolsByName.set(tool.name, tool);
    let nextStaticToolNames = new Set<string>();
    if (this.usesDirectToolRecovery()) {
      const dynamicToolSet = new Set(dynamicTools);
      nextStaticToolNames = new Set(allTools.filter(tool => !dynamicToolSet.has(tool)).map(tool => tool.name));
    }
    const nextDescriptionProps = buildDescriptionGeneratorProps(allTools as any);
    const descriptor = buildBuiltinToolsMcpDescriptorFromTools([...nextToolsByName.values()].sort((a, b) => a.name.localeCompare(b.name)), nextDescriptionProps);
    const nextCachedDescriptors = new Map<string, McpDescriptor>();
    if (descriptor !== undefined) nextCachedDescriptors.set("", descriptor);
    this.toolsByName = nextToolsByName;
    this.staticToolNames = nextStaticToolNames;
    this.descriptionProps = nextDescriptionProps;
    this.cachedMcpDescriptors = nextCachedDescriptors;
  }

  isEmpty(): boolean { return this.toolsByName.size === 0; }
  getTool(name: string): BuiltinTool | undefined { return this.toolsByName.get(name); }
  isStaticTool(name: string): boolean { return this.staticToolNames.has(name); }
  usesDirectToolRecovery(): boolean { return this.options.directToolRecoveryEnabled === true; }
  getTools(): BuiltinTool[] { return [...this.toolsByName.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  getToolNames(): string[] { return this.getTools().map(tool => tool.name); }
  getDescriptionProps(): Record<string, unknown> { return this.descriptionProps; }

  getMcpDescriptor(toolNames?: { discoveryToolName: string; invocationToolName: string }): McpDescriptor | undefined {
    const key = toolNames === undefined ? "" : `${toolNames.discoveryToolName}\0${toolNames.invocationToolName}`;
    const cached = this.cachedMcpDescriptors.get(key);
    if (cached !== undefined) return cached;
    const descriptor = buildBuiltinToolsMcpDescriptorFromTools(this.getTools(), this.descriptionProps);
    if (descriptor !== undefined) this.cachedMcpDescriptors.set(key, descriptor);
    return descriptor;
  }
}

function buildBuiltinToolsMcpDescriptorFromTools(tools: BuiltinTool[], descriptionProps: Record<string, unknown>): McpDescriptor | undefined {
  if (tools.length === 0) return undefined;
  const toolDescriptors = tools.map(tool => {
    const schema = tool.parameters.jsonSchema;
    return new McpToolDescriptor({
      toolName: tool.name,
      description: resolveToolDescription(tool, descriptionProps) as string,
      ...(schema !== undefined ? { inputSchema: Value.fromJson(schema as any) } : {}),
    });
  });
  return new McpDescriptor({
    serverIdentifier: CURSOR_DYNAMIC_TOOLS_NAMESPACE,
    serverName: CURSOR_DYNAMIC_TOOLS_NAMESPACE,
    serverUseInstructions: buildBuiltinToolsServerUseInstructions(tools),
    tools: toolDescriptors,
  });
}

export function isReservedDynamicToolsNamespace(namespace: string): boolean {
  return namespace === CURSOR_DYNAMIC_TOOLS_NAMESPACE;
}

export function resolveDynamicDispatchToolName(rawArgs: string, dynamicToolRegistry: Pick<DynamicToolRegistry, "getTool">): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const namespace = record["namespace"] ?? record["server"];
  if (typeof namespace !== "string" || !isReservedDynamicToolsNamespace(namespace)) return undefined;
  const toolName = record["toolName"];
  if (typeof toolName !== "string") return undefined;
  return dynamicToolRegistry.getTool(toolName)?.name;
}

export function agentToolResultToMcpToolResult(rendered: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }): McpToolResult {
  const content = rendered.content.map(item => {
    if (item.type === "text") {
      return new McpToolResultContentItem({
        content: { case: "text", value: new McpTextContent({ text: item.text! }) },
      });
    }
    if (item.type === "image") {
      return new McpToolResultContentItem({
        content: {
          case: "image",
          value: new McpImageContent({ data: Buffer.from(item.data!, "base64"), mimeType: item.mimeType ?? "image/png" }),
        },
      });
    }
    return new McpToolResultContentItem({
      content: { case: "text", value: new McpTextContent({ text: JSON.stringify(item) }) },
    });
  });
  return new McpToolResult({ result: { case: "success", value: new McpSuccess({ content, isError: rendered.isError as boolean }) } });
}
