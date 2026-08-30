import type { Context } from "../context/core.js";
import { createCounter, createHistogram } from "../metrics/index.js";

interface GoalTerminalTransitionInput {
  readonly status: string;
  readonly reason: string;
  readonly continuationCount: number;
}

const goalCreated = createCounter("agent.goal.created", {
  description: "Counts durable goals created by the agent",
});
const goalContinuationStarted = createCounter("agent.goal.continuation.started", {
  description: "Counts durable goal continuation turns that started",
});
const goalTerminalTransition = createCounter("agent.goal.terminal_transition", {
  description: "Counts durable goals transitioning out of active status",
  labelNames: ["status", "reason"],
});
const goalContinuationsAtTerminal = createHistogram("agent.goal.continuations_at_terminal", {
  description: "Total continuation turns started when a durable goal transitions out of active status",
  labelNames: ["status", "reason"],
});

export function recordGoalContinuationStarted(ctx: Context): void {
  goalContinuationStarted.increment(ctx);
}

export function recordGoalTerminalTransition(ctx: Context, options2: GoalTerminalTransitionInput): void {
  const labels = {
    status: options2.status,
    reason: options2.reason,
  };
  goalTerminalTransition.increment(ctx, 1, labels);
  goalContinuationsAtTerminal.histogram(ctx, options2.continuationCount, labels);
}
