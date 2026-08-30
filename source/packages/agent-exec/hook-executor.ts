import { SimpleControlledExecHandler } from "./controlled.js";
import type { ExecuteHookArgs, ExecuteHookResult } from "../proto/generated/agent/v1/exec_pb.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";

export const hookExecutorResource = createResource<Executor<ExecuteHookArgs, ExecuteHookResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("executeHookArgs"), createClientDeserializer("executeHookResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("executeHookArgs"), createClientSerializer("executeHookResult"))),
);
