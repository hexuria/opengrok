import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { WriteArgs, WriteResult } from "../proto/generated/agent/v1/write_exec_pb.js";

export type WriteExecutorArgs = WriteArgs;
export type WriteExecResult = WriteResult["result"];
export type WriteExecResponse = WriteResult;
export type WriteExecutor = Executor<WriteExecutorArgs, WriteExecResponse>;

export const writeExecutorResource = createResource<WriteExecutor, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("writeArgs"), createClientDeserializer("writeResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("writeArgs"), createClientSerializer("writeResult"))),
);
