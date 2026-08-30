import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { FetchArgs, FetchResult } from "../proto/generated/agent/v1/fetch_exec_pb.js";

export const fetchExecutorResource = createResource<Executor<FetchArgs, FetchResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("fetchArgs"), createClientDeserializer("fetchResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("fetchArgs"), createClientSerializer("fetchResult"))),
);
