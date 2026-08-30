import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { RecordScreenArgs, RecordScreenResult } from "../proto/generated/agent/v1/record_screen_exec_pb.js";

export const recordScreenExecutorResource = createResource<Executor<RecordScreenArgs, RecordScreenResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("recordScreenArgs"), createClientDeserializer("recordScreenResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("recordScreenArgs"), createClientSerializer("recordScreenResult"))),
);
