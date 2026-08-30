import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { DiagnosticsArgs, DiagnosticsResult } from "../proto/generated/agent/v1/diagnostics_exec_pb.js";

export const diagnosticsExecutorResource = createResource<Executor<DiagnosticsArgs, DiagnosticsResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("diagnosticsArgs"), createClientDeserializer("diagnosticsResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("diagnosticsArgs"), createClientSerializer("diagnosticsResult"))),
);
