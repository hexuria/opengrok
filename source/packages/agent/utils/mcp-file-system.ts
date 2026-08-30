import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.js";
import type { McpDescriptor, McpFileSystemOptions, McpMetaToolOptions } from "../../proto/generated/agent/v1/mcp_pb.js";
import { McpFileSystemInstructions } from "../prompts/deprecated-do-not-use/shared.js";
import { MCP_AUTH_INSTRUCTION } from "./mcp-auth-instruction.js";

export interface Dsv3McpFileSystemModelInfo {
  readonly isComposerMatterhorn?: boolean | undefined;
  readonly isRawTrainingSlug?: boolean | undefined;
}

export interface Dsv3McpFileSystemParams {
  readonly mode?: AgentMode | undefined;
  readonly enableFilterEditToolsInAskMode?: boolean | undefined;
  readonly mcpFileSystemOptions?: McpFileSystemOptions | undefined;
  readonly mcpMetaToolOptions?: McpMetaToolOptions | undefined;
  readonly featureFlags?: { readonly enableMCPFileSystem?: boolean | undefined } | undefined;
  readonly modelInfo?: Dsv3McpFileSystemModelInfo | undefined;
}

export function getDsv3McpFileSystemToolNames(
  modelInfo: Dsv3McpFileSystemModelInfo | undefined,
): {
  readonly callMcpTool: string;
  readonly listMcpResources: string;
  readonly fetchMcpResource: string;
} {
  if (modelInfo?.isComposerMatterhorn === true && modelInfo.isRawTrainingSlug !== true) {
    return {
      callMcpTool: "CallMcpTool",
      listMcpResources: "ListMcpResources",
      fetchMcpResource: "FetchMcpResource",
    };
  }
  return {
    callMcpTool: "call_mcp_tool",
    listMcpResources: "list_mcp_resources",
    fetchMcpResource: "fetch_mcp_resource",
  };
}

export function getDsv3McpFileSystemInstructions(params: Dsv3McpFileSystemParams): string {
  const isAskMode = params.mode === AgentMode.ASK;
  const shouldFilterEditToolsInAskMode = isAskMode && (params.enableFilterEditToolsInAskMode ?? true);
  if (shouldFilterEditToolsInAskMode) {
    return "";
  }
  if (params.mcpMetaToolOptions?.enabled === true) {
    return "";
  }
  const mcpFileSystemOptions = params.mcpFileSystemOptions;
  const mcpDescriptorsCount = mcpFileSystemOptions?.mcpDescriptors.length ?? 0;
  const hasMcpDescriptors = mcpDescriptorsCount > 0;
  const isMcpFileSystemEnabled = mcpFileSystemOptions?.enabled ?? false;
  const isMcpFileSystemCompatible = params.featureFlags?.enableMCPFileSystem === true;
  if (!isMcpFileSystemEnabled || !isMcpFileSystemCompatible || !hasMcpDescriptors || !mcpFileSystemOptions) {
    return "";
  }
  const instructions = McpFileSystemInstructions({
    workspaceProjectDir: mcpFileSystemOptions.workspaceProjectDir,
    mcpDescriptors: mcpFileSystemOptions.mcpDescriptors as unknown as readonly {
      readonly serverIdentifier: string;
      readonly folderPath: string;
      readonly serverUseInstructions?: string | undefined;
    }[],
  }, {
    ...getDsv3McpFileSystemToolNames(params.modelInfo),
    mcpAuthInstruction: MCP_AUTH_INSTRUCTION,
  });
  return `${instructions}

If the available MCP tools do not fully support what the user asked you to do, complete the work you can with the current tool set. In your work summary, include what you were unable to do with MCP and why. Do not use browser automation to work around missing or unavailable MCP tools unless the user explicitly asks you to use the browser.`;
}
