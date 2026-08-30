/** Exact public error shape emitted by dune/src/internal/scheduling/policies.ts. */
export class DeadlineExceededError extends Error {
  readonly code = "deadline_exceeded";

  constructor(readonly policyName: string) {
    super(`Deadline exceeded for ${policyName}`);
    this.name = "DeadlineExceededError";
  }
}

export interface Clock {
  now(): number;
  monotonicNow(): number;
  schedule(delayMs: number, callback: () => void): { dispose(): void };
}

export const realClock: Clock = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  schedule(delayMs, callback) {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError("delayMs must be a finite non-negative number");
    let active = true;
    const timer = setTimeout(() => {
      if (!active) return;
      active = false;
      callback();
    }, delayMs);
    timer.unref?.();
    return { dispose() { if (!active) return; active = false; clearTimeout(timer); } };
  }
};

export interface DeadlinePolicy {
  readonly name: string;
  run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface ExpiryPolicy {
  readonly name: string;
  arm(key: string, onExpire: () => void): { dispose(): void };
}

export interface PollingPolicy {
  readonly name: string;
  start(tick: () => Promise<void>, signal?: AbortSignal): { dispose(): void };
}

export interface RetryPolicy {
  readonly name: string;
  schedule(attempt: number, signal?: AbortSignal): { readonly elapsed: Promise<void>; dispose(): void };
  runWithRetry<T>(work: (attempt: number, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface IdleWatchdogPolicy {
  readonly name: string;
  arm(onIdle: () => void): { kick(): void; dispose(): void };
}

export interface DebouncePolicy { readonly name: string; wrap<Args extends unknown[]>(fn: (...args: Args) => void): ((...args: Args) => void) & { dispose(): void }; }

export function createDebouncePolicy(clock: Clock, options: { name: string; delayMs: number }): DebouncePolicy {
  if (options.name.trim().length === 0) throw new TypeError("name must not be empty");
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) throw new RangeError("delayMs must be a finite non-negative number");
  return { name: options.name, wrap<Args extends unknown[]>(fn: (...args: Args) => void) { let active = true; let scheduled: { dispose(): void } | undefined; return Object.assign((...args: Args) => { if (!active) return; scheduled?.dispose(); scheduled = clock.schedule(options.delayMs, () => { scheduled = undefined; fn(...args); }); }, { dispose() { if (!active) return; active = false; scheduled?.dispose(); scheduled = undefined; } }); } };
}

export function createRealDebouncePolicy(options: { name: string; delayMs: number }): DebouncePolicy { return createDebouncePolicy(realClock, options); }

function createAbortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function createDelay(clock: Clock, delayMs: number, signal?: AbortSignal) {
  let settled = false;
  const { promise: elapsed, resolve, reject } = Promise.withResolvers<void>();
  void elapsed.catch(() => {});
  let removeAbortListener = () => {};
  const scheduled = clock.schedule(delayMs, () => {
    if (settled) return;
    settled = true;
    removeAbortListener();
    resolve();
  });
  const cancel = (reason: unknown) => {
    if (settled) return;
    settled = true;
    scheduled.dispose();
    removeAbortListener();
    reject(reason);
  };
  if (signal?.aborted) cancel(abortReason(signal));
  else if (signal != null) {
    const abort = () => cancel(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
  }
  return { elapsed, dispose: () => cancel(createAbortError()) };
}

export function createRetryPolicy(clock: Clock, options: {
  name: string;
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}): RetryPolicy {
  if (options.name.trim().length === 0) throw new TypeError("name must not be empty");
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) throw new RangeError("maxAttempts must be a positive integer");
  if (!Number.isFinite(options.initialDelayMs) || options.initialDelayMs < 0) throw new RangeError("initialDelayMs must be a finite non-negative number");
  if (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs < 0) throw new RangeError("maxDelayMs must be a finite non-negative number");
  if (options.maxDelayMs < options.initialDelayMs) throw new RangeError("maxDelayMs must be at least initialDelayMs");
  const backoffFactor = options.backoffFactor ?? 2;
  if (!Number.isFinite(backoffFactor) || backoffFactor < 1) throw new RangeError("backoffFactor must be a finite number at least 1");
  const shouldRetry = options.shouldRetry ?? (() => true);
  const policy: RetryPolicy = {
    name: options.name,
    schedule(attempt, signal) {
      if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("attempt must be a positive integer");
      const growth = Math.min(backoffFactor ** (attempt - 1), Number.MAX_VALUE);
      return createDelay(clock, Math.min(options.maxDelayMs, options.initialDelayMs * growth), signal);
    },
    async runWithRetry<T>(work: (attempt: number, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      const workSignal = signal ?? new AbortController().signal;
      let rejectCancellation: (error: unknown) => void = () => {};
      const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
      let removeAbortListener = () => {};
      if (signal != null) {
        const abort = () => rejectCancellation(abortReason(signal));
        signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      try {
        for (let attempt = 1; ; attempt += 1) {
          if (signal?.aborted) throw abortReason(signal);
          try { return await Promise.race([work(attempt, workSignal), cancellation]); }
          catch (error) {
            if (signal?.aborted) throw abortReason(signal);
            if (attempt >= options.maxAttempts || !shouldRetry(error, attempt)) throw error;
            const delay = policy.schedule(attempt, signal);
            try { await delay.elapsed; }
            finally { delay.dispose(); }
          }
        }
      } finally { removeAbortListener(); }
    }
  };
  return policy;
}

export function createRealRetryPolicy(options: Parameters<typeof createRetryPolicy>[1]): RetryPolicy {
  return createRetryPolicy(realClock, options);
}

export function createIdleWatchdogPolicy(clock: Clock, options: { name: string; idleMs: number }): IdleWatchdogPolicy {
  if (options.name.trim().length === 0) throw new TypeError("name must not be empty");
  if (!Number.isFinite(options.idleMs) || options.idleMs < 0) throw new RangeError("idleMs must be a finite non-negative number");
  return {
    name: options.name,
    arm(onIdle) {
      let active = true;
      let scheduled: { dispose(): void } | undefined;
      const rearm = () => {
        scheduled?.dispose();
        scheduled = clock.schedule(options.idleMs, () => { scheduled = undefined; onIdle(); });
      };
      rearm();
      return {
        kick() { if (active) rearm(); },
        dispose() { if (!active) return; active = false; scheduled?.dispose(); scheduled = undefined; }
      };
    }
  };
}

export function createRealIdleWatchdogPolicy(options: { name: string; idleMs: number }): IdleWatchdogPolicy {
  return createIdleWatchdogPolicy(realClock, options);
}

export function createPollingPolicy(clock: Clock, options: { name: string; intervalMs: number }): PollingPolicy {
  if (options.name.trim().length === 0) throw new TypeError("name must not be empty");
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) throw new RangeError("intervalMs must be a finite non-negative number");
  if (options.intervalMs === 0) throw new RangeError("intervalMs must be greater than 0");
  return {
    name: options.name,
    start(tick, signal) {
      let active = true;
      let scheduled: { dispose(): void } | undefined;
      let removeAbortListener = () => {};
      const dispose = () => {
        if (!active) return;
        active = false;
        scheduled?.dispose();
        scheduled = undefined;
        removeAbortListener();
      };
      const run = () => {
        scheduled = undefined;
        if (!active) return;
        let completion: Promise<void>;
        try { completion = tick(); }
        catch { dispose(); return; }
        void completion.then(
          () => { if (active) scheduled = clock.schedule(options.intervalMs, run); },
          () => dispose()
        );
      };
      const polling = { dispose };
      if (signal?.aborted) { dispose(); return polling; }
      if (signal != null) {
        signal.addEventListener("abort", dispose, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", dispose);
      }
      run();
      return polling;
    }
  };
}

export function createRealPollingPolicy(options: { name: string; intervalMs: number }): PollingPolicy {
  return createPollingPolicy(realClock, options);
}

export function createExpiryPolicy(clock: Clock, options: { name: string; ttlMs: number }): ExpiryPolicy {
  if (options.name.trim().length === 0) throw new TypeError("name must not be empty");
  if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) throw new RangeError("ttlMs must be a finite non-negative number");
  const pending = new Map<string, { dispose(): void }>();
  return {
    name: options.name,
    arm(key, onExpire) {
      pending.get(key)?.dispose();
      const scheduled = clock.schedule(options.ttlMs, () => {
        pending.delete(key);
        onExpire();
      });
      pending.set(key, scheduled);
      return {
        dispose() {
          if (pending.get(key) !== scheduled) return;
          pending.delete(key);
          scheduled.dispose();
        }
      };
    }
  };
}

export function createRealExpiryPolicy(options: { name: string; ttlMs: number }): ExpiryPolicy {
  return createExpiryPolicy(realClock, options);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

export function createDeadlinePolicy(clock: Clock, options: { name: string; timeoutMs: number }): DeadlinePolicy {
  if (options.name.length === 0) throw new RangeError("name must be non-empty");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new RangeError("timeoutMs must be a finite non-negative number");
  return {
    name: options.name,
    async run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) throw abortReason(signal);
      const controller = new AbortController();
      let rejectTimeout: (error: unknown) => void = () => {};
      const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
      let rejectCancellation: (error: unknown) => void = () => {};
      const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
      let removeAbortListener = () => {};
      if (signal != null) {
        const abort = () => {
          const reason = abortReason(signal);
          rejectCancellation(reason);
          controller.abort(reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      const deadline = clock.schedule(options.timeoutMs, () => {
        const error = new DeadlineExceededError(options.name);
        rejectTimeout(error);
        controller.abort(error);
      });
      try {
        return await Promise.race([work(controller.signal), timeout, cancellation]);
      } finally {
        deadline.dispose();
        removeAbortListener();
      }
    }
  };
}
