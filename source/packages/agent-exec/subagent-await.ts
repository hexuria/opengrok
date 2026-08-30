import { SimpleControlledExecHandler } from "./controlled.js";
import type { SubagentAwaitArgs, SubagentAwaitResult } from "../proto/generated/agent/v1/subagent_exec_pb.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";

export const subagentAwaitExecutorResource = createResource<Executor<SubagentAwaitArgs, SubagentAwaitResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("subagentAwaitArgs"), createClientDeserializer("subagentAwaitResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("subagentAwaitArgs"), createClientSerializer("subagentAwaitResult"))),
);
