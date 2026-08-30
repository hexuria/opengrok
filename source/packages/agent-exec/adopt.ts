import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { AdoptArgs, AdoptResult } from "../proto/generated/agent/v1/adopt_tool_pb.js";

export const adoptExecutorResource = createResource<Executor<AdoptArgs, AdoptResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("adoptArgs"), createClientDeserializer("adoptResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("adoptArgs"), createClientSerializer("adoptResult"))),
);
