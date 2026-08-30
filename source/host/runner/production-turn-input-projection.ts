import type { Context } from "../../packages/context/core.js";
import type {
  ConversationAction,
  ConversationStateStructure,
} from "../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  createTurnAgentRunInputProjection,
  type TurnAgentMcpTurnProvider,
} from "./turn-agent-composition.js";
import type {
  ProductionTurnCancelThisRun,
  ProductionTurnEmitUpdate,
} from "../runner-production-bridge.js";

/**
 * Inputs owned by the future host prepareTurn caller.  The action callback is
 * required to return generated proto values; this boundary never coerces the
 * structural prompt collector output.  MCP is optional and remains absent on
 * turns where the manager/provider is unavailable.
 */
export interface ProductionTurnAgentInputProjectionInput {
  readonly runCtx: Context;
  readonly createAction: (runCtx: Context) => Promise<ConversationAction>;
  readonly mcp?: TurnAgentMcpTurnProvider;
  readonly onMcpDiscoveryFailed?: (error: unknown) => void;
  readonly getConversationState: () => ConversationStateStructure;
  readonly ackToken?: string | undefined;
  readonly cancelThisRun?: ProductionTurnCancelThisRun;
  readonly emitUpdate?: ProductionTurnEmitUpdate;
}

/**
 * Exact typed handoff immediately before stream construction.  The producer
 * order is owned by createTurnAgentRunInputProjection: generated action,
 * optional MCP discovery, account refresh, then a binary-cloned state.  The
 * remaining turn-scope identities are copied without wrapping or caching.
 */
export interface ProductionTurnAgentInputProjection {
  readonly action: ConversationAction;
  readonly mcpTools: readonly unknown[];
  readonly baseState: ConversationStateStructure;
  readonly ackToken?: string | undefined;
  readonly cancelThisRun?: ProductionTurnCancelThisRun;
  readonly emitUpdate?: ProductionTurnEmitUpdate;
}

export async function createProductionTurnAgentInputProjection(
  input: ProductionTurnAgentInputProjectionInput,
): Promise<ProductionTurnAgentInputProjection> {
  const projected = await createTurnAgentRunInputProjection({
    runCtx: input.runCtx,
    createAction: input.createAction,
    ...(input.mcp === undefined ? {} : { mcp: input.mcp }),
    ...(input.onMcpDiscoveryFailed === undefined
      ? {}
      : { onMcpDiscoveryFailed: input.onMcpDiscoveryFailed }),
    getConversationState: input.getConversationState,
  });
  return {
    action: projected.action,
    mcpTools: projected.mcpTools,
    baseState: projected.baseState,
    ...(input.ackToken === undefined ? {} : { ackToken: input.ackToken }),
    ...(input.cancelThisRun === undefined
      ? {}
      : { cancelThisRun: input.cancelThisRun }),
    ...(input.emitUpdate === undefined ? {} : { emitUpdate: input.emitUpdate }),
  };
}
