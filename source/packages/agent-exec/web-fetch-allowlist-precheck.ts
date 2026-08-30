import { SimpleControlledExecHandler } from "./controlled.js";
import type { WebFetchAllowlistPrecheckArgs, WebFetchAllowlistPrecheckResult } from "../proto/generated/agent/v1/web_fetch_allowlist_precheck_exec_pb.js";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./remote.js";
import { createResource, type ControlledExecManager } from "./resource-provider.js";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./serialization.js";

export const webFetchAllowlistPrecheckExecutorResource = createResource<Executor<WebFetchAllowlistPrecheckArgs, WebFetchAllowlistPrecheckResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("webFetchAllowlistPrecheckArgs"), createClientDeserializer("webFetchAllowlistPrecheckResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("webFetchAllowlistPrecheckArgs"), createClientSerializer("webFetchAllowlistPrecheckResult"))),
);
