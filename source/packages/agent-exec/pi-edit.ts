import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { PiEditExecArgs, PiEditExecResult } from "../proto/generated/agent/v1/pi_edit_exec_pb.js";

export const piEditExecutorResource = createResource<Executor<PiEditExecArgs, PiEditExecResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("piEditArgs"), createClientDeserializer("piEditResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("piEditArgs"), createClientSerializer("piEditResult"))),
);
