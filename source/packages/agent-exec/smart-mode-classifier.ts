import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { SmartModeClassifierArgs, SmartModeClassifierResult } from "../proto/generated/agent/v1/smart_mode_classifier_exec_pb.js";

export const smartModeClassifierExecutorResource = createResource<Executor<SmartModeClassifierArgs, SmartModeClassifierResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("smartModeClassifierArgs"), createClientDeserializer("smartModeClassifierResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("smartModeClassifierArgs"), createClientSerializer("smartModeClassifierResult"))),
);
