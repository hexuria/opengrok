import type { RedactedString } from "../../../redaction/types.js";
import { safeString } from "../../../redaction/factory.js";
import {
  McpExecToolNotFoundError,
  McpServerDoesNotExistError,
} from "./mcp-result-boundary.js";
import type { McpDescriptorSession } from "./mcp-call-options.js";

export type McpToolDefinitionReadCheck =
  | { readonly kind: "read" }
  | { readonly kind: "noServer"; readonly serverIdentifier: string }
  | { readonly kind: "noTool"; readonly toolName: string; readonly serverPath: string | undefined }
  | { readonly kind: "unread"; readonly unreadPath: string };

export interface McpReadPathStateHandler {
  hasReadPath(path: RedactedString): boolean;
}

export function validateMcpToolOnMcpToolDescriptors(
  session: McpDescriptorSession,
  serverIdentifier: string,
  toolName: string,
  getMcpToolsToolName: string,
  useDynamicToolNamespaces: boolean,
): void {
  const descriptor = session.serverDescriptors.get(serverIdentifier);
  if (descriptor === undefined) {
    throw new McpServerDoesNotExistError(
      serverIdentifier,
      `Use ${getMcpToolsToolName} to discover available ${useDynamicToolNamespaces ? "namespaces" : "servers"}.`,
    );
  }
  if (!descriptor.tools.some(tool => tool.toolName === toolName)) {
    throw new McpExecToolNotFoundError(
      `Tool ${toolName} was not found. Use ${getMcpToolsToolName} to discover available ${useDynamicToolNamespaces ? "namespaces" : "servers"} and their tools.`,
    );
  }
}

export function checkMcpToolDefinitionRead(
  session: McpDescriptorSession,
  mcpMetaToolEnabled: boolean,
  serverIdentifier: string,
  toolName: string,
  stateHandler: McpReadPathStateHandler | undefined,
): McpToolDefinitionReadCheck {
  if (stateHandler === undefined) return { kind: "read" };

  const serverDescriptor = session.serverDescriptors.get(serverIdentifier);
  if (serverDescriptor === undefined) {
    if (mcpMetaToolEnabled && session.serverDescriptors.size === 0) return { kind: "read" };
    return { kind: "noServer", serverIdentifier };
  }

  const definitionPath = session.toolDefinitionPaths.get(`${serverIdentifier}:${toolName}`);
  if (definitionPath === undefined) {
    if (mcpMetaToolEnabled) return { kind: "read" };
    return {
      kind: "noTool",
      toolName,
      serverPath: serverDescriptor.folderPath,
    };
  }
  if (stateHandler.hasReadPath(safeString(definitionPath))) return { kind: "read" };
  return { kind: "unread", unreadPath: definitionPath };
}
