import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { PiReadExecArgs, PiReadExecResult } from "../proto/generated/agent/v1/pi_read_exec_pb.js";

export const piReadExecutorResource = createResource<Executor<PiReadExecArgs, PiReadExecResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("piReadArgs"), createClientDeserializer("piReadResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("piReadArgs"), createClientSerializer("piReadResult"))),
);
