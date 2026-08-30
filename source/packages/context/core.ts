export interface ContextKey<T> { readonly symbol: symbol; readonly defaultValue: T }

export interface Context {
  readonly signal: AbortSignal;
  readonly canceled: boolean;
  readonly reason: unknown;
  readonly name: string | undefined;
  get<T>(key: ContextKey<T>): T;
  with<T>(key: ContextKey<T>, value: T): Context;
  withCancel(): [Context, (reason?: unknown) => void];
  withTimeout(ms: number): Context;
  withDeadline(deadline: Date): Context;
  withTimeoutAndCancel(ms: number): [Context, (reason?: unknown) => void];
  withName(name: string): Context;
  withDetached(): Context;
  getParent(): Context | undefined;
  getPath(): string[];
}

export function createKey<T>(name: symbol, defaultValue: T): ContextKey<T> { return { symbol: name, defaultValue }; }

function createChildController(parentSignal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (parentSignal.aborted) controller.abort(parentSignal.reason);
  else parentSignal.addEventListener("abort", () => controller.abort(parentSignal.reason), { once: true });
  return controller;
}

class ContextImpl implements Context {
  readonly signal: AbortSignal;
  constructor(
    private readonly parent?: Context,
    signal?: AbortSignal,
    private readonly values: ReadonlyMap<symbol, unknown> = new Map(),
    readonly name: string | undefined = undefined,
  ) {
    this.signal = signal ?? parent?.signal ?? new AbortController().signal;
  }
  get canceled(): boolean { return this.signal.aborted; }
  get reason(): unknown { return this.signal.reason; }
  get<T>(key: ContextKey<T>): T {
    if (this.values.has(key.symbol)) return this.values.get(key.symbol) as T;
    return this.parent?.get(key) ?? key.defaultValue;
  }
  with<T>(key: ContextKey<T>, value: T): Context {
    const values = new Map(this.values);
    values.set(key.symbol, value);
    return new ContextImpl(this, undefined, values);
  }
  withCancel(): [Context, (reason?: unknown) => void] {
    const controller = createChildController(this.signal);
    return [new ContextImpl(this, controller.signal), (reason?: unknown) => controller.abort(reason)];
  }
  withTimeout(ms: number): Context {
    const controller = createChildController(this.signal);
    const context = new ContextImpl(this, controller.signal);
    const timeoutId = setTimeout(() => controller.abort(new Error("context deadline exceeded")), ms);
    controller.signal.addEventListener("abort", () => clearTimeout(timeoutId), { once: true });
    return context;
  }
  withDeadline(deadline: Date): Context {
    const ms = deadline.getTime() - Date.now();
    if (ms > 0) return this.withTimeout(ms);
    const controller = createChildController(this.signal);
    controller.abort(new Error("context deadline exceeded"));
    return new ContextImpl(this, controller.signal);
  }
  withTimeoutAndCancel(ms: number): [Context, (reason?: unknown) => void] {
    const [cancelContext, cancel] = this.withCancel();
    return [cancelContext.withTimeout(ms), cancel];
  }
  withName(name: string): Context { return new ContextImpl(this, undefined, undefined, name); }
  withDetached(): Context { return new ContextImpl(this, new AbortController().signal); }
  getParent(): Context | undefined { return this.parent; }
  getPath(): string[] {
    const path: string[] = [];
    let current: Context | undefined = this;
    while (current !== undefined) {
      if (current.name) path.unshift(current.name);
      current = current.getParent();
    }
    return path;
  }
}

export function createContext(): Context { return new ContextImpl(); }
