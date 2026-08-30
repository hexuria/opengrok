import { SimpleControlledExecHandler } from "./controlled.js";
import type { ForceBackgroundShellArgs, ForceBackgroundShellResult } from "../proto/generated/agent/v1/shell_exec_pb.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";

export const forceBackgroundShellExecutorResource = createResource<Executor<ForceBackgroundShellArgs, ForceBackgroundShellResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("forceBackgroundShellArgs"), createClientDeserializer("forceBackgroundShellResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("forceBackgroundShellArgs"), createClientSerializer("forceBackgroundShellResult"))),
);
