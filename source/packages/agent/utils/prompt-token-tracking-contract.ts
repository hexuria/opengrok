import type { Context } from "../../context/core.js";
import type { RequestContext } from "../../proto/generated/agent/v1/request_context_exec_pb.js";
import type { CoreMessageLike } from "../../redaction/core-message.js";

/**
 * Exact owner call surface consumed by the handler's step runner.
 * The runtime tracker remains separate until its prompt-section dependencies are recovered.
 */
export interface TrackPromptTokenUsageInput {
  readonly ctx: Context;
  readonly mcpTools: readonly unknown[];
  readonly requestContext: RequestContext;
  readonly messages: readonly CoreMessageLike[];
  readonly selectedContext: unknown;
  readonly userInfoDisplayOptions: unknown;
  readonly agentTokenLimit: number | undefined;
  readonly readToolName: string | undefined;
  readonly invocationId: string;
  readonly modelInfo: unknown;
  readonly featureFlags: unknown;
  readonly stateHandler: {
    lastSkillCatalogBudgetStrategy?: string | undefined;
  };
}

export type TrackPromptTokenUsage = (
  params: TrackPromptTokenUsageInput,
) => void;
