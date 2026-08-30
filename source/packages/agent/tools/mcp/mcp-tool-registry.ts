import { ToolSetHandle } from "../core.js";
import {
  createCallMcpTool,
  type CreateCallMcpToolOptions,
} from "./mcp.js";
import { createGetMcpToolsTool } from "./get-mcp-tools.js";

export interface McpToolRegistryOptions extends CreateCallMcpToolOptions {
  readonly existingTools?: readonly Record<string, unknown>[] | undefined;
  readonly projectDir?: string | undefined;
}

/**
 * Installs the MCP invocation tool into the same ToolSetHandle consumed by
 * agent action handlers. Discovery remains an independently owned factory;
 * callers may add it through existingTools when that owner is available.
 */
export function createMcpToolRegistry(
  options: McpToolRegistryOptions,
): ToolSetHandle {
  const { existingTools = [], projectDir, ...callOptions } = options;
  const discoveryTool = options.mcpMetaToolOptions === undefined
    ? undefined
    : createGetMcpToolsTool(options.mcpMetaToolOptions, {
      ...(options.resourceAccessor === undefined ? {} : { resourceAccessor: options.resourceAccessor }),
      ...(projectDir === undefined ? {} : { projectDir }),
      ...(options.allowInteractiveMcpAuth === undefined ? {} : { allowInteractiveMcpAuth: options.allowInteractiveMcpAuth }),
      ...(options.dynamicToolRegistry === undefined ? {} : { dynamicToolRegistry: options.dynamicToolRegistry }),
      ...(options.isMcpToolBlocked === undefined ? {} : { isMcpToolBlocked: options.isMcpToolBlocked }),
      ...(options.name === undefined ? {} : { callMcpToolName: options.name }),
    });
  const callMcpTool = createCallMcpTool(callOptions);
  return ToolSetHandle.fromTools([
    ...existingTools,
    ...(discoveryTool === undefined ? [] : [discoveryTool]),
    callMcpTool,
  ]);
}
