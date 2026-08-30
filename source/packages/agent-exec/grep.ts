import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { GrepArgs, GrepResult } from "../proto/generated/agent/v1/grep_exec_pb.js";

export const grepExecutorResource = createResource<Executor<GrepArgs, GrepResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("grepArgs"), createClientDeserializer("grepResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("grepArgs"), createClientSerializer("grepResult"))),
);
