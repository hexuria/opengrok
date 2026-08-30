import { SimpleControlledExecHandler } from "./controlled.js";
import type { ShellAllowlistPrecheckArgs, ShellAllowlistPrecheckResult } from "../proto/generated/agent/v1/shell_allowlist_precheck_exec_pb.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";

export const shellAllowlistPrecheckExecutorResource = createResource<Executor<ShellAllowlistPrecheckArgs, ShellAllowlistPrecheckResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("shellAllowlistPrecheckArgs"), createClientDeserializer("shellAllowlistPrecheckResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("shellAllowlistPrecheckArgs"), createClientSerializer("shellAllowlistPrecheckResult"))),
);
