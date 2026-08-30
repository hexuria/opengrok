import { spotlightToolResultContent, type SpotlightContentPart } from "../../../shared/sand-spotlight.js";
import { ToolSetHandle } from "../../../packages/agent/tools/core.js";
import { partitionDynamicTools } from "../../../packages/agent/tools/exclude-tools.js";
import type { DynamicToolRegistry } from "../../../packages/agent/tools/mcp/builtin-tools.js";

export interface SandTool {
  readonly name: string;
  readonly toolIdentifier?: string;
  readonly dynamic?: boolean;
  readonly dynamicToolMetaRole?: string;
  readonly customToolFormat?: unknown;
  readonly contextType?: { readonly type?: string };
  readonly render?: (...args: readonly unknown[]) => Promise<{ content: unknown; readonly [key: string]: unknown }>;
}
export function withSpotlightedToolResult<T extends SandTool>(tool: T): T {
  if (tool.render === undefined) return tool;
  return {
    ...tool,
    render: async (...args: readonly unknown[]) => {
      const result = await tool.render!(...args);
      const content = Array.isArray(result.content)
        ? spotlightToolResultContent(tool.name, result.content as SpotlightContentPart[])
        : result.content;
      return { ...result, content };
    },
  };
}
export function fencedToolSet<T extends SandTool>(
  tools: readonly T[],
  enabled: boolean,
  dynamicToolRegistry?: Pick<DynamicToolRegistry, "replaceTools">,
): ToolSetHandle {
  const finalTools = enabled ? tools.map((tool) => withSpotlightedToolResult(tool)) : [...tools];
  if (dynamicToolRegistry === undefined) return ToolSetHandle.fromTools(finalTools);
  const { staticTools, dynamicTools } = partitionDynamicTools(finalTools, "final");
  return ToolSetHandle.fromTools({ staticTools, dynamicTools, dynamicToolRegistry });
}
