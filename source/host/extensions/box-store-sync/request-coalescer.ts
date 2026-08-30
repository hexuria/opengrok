import { SandBoxStoreSyncError } from "./box-store-sync-error.js";

export interface RequestCoalescerOptions<Request, Result> {
  readonly maxBatchSize: number;
  readonly run: (requests: Request[]) => Promise<Result[]>;
  readonly conflictKey?: (request: Request) => string | undefined;
  readonly shouldSplitOnError?: (error: unknown) => boolean;
}

interface PendingRequest<Request, Result> {
  readonly request: Request;
  readonly resolve: (value: Result) => void;
  readonly reject: (error: unknown) => void;
}

export function createRequestCoalescer<Request, Result>(
  options: RequestCoalescerOptions<Request, Result>,
): (request: Request) => Promise<Result> {
  const maxBatchSize = Math.max(1, Math.floor(options.maxBatchSize));
  const queue: PendingRequest<Request, Result>[] = [];
  let draining = false;

  function takeBatch(): PendingRequest<Request, Result>[] {
    const batch: PendingRequest<Request, Result>[] = [];
    const claimed = new Set<string>();
    const deferred: PendingRequest<Request, Result>[] = [];
    while (batch.length < maxBatchSize) {
      const pending = queue.shift();
      if (pending === undefined) break;
      const key = options.conflictKey?.(pending.request);
      if (key !== undefined && claimed.has(key)) {
        deferred.push(pending);
        continue;
      }
      if (key !== undefined) claimed.add(key);
      batch.push(pending);
    }
    queue.unshift(...deferred);
    return batch;
  }

  async function runIndividually(batch: PendingRequest<Request, Result>[]): Promise<void> {
    for (const pending of batch) {
      try {
        const results = await options.run([pending.request]);
        const result = results[0];
        if (result === undefined) {
          throw new SandBoxStoreSyncError("Batched request returned no result for its request");
        }
        pending.resolve(result);
      } catch (error) {
        pending.reject(error);
      }
    }
  }

  async function runBatch(batch: PendingRequest<Request, Result>[]): Promise<void> {
    try {
      const results = await options.run(batch.map((pending) => pending.request));
      if (results.length !== batch.length) {
        throw new SandBoxStoreSyncError(
          `Batched request returned ${results.length} results for ${batch.length} requests`,
        );
      }
      batch.forEach((pending, index) => pending.resolve(results[index] as Result));
    } catch (error) {
      if (batch.length > 1 && (options.shouldSplitOnError?.(error) ?? false)) {
        await runIndividually(batch);
        return;
      }
      for (const pending of batch) pending.reject(error);
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const batch = takeBatch();
        if (batch.length === 0) break;
        await runBatch(batch);
      }
    } finally {
      draining = false;
    }
  }

  return (request) => new Promise<Result>((resolve, reject) => {
    queue.push({ request, resolve, reject });
    void drain();
  });
}
