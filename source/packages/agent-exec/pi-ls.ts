import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { PiLsExecArgs, PiLsExecResult } from "../proto/generated/agent/v1/pi_ls_exec_pb.js";

export const piLsExecutorResource = createResource<Executor<PiLsExecArgs, PiLsExecResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("piLsArgs"), createClientDeserializer("piLsResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("piLsArgs"), createClientSerializer("piLsResult"))),
);
