import { SimpleControlledExecHandler } from "./controlled.js";
import type { McpAllowlistPrecheckArgs, McpAllowlistPrecheckResult } from "../proto/generated/agent/v1/mcp_allowlist_precheck_exec_pb.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";

export const mcpAllowlistPrecheckExecutorResource = createResource<Executor<McpAllowlistPrecheckArgs, McpAllowlistPrecheckResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("mcpAllowlistPrecheckArgs"), createClientDeserializer("mcpAllowlistPrecheckResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("mcpAllowlistPrecheckArgs"), createClientSerializer("mcpAllowlistPrecheckResult"))),
);
