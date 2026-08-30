import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { PiWriteExecArgs, PiWriteExecResult } from "../proto/generated/agent/v1/pi_write_exec_pb.js";

export const piWriteExecutorResource = createResource<Executor<PiWriteExecArgs, PiWriteExecResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("piWriteArgs"), createClientDeserializer("piWriteResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("piWriteArgs"), createClientSerializer("piWriteResult"))),
);
