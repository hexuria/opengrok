import type { createRedactedConversationTokenDetails } from "../../redacted-protos/generated/agent/v1/agent_redacted.js";

export type RunStepTokenDetails = ReturnType<typeof createRedactedConversationTokenDetails>;

export interface RunStepTurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}

export interface RunStepCheckpointState {
  pendingToolCalls: unknown[];
}

/**
 * The state surface directly consumed by the immutable runStep checkpoint and
 * token-accounting branches. The state implementation remains state.ts-owned.
 */
export interface RunStepStateHandlerContract<Context = unknown, State extends RunStepCheckpointState = RunStepCheckpointState> {
  computeNewStructure(ctx: Context): Promise<State> | State;
  setTokenDetails(tokenDetails: RunStepTokenDetails): void;
  addTurnUsage(usage: RunStepTurnUsage): void;
}

/** Exact config controls used by runStep's pending/error checkpoint branches. */
export interface RunStepCheckpointControls {
  readonly fireAndForgetCheckpoints: boolean;
  readonly skipErrorStateCheckpoint: boolean;
}
