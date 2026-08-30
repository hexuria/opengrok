export interface HostExtensionContext<Host = unknown> {
  readonly deps: Record<string, unknown>;
  readonly host: Host;
  readonly onStop: (teardown: () => void | Promise<void>) => void;
}

export interface HostExtensionDeclaration<Api = unknown, Host = unknown> {
  readonly kind: "host-extension";
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly start: (context: HostExtensionContext<Host>) => Api | Promise<Api>;
}

const hostExtensionDeclarations = new WeakSet<object>();

export function defineHostExtension<Api, Host = unknown>(options: Omit<HostExtensionDeclaration<Api, Host>, "kind">): HostExtensionDeclaration<Api, Host> {
  const declaration = Object.freeze({ kind: "host-extension" as const, ...options, dependencies: Object.freeze([...options.dependencies]) });
  hostExtensionDeclarations.add(declaration);
  return declaration;
}

export function createHostEvents(options: { readonly onHandlerFailure: (topic: string, error: unknown) => void }) {
  const handlers = new Map<string, Set<(payload: unknown) => unknown>>();
  return {
    async emit(topic: string, payload: unknown, emitOptions?: { readonly failureMode?: "reject" }): Promise<void> {
      const subscribed = handlers.get(topic);
      if (subscribed == null || subscribed.size === 0) return;
      const settled = await Promise.allSettled([...subscribed].map(async (handler) => handler(payload)));
      let firstFailure: { error: unknown } | undefined;
      for (const outcome of settled) {
        if (outcome.status !== "rejected") continue;
        options.onHandlerFailure(topic, outcome.reason);
        if (emitOptions?.failureMode === "reject") firstFailure ??= { error: outcome.reason };
      }
      if (firstFailure !== undefined) throw firstFailure.error;
    },
    on(topic: string, handler: (payload: unknown) => unknown): () => void {
      const subscribed = handlers.get(topic) ?? new Set();
      subscribed.add(handler);
      handlers.set(topic, subscribed);
      return () => { subscribed.delete(handler); };
    }
  };
}

export class HostExtensionGraphError extends Error {
  constructor(message: string) { super(message); this.name = "HostExtensionGraphError"; }
}

export class HostExtensionStartError extends Error {
  constructor(readonly extensionId: string, cause: unknown) {
    super(`host extension "${extensionId}" failed to start`, { cause });
    this.name = "HostExtensionStartError";
  }
}

export function resolveHostExtensionBootOrder<Host = unknown>(extensions: readonly HostExtensionDeclaration<unknown, Host>[]): string[] {
  const peersOf = new Map<string, Set<string>>();
  for (const extension of extensions) {
    if (peersOf.has(extension.id)) throw new HostExtensionGraphError(`two host extensions declare the id "${extension.id}"`);
    peersOf.set(extension.id, new Set(extension.dependencies));
  }
  for (const extension of extensions) {
    for (const dependency of extension.dependencies) {
      if (dependency === extension.id) throw new HostExtensionGraphError(`host extension "${extension.id}" declares itself as a peer`);
      if (!peersOf.has(dependency)) throw new HostExtensionGraphError(`host extension "${extension.id}" requires the peer "${dependency}", which is not in this build`);
    }
  }
  const remaining = [...peersOf.keys()].sort();
  const started = new Set<string>();
  const order: string[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex((id) => [...(peersOf.get(id) ?? [])].every((peer) => started.has(peer)));
    if (index === -1) throw new HostExtensionGraphError(`host extension peer cycle: ${describeCycle(peersOf, started)}`);
    const id = remaining[index];
    if (id === undefined) throw new HostExtensionGraphError("host extension boot order became empty unexpectedly");
    remaining.splice(index, 1);
    started.add(id);
    order.push(id);
  }
  return order;
}

export async function startHostExtensions<Host>(options: {
  readonly extensions: readonly HostExtensionDeclaration<unknown, Host>[];
  readonly host: Host;
  readonly onStopFailure: (extensionId: string, error: unknown) => void;
}) {
  const order = resolveHostExtensionBootOrder(options.extensions);
  const byId = new Map(options.extensions.map((extension) => [extension.id, extension]));
  const apis: Record<string, unknown> = {};
  const teardowns: Array<{ extensionId: string; run: () => void | Promise<void> }> = [];
  const stopStarted = async () => {
    for (const teardown of teardowns.splice(0).reverse()) {
      try { await teardown.run(); } catch (error) { options.onStopFailure(teardown.extensionId, error); }
    }
  };
  for (const id of order) {
    const extension = byId.get(id);
    if (extension == null) throw new HostExtensionGraphError(`the resolved boot order names an unknown host extension "${id}"`);
    const deps: Record<string, unknown> = {};
    for (const dependency of extension.dependencies) deps[dependency] = apis[dependency];
    try {
      apis[id] = await extension.start({ deps, host: options.host, onStop: (run) => teardowns.push({ extensionId: id, run }) });
    } catch (error) {
      await stopStarted();
      throw new HostExtensionStartError(id, error);
    }
  }
  return { order, apis, stop: stopStarted };
}

function describeCycle(peersOf: ReadonlyMap<string, ReadonlySet<string>>, started: ReadonlySet<string>): string {
  const onPath: string[] = [];
  const walk = (id: string): string[] | null => {
    const seenAt = onPath.indexOf(id);
    if (seenAt !== -1) return [...onPath.slice(seenAt), id];
    onPath.push(id);
    for (const peer of [...(peersOf.get(id) ?? [])].sort()) {
      if (started.has(peer)) continue;
      const cycle = walk(peer);
      if (cycle != null) return cycle;
    }
    onPath.pop();
    return null;
  };
  const unsettled = [...peersOf.keys()].filter((id) => !started.has(id)).sort();
  for (const id of unsettled) {
    const cycle = walk(id);
    if (cycle != null) return cycle.join(" → ");
  }
  return unsettled.join(" → ");
}
