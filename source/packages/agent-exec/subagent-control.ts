import { SimpleControlledExecHandler } from "./controlled.js";
import type { ForceBackgroundSubagentArgs, ForceBackgroundSubagentResult } from "../proto/generated/agent/v1/subagent_exec_pb.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";

export const forceBackgroundSubagentExecutorResource = createResource<Executor<ForceBackgroundSubagentArgs, ForceBackgroundSubagentResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("forceBackgroundSubagentArgs"), createClientDeserializer("forceBackgroundSubagentResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("forceBackgroundSubagentArgs"), createClientSerializer("forceBackgroundSubagentResult"))),
);
