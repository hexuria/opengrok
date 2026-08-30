import type { Context } from "../../context/core.js";
import type { AgentMode } from "../../proto/generated/agent/v1/agent_pb.js";
import type { FileOperationLockManager } from "./core/file-operation-lock-manager.js";
import type { ToolSetHandle } from "./core.js";

/**
 * Exact builder input observed at the immutable UserMessageActionHandler call site.
 * Keep this contract independent from handler configuration and state ownership.
 */
export interface AgentToolsGeneratorInput {
  readonly resourceAccessor: unknown;
  readonly stateHandler: {
    getBlobStore(): unknown;
  };
  readonly agentSessionId: string | undefined;
  readonly mcpTools: readonly unknown[];
  readonly repositoryInfos: readonly unknown[];
  readonly blobStore: unknown;
  readonly mode: AgentMode;
  readonly loggingContext: Context;
  readonly requestContext: unknown;
  readonly fileOperationLockManager: FileOperationLockManager;
  readonly smartModeClassifierMode: unknown;
  readonly smartModeClassifierShadowMode: unknown;
  readonly autoRejectFirstAskQuestion: boolean | undefined;
}

export type AgentToolsGenerator = (
  input: AgentToolsGeneratorInput,
) => ToolSetHandle;
