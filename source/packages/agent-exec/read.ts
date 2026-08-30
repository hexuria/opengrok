import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { ReadArgs, ReadResult } from "../proto/generated/agent/v1/read_exec_pb.js";

export type ReadExecutorArgs = ReadArgs;
export type ReadExecutor = Executor<ReadExecutorArgs, ReadResult>;

export const readExecutorResource = createResource<ReadExecutor, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("readArgs"), createClientDeserializer("readResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("readArgs"), createClientSerializer("readResult"))),
);
export const redactedReadExecutorResource = createResource<Executor<ReadArgs, ReadResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("redactedReadArgs"), createClientDeserializer("redactedReadResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("redactedReadArgs"), createClientSerializer("redactedReadResult"))),
);
