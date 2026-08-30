import { GoalStatus } from "../../../proto/generated/agent/v1/goal_tool_pb.js";
import type { GoalState } from "../../../proto/generated/agent/v1/agent_pb.js";
import type { Context } from "../../../context/core.js";
import { goalClockOnActivation } from "../../../agent-core/goal-continuation.js";

type StateHandlerLike = {
  readonly goalState: GoalState | undefined;
  setGoalState(goalState: GoalState): void;
  computeNewStructure(ctx: Context): Promise<unknown>;
};

export async function reactivatePausedGoalOnUserMessage(
  ctx: Context,
  stateHandler: StateHandlerLike,
  onStateUpdate: (ctx: Context, state: unknown) => Promise<void>,
): Promise<void> {
  const current = stateHandler.goalState;
  if (current === undefined || current.status !== GoalStatus.PAUSED) return;
  const resumed = current.clone();
  resumed.status = GoalStatus.ACTIVE;
  resumed.idleContinuationsWithoutToolCalls = 0;
  Object.assign(resumed, goalClockOnActivation(resumed, Date.now()));
  stateHandler.setGoalState(resumed);
  await onStateUpdate(ctx, await stateHandler.computeNewStructure(ctx));
}
