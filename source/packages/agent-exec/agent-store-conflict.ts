import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { AgentStoreConflictArgs, AgentStoreConflictResult } from "../proto/generated/agent/v1/agent_store_conflict_exec_pb.js";

export const agentStoreConflictExecutorResource = createResource<Executor<AgentStoreConflictArgs, AgentStoreConflictResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("agentStoreConflictArgs"), createClientDeserializer("agentStoreConflictResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("agentStoreConflictArgs"), createClientSerializer("agentStoreConflictResult"))),
);
