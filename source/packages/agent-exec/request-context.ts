import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { RequestContextArgs, RequestContextResult } from "../proto/generated/agent/v1/request_context_exec_pb.js";

export const requestContextExecutorResource = createResource<Executor<RequestContextArgs, RequestContextResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("requestContextArgs"), createClientDeserializer("requestContextResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("requestContextArgs"), createClientSerializer("requestContextResult"))),
);
