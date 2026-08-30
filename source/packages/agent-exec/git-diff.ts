import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { GetDiffRequest, GetDiffResponse } from "../proto/generated/aiserver/v1/utils_pb.js";

export const gitDiffExecutorResource = createResource<Executor<GetDiffRequest, GetDiffResponse>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("gitDiffRequest"), createClientDeserializer("gitDiffResponse")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("gitDiffRequest"), createClientSerializer("gitDiffResponse"))),
);
