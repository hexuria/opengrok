import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { PiGrepExecArgs, PiGrepExecResult } from "../proto/generated/agent/v1/pi_grep_exec_pb.js";

export const piGrepExecutorResource = createResource<Executor<PiGrepExecArgs, PiGrepExecResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("piGrepArgs"), createClientDeserializer("piGrepResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("piGrepArgs"), createClientSerializer("piGrepResult"))),
);
