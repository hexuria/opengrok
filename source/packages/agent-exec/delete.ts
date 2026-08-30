import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { DeleteArgs, DeleteResult } from "../proto/generated/agent/v1/delete_exec_pb.js";

export const deleteExecutorResource = createResource<Executor<DeleteArgs, DeleteResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("deleteArgs"), createClientDeserializer("deleteResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("deleteArgs"), createClientSerializer("deleteResult"))),
);
