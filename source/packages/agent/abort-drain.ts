import { createLogger } from "../context/logger.js";
import type { Context } from "../context/core.js";
import { createCounter } from "../metrics/index.js";
import { TimeoutError, withTimeout } from "../utils/promise-extras.js";

const logger = createLogger("@anysphere/agent");
const ABORT_DRAIN_TIMEOUT_MS = 5_000;
const abortDrainOutcomeCounter = createCounter("agent.run_stream.abort_drain", {
  description:
    "Outcome of the bounded drain of pending blob/checkpoint work when runStream exits via an error (including user aborts).",
  labelNames: ["outcome"],
});

export interface AbortDrainArgs {
  readonly pendingCheckpoints: Promise<unknown>;
  readonly flush: () => Promise<unknown>;
  readonly timeoutMs?: number;
}

export async function drainPendingWritesOnRunStreamError(
  ctx: Context,
  args: AbortDrainArgs,
): Promise<void> {
  const timeoutMs = args.timeoutMs ?? ABORT_DRAIN_TIMEOUT_MS;
  try {
    await withTimeout(
      Promise.all([args.pendingCheckpoints, args.flush()]),
      timeoutMs,
      `Abort drain of pending blob writes timed out after ${timeoutMs}ms`,
    );
    abortDrainOutcomeCounter.increment(ctx, 1, { outcome: "succeeded" });
  } catch (error) {
    const outcome = error instanceof TimeoutError ? "timed_out" : "failed";
    abortDrainOutcomeCounter.increment(ctx, 1, { outcome });
    logger.warn(ctx, "Abort drain of pending blob writes did not complete", {
      error,
      outcome,
      timeoutMs,
    });
  }
}
