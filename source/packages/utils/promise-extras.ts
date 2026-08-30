import {
  Subject,
  catchError,
  defer,
  filter,
  firstValueFrom,
  from,
  lastValueFrom,
  map,
  materialize,
  mergeAll,
  mergeMap,
  of,
  reduce,
  share,
  throwError,
  timeout,
  type Observable,
  type ObservableInput,
  type Subscription,
} from "rxjs";

export async function asyncMapValues<Input, Output>(
  array: readonly Input[],
  selector: (value: Input) => ObservableInput<Output>,
  options?: { max?: number },
): Promise<Output[]> {
  const { max = 4 } = options ?? {};
  const promiseSelectorToObservable = (index: number) => defer(() => from(selector(array[index]!)).pipe(map((value) => ({ index, value }))));
  const result = from(array.map((_value, index) => index)).pipe(
    map(promiseSelectorToObservable),
    mergeAll(max),
    reduce((accumulator, entry) => {
      accumulator[entry.index] = entry.value;
      return accumulator;
    }, [] as Output[]),
  );
  return firstValueFrom(result);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number, message?: string): Promise<Value> {
  return firstValueFrom(from(promise).pipe(timeout({
    first: timeoutMs,
    with: () => throwError(() => new TimeoutError(message ?? `Promise timed out after ${timeoutMs}ms`)),
  })));
}

interface OperationResult<Value> {
  id: number;
  result?: Value;
  error?: unknown;
}

export class PromiseQueue {
  private readonly opQueue: Subject<Observable<OperationResult<unknown>>>;
  private nextOperation: number;
  private readonly opResultStream: Observable<OperationResult<unknown>>;
  private readonly dispose: Subscription;

  constructor(options?: { max?: number }) {
    this.opQueue = new Subject();
    this.nextOperation = 1;
    const { max = 4 } = options ?? {};
    this.opResultStream = this.opQueue.pipe(mergeAll(max), share());
    this.dispose = this.opResultStream.subscribe();
  }

  enqueue<Value>(block: () => ObservableInput<Value>): Promise<Value> {
    const id = this.nextOperation++;
    const operation = defer(() => from(block()).pipe(
      map((result): OperationResult<Value> => ({ id, result })),
      catchError((error: unknown) => of<OperationResult<Value>>({ id, error })),
    ));
    const result = firstValueFrom(this.opResultStream.pipe(filter((outcome) => outcome.id === id))).then((outcome) => {
      if (outcome.error) return Promise.reject(outcome.error);
      return Promise.resolve(outcome.result as Value);
    });
    this.opQueue.next(operation);
    return result;
  }

  enqueueList<Key, Value>(list: readonly Key[], block: (item: Key) => ObservableInput<Value>): Promise<Map<Key, Value>> {
    if (list.length === 0) return Promise.resolve(new Map());
    return firstValueFrom(from(list).pipe(
      mergeMap((item) => this.enqueue(() => block(item)).then((value) => ({ key: item, value }))),
      reduce((accumulator, entry) => {
        accumulator.set(entry.key, entry.value);
        return accumulator;
      }, new Map<Key, Value>()),
    ));
  }

  close(): Promise<void> {
    this.opQueue.complete();
    const result = lastValueFrom(this.opResultStream.pipe(materialize(), map(() => undefined)));
    this.dispose.unsubscribe();
    return result;
  }
}
