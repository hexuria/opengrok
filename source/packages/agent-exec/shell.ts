import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { ShellArgs, ShellResult } from "../proto/generated/agent/v1/shell_exec_pb.js";

export type ShellExecutorArgs = ShellArgs;
export type ShellExecResult = ShellResult["result"];
export type ShellExecResponse = ShellResult;
export type ShellExecutor = Executor<ShellExecutorArgs, ShellExecResponse>;

export const shellExecutorResource = createResource<ShellExecutor, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("shellArgs"), createClientDeserializer("shellResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("shellArgs"), createClientSerializer("shellResult"))),
);
