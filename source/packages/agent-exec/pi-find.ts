import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { PiFindExecArgs, PiFindExecResult } from "../proto/generated/agent/v1/pi_find_exec_pb.js";

export const piFindExecutorResource = createResource<Executor<PiFindExecArgs, PiFindExecResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("piFindArgs"), createClientDeserializer("piFindResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("piFindArgs"), createClientSerializer("piFindResult"))),
);
