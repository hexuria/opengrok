import { SimpleControlledExecHandler } from "./controlled.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { CanvasDiagnosticsArgs, CanvasDiagnosticsResult } from "../proto/generated/agent/v1/canvas_diagnostics_exec_pb.js";

export const canvasDiagnosticsExecutorResource = createResource<Executor<CanvasDiagnosticsArgs, CanvasDiagnosticsResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("canvasDiagnosticsArgs"), createClientDeserializer("canvasDiagnosticsResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("canvasDiagnosticsArgs"), createClientSerializer("canvasDiagnosticsResult"))),
);
