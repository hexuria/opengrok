export interface Resource<Implementation, RemoteManager = unknown, ControlledManager = unknown> {
  readonly symbol: symbol;
  readonly remoteImplementation: (manager: RemoteManager) => Implementation;
  readonly registerControlledImplementation: (implementation: Implementation, manager: ControlledManager) => void;
}

export function createResource<Implementation, RemoteManager = unknown, ControlledManager = unknown>(
  remoteImplementation: (manager: RemoteManager) => Implementation,
  controlledImplementation: (implementation: Implementation, manager: ControlledManager) => void,
): Resource<Implementation, RemoteManager, ControlledManager> {
  return { symbol: Symbol(), remoteImplementation, registerControlledImplementation: controlledImplementation };
}

export function resourceEntry<Implementation, RemoteManager, ControlledManager>(
  resource: Resource<Implementation, RemoteManager, ControlledManager>,
  implementation: Implementation,
): readonly [Resource<Implementation, RemoteManager, ControlledManager>, Implementation] {
  return [resource, implementation];
}

export interface RemoteResource<Implementation, RemoteManager> {
  readonly symbol: symbol;
  readonly remoteImplementation: (manager: RemoteManager) => Implementation;
}

export interface ResourceAccessor<RemoteManager> {
  get<Implementation>(resource: RemoteResource<Implementation, RemoteManager>): Implementation;
}

export class RemoteResourceAccessor<RemoteManager> {
  constructor(private readonly remoteExecManager: RemoteManager) {}
  get<Implementation>(resource: RemoteResource<Implementation, RemoteManager>): Implementation {
    return resource.remoteImplementation(this.remoteExecManager);
  }
}

export interface RegisteredControlledResource {
  readonly symbol: symbol;
  readonly registerControlledImplementation: (implementation: unknown, manager: ControlledExecManager) => void;
}

class ResourceDescriptor<Implementation> {
  constructor(readonly resource: RegisteredControlledResource, readonly value: Implementation) {}
}

export class RegistryResourceAccessor {
  private readonly resources = new Map<symbol, ResourceDescriptor<unknown>>();
  register<Implementation, RemoteManager, ControlledManager>(resource: Resource<Implementation, RemoteManager, ControlledManager>, value: Implementation): void {
    this.resources.set(resource.symbol, new ResourceDescriptor(resource as unknown as RegisteredControlledResource, value));
  }
  get<Implementation, RemoteManager, ControlledManager>(resource: Resource<Implementation, RemoteManager, ControlledManager>): Implementation | undefined {
    return this.resources.get(resource.symbol)?.value as Implementation | undefined;
  }
  entries(): Array<readonly [RegisteredControlledResource, unknown]> {
    return Array.from(this.resources.values()).map((value) => [value.resource, value.value]);
  }
}

export class CombinedResourceAccessor<RemoteManager> implements ResourceAccessor<RemoteManager> {
  private readonly localResources = new Map<symbol, { resource: RemoteResource<unknown, RemoteManager>; implementation: unknown }>();
  constructor(
    private readonly baseAccessor: ResourceAccessor<RemoteManager>,
    localResourceEntries: ReadonlyArray<readonly [RemoteResource<unknown, RemoteManager>, unknown]>,
  ) {
    for (const [resource, implementation] of localResourceEntries) this.localResources.set(resource.symbol, { resource, implementation });
  }
  get<Implementation>(resource: RemoteResource<Implementation, RemoteManager>): Implementation {
    const localEntry = this.localResources.get(resource.symbol);
    if (localEntry !== undefined) return localEntry.implementation as Implementation;
    return this.baseAccessor.get(resource);
  }
}

export interface ControlledExecManager { register(handler: unknown): void }
