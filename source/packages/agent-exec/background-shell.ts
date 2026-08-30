import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { BackgroundShellSpawnArgs, BackgroundShellSpawnResult, WriteShellStdinArgs, WriteShellStdinResult } from "../proto/generated/agent/v1/background_shell_exec_pb.js";

export const backgroundShellExecutorResource = createResource<Executor<BackgroundShellSpawnArgs, BackgroundShellSpawnResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("backgroundShellSpawnArgs"), createClientDeserializer("backgroundShellSpawnResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("backgroundShellSpawnArgs"), createClientSerializer("backgroundShellSpawnResult"))),
);
export const writeBackgroundShellInputExecutorResource = createResource<Executor<WriteShellStdinArgs, WriteShellStdinResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("writeShellStdinArgs"), createClientDeserializer("writeShellStdinResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("writeShellStdinArgs"), createClientSerializer("writeShellStdinResult"))),
);
