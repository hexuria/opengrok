export class WriteIterableClosedError extends Error {
  constructor(message: string) { super(message); this.name = "WriteIterableClosedError"; }
}

interface PendingReader<T> { resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }

export interface WritableIterable<T> extends AsyncIterable<T> {
  write(value: T): Promise<void>;
  throw(error: unknown): void;
  close(): void;
}

export function createWritableIterable<T>(): WritableIterable<T> {
  const readQueue: Array<PendingReader<T>> = [];
  const writeQueue: T[] = [];
  let closed = false;
  let error: unknown;
  let nextResolve: () => void = () => {};
  let nextReject: (error: unknown) => void = () => {};
  const createNextPromise = (): Promise<void> => {
    const promise = new Promise<void>((resolve, reject) => { nextResolve = resolve; nextReject = reject; });
    void promise.catch(() => {});
    return promise;
  };
  let nextPromise = createNextPromise();
  const drainReads = (result: IteratorResult<T>, err?: unknown): void => {
    while (readQueue.length > 0) {
      const reader = readQueue.shift();
      if (reader === undefined) continue;
      if (err) reader.reject(err); else reader.resolve(result);
    }
  };
  const rejectPendingWrites = (err: unknown): void => {
    writeQueue.length = 0;
    nextReject(err);
    nextPromise = Promise.reject(err);
    void nextPromise.catch(() => {});
  };
  return {
    async write(value: T): Promise<void> {
      if (closed) throw error ?? new WriteIterableClosedError("WritableIterable is closed");
      const reader = readQueue.shift();
      if (reader !== undefined) {
        reader.resolve({ done: false, value });
        if (readQueue.length > 0) return;
      } else writeQueue.push(value);
      const waitCount = writeQueue.length + 1;
      for (let index = 0; index < waitCount; index++) await nextPromise;
    },
    throw(err: unknown): void {
      if (closed) return;
      closed = true;
      error = err;
      rejectPendingWrites(err);
      drainReads({ done: true, value: undefined }, err);
    },
    close(): void {
      if (closed) return;
      closed = true;
      writeQueue.length = 0;
      nextResolve();
      nextPromise = Promise.reject(new WriteIterableClosedError("WritableIterable is closed"));
      void nextPromise.catch(() => {});
      drainReads({ done: true, value: undefined });
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          nextResolve();
          nextPromise = createNextPromise();
          const value = writeQueue.shift();
          if (value !== undefined) return Promise.resolve({ done: false, value });
          if (closed) return error ? Promise.reject(error) : Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve, reject) => readQueue.push({ resolve, reject }));
        },
        throw(err: unknown): Promise<IteratorResult<T>> {
          closed = true;
          error = err;
          writeQueue.length = 0;
          rejectPendingWrites(err);
          drainReads({ done: true, value: undefined }, err);
          return Promise.resolve({ done: true, value: undefined });
        },
        return(): Promise<IteratorResult<T>> {
          closed = true;
          writeQueue.length = 0;
          nextResolve();
          nextPromise = Promise.reject(new Error("Iterator was closed"));
          void nextPromise.catch(() => {});
          drainReads({ done: true, value: undefined });
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}
