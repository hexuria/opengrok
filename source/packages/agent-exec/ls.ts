import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { LsArgs, LsResult } from "../proto/generated/agent/v1/ls_exec_pb.js";

export const lsExecutorResource = createResource<Executor<LsArgs, LsResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("lsArgs"), createClientDeserializer("lsResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("lsArgs"), createClientSerializer("lsResult"))),
);
