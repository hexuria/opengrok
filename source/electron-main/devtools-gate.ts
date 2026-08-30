export type DevToolsMembership = "pending" | "allowed" | "denied";

export interface DevToolsMembershipStatus {
  readonly kind: string;
  readonly isAnysphereUser?: boolean;
}

export function createDevToolsMembershipResolver(deps: {
  readonly getStatus: () => Promise<DevToolsMembershipStatus>;
  readonly setMembership: (membership: DevToolsMembership) => void;
  readonly onError: (error: unknown) => void;
}): { readonly refresh: () => Promise<void> } {
  let latestAttempt = 0;
  const refresh = async (): Promise<void> => {
    deps.setMembership("pending");
    const attempt = ++latestAttempt;
    try {
      const status = await deps.getStatus();
      if (attempt !== latestAttempt) return;
      deps.setMembership(
        status.kind === "logged-in" && status.isAnysphereUser === true ? "allowed" : "denied",
      );
    } catch (error) {
      if (attempt !== latestAttempt) return;
      deps.setMembership("denied");
      deps.onError(error);
    }
  };
  return { refresh };
}

export function createDevToolsGate(options: { readonly isDevBuild: boolean }): {
  readonly isAllowed: () => boolean;
  readonly shouldCloseOpenDevTools: () => boolean;
  readonly setMembership: (membership: DevToolsMembership) => void;
  readonly subscribe: (listener: () => void) => () => void;
} {
  let membership: DevToolsMembership = "pending";
  const listeners = new Set<() => void>();
  const isAllowed = (): boolean => options.isDevBuild || membership === "allowed";
  const shouldCloseOpenDevTools = (): boolean => !options.isDevBuild && membership === "denied";
  const setMembership = (next: DevToolsMembership): void => {
    if (membership === next) return;
    const wasAllowed = isAllowed();
    const couldClose = shouldCloseOpenDevTools();
    membership = next;
    if (wasAllowed === isAllowed() && couldClose === shouldCloseOpenDevTools()) return;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return { isAllowed, shouldCloseOpenDevTools, setMembership, subscribe };
}
