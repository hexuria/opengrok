import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { ShellArgs, ShellResult } from "../proto/generated/agent/v1/shell_exec_pb.js";

export const miniSweAgentBashExecutorResource = createResource<Executor<ShellArgs, ShellResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("miniSweAgentBashArgs"), createClientDeserializer("miniSweAgentBashResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("miniSweAgentBashArgs"), createClientSerializer("miniSweAgentBashResult"))),
);
