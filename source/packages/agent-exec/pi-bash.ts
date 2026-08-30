import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { PiBashExecArgs, PiBashExecResult } from "../proto/generated/agent/v1/pi_bash_exec_pb.js";

export const piBashExecutorResource = createResource<Executor<PiBashExecArgs, PiBashExecResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("piBashArgs"), createClientDeserializer("piBashResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("piBashArgs"), createClientSerializer("piBashResult"))),
);
