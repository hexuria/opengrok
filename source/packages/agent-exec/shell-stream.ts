import { SimpleControlledStreamExecHandler } from "./controlled.js";
import { StreamExecutorResource, type RemoteExecManager, type StreamExecutor } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";
import type { ShellArgs, ShellStream } from "../proto/generated/agent/v1/shell_exec_pb.js";

export const shellStreamExecutorResource = createResource<StreamExecutor<ShellArgs, ShellStream>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new StreamExecutorResource(execManager, createServerSerializer("shellStreamArgs"), createClientDeserializer("shellStream")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledStreamExecHandler(implementation, createServerDeserializer("shellStreamArgs"), createClientSerializer("shellStream"))),
);
