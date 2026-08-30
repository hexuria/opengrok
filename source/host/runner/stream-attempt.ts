import { FirstTokenStallError, isRetryableProviderError, isTransientStreamError, resolveFirstTokenStallDeadlineMs, resolveOverloadStreamRetryPolicy, runWithTransientRetry, shouldRetryTurnAttempt, type RetryPolicy } from "./transient-stream-error.js";

export interface StreamAttemptHost<Context, Checkpoint, State> {
  readonly ctx: { readonly canceled: boolean; withCancel(): readonly [Context, (reason: { intentional: boolean; reason: string }) => void] };
  readonly hidden: boolean;
  readonly transientStreamRetry?: RetryPolicy;
  setStreamOutputProduced(value: boolean): void; getStreamOutputProduced(): boolean;
  persistCheckpoint(ctx: Context, checkpoint: Checkpoint, accepted: (persisted: Checkpoint) => void): Promise<void>;
  startStream(ctx: Context, resumeFrom: Checkpoint | undefined, persist: (ctx: Context, checkpoint: Checkpoint) => Promise<void>): Promise<State>;
  createDeadlineTimer(callback: () => void, deadlineMs: number): { cancel(): void; restart(): void };
  setDeadlineHooks(disarm: () => void, reset: () => void): void;
  clearDeadlineHookIf(disarm: () => void, reset: () => void): void;
  setTraceAttributes(attributes: Readonly<Record<string, number>>): void;
  emitRetrying(): void;
  reportTurnRetry(info: { outcome: "retried" | "exhausted" | "gave_up_ineligible"; attempt: number; maxAttempts: number; delayMs?: number; serverPaced?: boolean; error: unknown }): void;
}

export function createStreamAttempt<Context, Checkpoint, State>(host: StreamAttemptHost<Context, Checkpoint, State>) {
  let attemptResumeCheckpoint: Checkpoint | undefined, resumeStreamFrom: Checkpoint | undefined;
  const inactive = {}, activeRef: { value: object } = { value: inactive };
  let retriesPerformed = 0;

  const runStreamOnce = async (): Promise<State> => {
    host.setStreamOutputProduced(false); attemptResumeCheckpoint = undefined;
    const [attemptCtx, cancelAttempt] = host.ctx.withCancel();
    const attempt = {}; activeRef.value = attempt;
    const current = (): boolean => activeRef.value === attempt;
    const settle = (): void => { if (current()) activeRef.value = inactive; };
    const operations = new Set<Promise<void>>(); let checkpointFailure: unknown;
    const persist = async (ctx: Context, checkpoint: Checkpoint): Promise<void> => {
      if (!current()) return;
      const operation = Promise.resolve().then(() => host.persistCheckpoint(ctx, checkpoint, (persisted) => { attemptResumeCheckpoint = persisted; }));
      operations.add(operation);
      try { await operation; } catch (error) { checkpointFailure ??= error; throw error; } finally { operations.delete(operation); }
    };
    let stream: Promise<State>;
    try { stream = host.startStream(attemptCtx, resumeStreamFrom, persist); } catch (error) { settle(); throw error; }
    const base = resolveFirstTokenStallDeadlineMs();
    if (base <= 0) {
      try { const state = await stream; if (checkpointFailure != null) throw checkpointFailure; return state; }
      catch (error) { throw checkpointFailure ?? error; } finally { settle(); }
    }
    const deadlineMs = base * 2 ** retriesPerformed;
    return new Promise<State>((resolve, reject) => {
      let settled = false, deadlineFired = false;
      const onDeadline = (): void => {
        if (settled || host.getStreamOutputProduced()) return;
        settled = true; deadlineFired = true; settle(); cancelAttempt({ intentional: false, reason: "first-token stall" });
        void Promise.allSettled(operations).then((results) => reject(checkpointFailure ?? results.find((result) => result.status === "rejected")?.reason ?? new FirstTokenStallError(deadlineMs)));
      };
      const timer = host.createDeadlineTimer(onDeadline, deadlineMs);
      const disarm = (): void => { settled = true; timer.cancel(); host.clearDeadlineHookIf(disarm, reset); };
      const reset = (): void => { if (!settled && !host.getStreamOutputProduced()) timer.restart(); };
      host.setDeadlineHooks(disarm, reset);
      void stream.then((state) => { if (deadlineFired) return; disarm(); settle(); checkpointFailure == null ? resolve(state) : reject(checkpointFailure); }, (error) => { if (deadlineFired) return; disarm(); settle(); reject(checkpointFailure ?? error); });
    });
  };

  const automation = host.transientStreamRetry;
  const policy = automation ?? resolveOverloadStreamRetryPolicy();
  const automationIsRetryable = automation == null
    ? undefined
    : automation.isRetryable ?? isTransientStreamError;
  const runBounded = async (): Promise<State> => policy.maxAttempts > 1 ? runWithTransientRetry(runStreamOnce, {
    ...policy,
    isRetryable: (error) => shouldRetryTurnAttempt({ error, canceled: host.ctx.canceled, streamOutputProduced: host.getStreamOutputProduced(), resumeCheckpointAvailable: attemptResumeCheckpoint != null, ...(automationIsRetryable == null ? {} : { automationIsRetryable }) }),
    onRetry: (info) => {
      retriesPerformed = info.attempt;
      if (host.getStreamOutputProduced() && attemptResumeCheckpoint != null) resumeStreamFrom = attemptResumeCheckpoint;
      host.setTraceAttributes({ "sand.retry_count": info.attempt }); if (!host.hidden) host.emitRetrying();
      host.reportTurnRetry({ outcome: "retried", attempt: info.attempt, maxAttempts: policy.maxAttempts, delayMs: info.delayMs, serverPaced: info.serverPaced, error: info.error });
      automation?.onRetry?.(info);
    },
  }) : runStreamOnce();

  return { async run(): Promise<State> {
    try { return await runBounded(); } catch (error) {
      if (!host.ctx.canceled) {
        const attempt = retriesPerformed + 1;
        if (retriesPerformed > 0 && retriesPerformed >= policy.maxAttempts - 1) host.reportTurnRetry({ outcome: "exhausted", attempt, maxAttempts: policy.maxAttempts, error });
        else if (retriesPerformed > 0 || isRetryableProviderError(error)) host.reportTurnRetry({ outcome: "gave_up_ineligible", attempt, maxAttempts: policy.maxAttempts, error });
      }
      throw error;
    }
  } };
}

export interface OuterStreamPersistence<Context, State> {
  readonly generation: number;
  runGeneration(): number;
  prepareCheckpointForPersistence(checkpoint: State): void;
  persistStepCheckpoint(context: Context, checkpoint: State): Promise<void>;
  noteCheckpoint?(checkpoint: State): void;
  persistFinalState(context: Context, checkpoint: State): Promise<void>;
  commitDiskPressureReminder(): void;
  releaseDiskPressureReminder(): void;
  noteAutomationStatusReminder?(): void;
  isAwaitingUserSelection(): boolean;
  isQuiescingForUpgrade(): boolean;
  markQuiescedForUpgrade(): void;
  cancelRun(cancellation: {
    readonly intentional: boolean;
    readonly reason: string;
  }): void;
}

export interface OuterStreamLifecycleInput<Context, State> {
  /** The real per-attempt startStream owner; action production stays outside. */
  readonly attempt: Omit<
    StreamAttemptHost<Context, State, State>,
    "persistCheckpoint"
  >;
  readonly persistence: OuterStreamPersistence<Context, State>;
  readonly cleanup?: () => void | Promise<void>;
  readonly onCompleted?: (state: State) => void | Promise<void>;
}

/**
 * Composes the immutable outer persistence boundary around createStreamAttempt.
 * Accepted checkpoint capture remains inside createStreamAttempt; this owner
 * only performs generation-gated settle persistence and host lifecycle hooks.
 * It is intentionally unconnected to SandAgentRunner activation.
 */
export function createOuterStreamLifecycle<Context, State>(
  input: OuterStreamLifecycleInput<Context, State>,
) {
  const { persistence } = input;
  const attempt = createStreamAttempt<Context, State, State>({
    ...input.attempt,
    persistCheckpoint: async (context, checkpoint, accepted) => {
      if (persistence.runGeneration() !== persistence.generation) return;

      persistence.prepareCheckpointForPersistence(checkpoint);
      await persistence.persistStepCheckpoint(context, checkpoint);
      accepted(checkpoint);
      persistence.noteCheckpoint?.(checkpoint);
      persistence.commitDiskPressureReminder();
      persistence.noteAutomationStatusReminder?.();

      if (persistence.isAwaitingUserSelection()) {
        persistence.cancelRun({
          intentional: true,
          reason: "awaiting user selection",
        });
      } else if (persistence.isQuiescingForUpgrade()) {
        persistence.markQuiescedForUpgrade();
        persistence.cancelRun({
          intentional: true,
          reason: "quiescing for forced host upgrade",
        });
      }
    },
  });

  async function persistFinalState(
    context: Context,
    finalState: State,
  ): Promise<void> {
    if (persistence.runGeneration() !== persistence.generation) return;
    await persistence.persistFinalState(context, finalState);
    persistence.commitDiskPressureReminder();
  }

  return {
    async run(context: Context): Promise<State> {
      let finalState: State | undefined;
      try {
        finalState = await attempt.run();
        await input.onCompleted?.(finalState);
        return finalState;
      } finally {
        try {
          await input.cleanup?.();
        } finally {
          try {
            if (finalState !== undefined) {
              await persistFinalState(context, finalState);
            }
          } finally {
            persistence.releaseDiskPressureReminder();
          }
        }
      }
    },
    persistFinalState,
  };
}
