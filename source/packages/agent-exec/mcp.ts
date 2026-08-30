import type { JsonValue } from "@bufbuild/protobuf";
import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer
} from "./serialization.js";
import type {
  ListMcpResourcesExecArgs,
  ListMcpResourcesExecResult,
  McpArgs,
  McpResult,
  McpStateExecArgs,
  McpStateExecResult,
  ReadMcpResourceExecArgs,
  ReadMcpResourceExecResult
} from "../proto/generated/agent/v1/mcp_exec_pb.js";

export const CURSOR_PLAYWRIGHT_PROVIDER_ID = "cursor-browser-extension";
export const CURSOR_IDE_BROWSER_PROVIDER_ID = "cursor-ide-browser";
export const CURSOR_SELF_CONTROL_PROVIDER_ID = "cursor-dev-control";
export const CUSTOM_USER_TOOLS_PROVIDER_ID = "custom-user-tools";

export const NON_AUTHENTICATABLE_MCP_PROVIDER_IDS = new Set([
  "cursor-app-control",
  "cursor-backend-control",
  CURSOR_PLAYWRIGHT_PROVIDER_ID,
  CURSOR_IDE_BROWSER_PROVIDER_ID,
  CURSOR_SELF_CONTROL_PROVIDER_ID,
  CUSTOM_USER_TOOLS_PROVIDER_ID,
  "fsd"
]);

export const CURSOR_DYNAMIC_TOOLS_NAMESPACE = "cursor";

export const BROWSER_MCP_PROVIDER_IDS = new Set([
  CURSOR_SELF_CONTROL_PROVIDER_ID,
  CURSOR_IDE_BROWSER_PROVIDER_ID
]);

export enum McpLeaseChangeReason {
  Snapshots = "cursor_mcp_lease_snapshot_store",
  Status = "cursor_mcp_lease_server_status",
  Settings = "cursor_mcp_lease_settings",
  Providers = "cursor_mcp_lease_providers",
  Unknown = "cursor_mcp_lease_unknown"
}

export interface McpToolFileLike {
  readonly toolName: string;
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly plugin?: string | undefined;
  readonly marketplace?: string | undefined;
  readonly pluginId?: string | undefined;
  readonly marketplaceId?: string | undefined;
}

export interface McpInputSchemaLike {
  readonly inputSchemaJson?: string | undefined;
  readonly inputSchema?: { toJson(): JsonValue } | undefined;
}

export interface McpLeaseChangeEvent {
  readonly serverIdentifiers?: readonly string[] | undefined;
  readonly reason?: string | undefined;
}

export function supportsInteractiveMcpAuth(serverIdentifier: string): boolean {
  return !NON_AUTHENTICATABLE_MCP_PROVIDER_IDS.has(serverIdentifier);
}

export function buildMcpToolFileContent(tool: McpToolFileLike): {
  readonly name: string;
  readonly description: string | undefined;
  readonly arguments: unknown;
  readonly outputSchema: unknown;
  readonly plugin: string | undefined;
  readonly marketplace: string | undefined;
  readonly pluginId: string | undefined;
  readonly marketplaceId: string | undefined;
} {
  return {
    name: tool.toolName,
    description: tool.description,
    arguments: tool.inputSchema,
    outputSchema: tool.outputSchema,
    plugin: tool.plugin,
    marketplace: tool.marketplace,
    pluginId: tool.pluginId,
    marketplaceId: tool.marketplaceId
  };
}

export function parseMcpInputSchemaJson(inputSchemaJson: string | undefined): JsonValue | undefined {
  if (inputSchemaJson === undefined) return undefined;
  try {
    return JSON.parse(inputSchemaJson) as JsonValue;
  } catch {
    return undefined;
  }
}

export function mcpInputSchemaToJson(tool: McpInputSchemaLike): JsonValue | undefined {
  return parseMcpInputSchemaJson(tool.inputSchemaJson) ?? tool.inputSchema?.toJson();
}

export function isFullMcpLeaseInvalidation(event: McpLeaseChangeEvent | undefined): boolean {
  return event === undefined || event.serverIdentifiers === undefined;
}

export function mergeMcpLeaseEvents(
  ...events: Array<McpLeaseChangeEvent | undefined>
): McpLeaseChangeEvent | undefined {
  const [a, b] = events;
  if (events.length < 2) return a;
  if (isFullMcpLeaseInvalidation(b)) {
    return { serverIdentifiers: undefined, reason: a?.reason ?? b?.reason };
  }
  if (a === undefined) return b;
  if (isFullMcpLeaseInvalidation(a)) {
    return { serverIdentifiers: undefined, reason: a.reason ?? b?.reason };
  }
  return {
    serverIdentifiers: [
      ...new Set([...(a.serverIdentifiers ?? []), ...(b?.serverIdentifiers ?? [])])
    ],
    reason: a.reason ?? b?.reason
  };
}

export function mcpServerUnavailableReason(status: string): string | undefined {
  switch (status) {
    case "needsAuth":
      return "This MCP server requires authentication before its tools can be used.";
    case "error":
      return "This MCP server failed during live tool discovery. Its tools are unavailable until the connection is fixed.";
    case "loading":
      return "This MCP server is still loading; tools may not be available yet.";
    default:
      return undefined;
  }
}

export const mcpExecutorResource = createResource<
  Executor<McpArgs, McpResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("mcpArgs"),
    createClientDeserializer("mcpResult")
  ),
  (implementation, controlledExecManager) => {
    controlledExecManager.register(new SimpleControlledExecHandler(
      implementation,
      createServerDeserializer("mcpArgs"),
      createClientSerializer("mcpResult")
    ));
  }
);

export const listMcpResourcesExecutorResource = createResource<
  Executor<ListMcpResourcesExecArgs, ListMcpResourcesExecResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("listMcpResourcesExecArgs"),
    createClientDeserializer("listMcpResourcesExecResult")
  ),
  (implementation, controlledExecManager) => {
    controlledExecManager.register(new SimpleControlledExecHandler(
      implementation,
      createServerDeserializer("listMcpResourcesExecArgs"),
      createClientSerializer("listMcpResourcesExecResult")
    ));
  }
);

export const readMcpResourceExecutorResource = createResource<
  Executor<ReadMcpResourceExecArgs, ReadMcpResourceExecResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("readMcpResourceExecArgs"),
    createClientDeserializer("readMcpResourceExecResult")
  ),
  (implementation, controlledExecManager) => {
    controlledExecManager.register(new SimpleControlledExecHandler(
      implementation,
      createServerDeserializer("readMcpResourceExecArgs"),
      createClientSerializer("readMcpResourceExecResult")
    ));
  }
);

export const mcpStateExecutorResource = createResource<
  Executor<McpStateExecArgs, McpStateExecResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  execManager => new ExecutorResource(
    execManager,
    createServerSerializer("mcpStateExecArgs"),
    createClientDeserializer("mcpStateExecResult")
  ),
  (implementation, controlledExecManager) => {
    controlledExecManager.register(new SimpleControlledExecHandler(
      implementation,
      createServerDeserializer("mcpStateExecArgs"),
      createClientSerializer("mcpStateExecResult")
    ));
  }
);
