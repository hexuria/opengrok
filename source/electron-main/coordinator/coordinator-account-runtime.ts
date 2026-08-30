import type { CoordinatorRuntime } from "./coordinator-runtime.js";

export interface CoordinatorAuthStatus {
  readonly kind: string;
  readonly authId?: string;
  readonly email?: string;
  readonly [key: string]: unknown;
}

export interface CoordinatorAccountTransition {
  readonly isStartup: boolean;
  readonly previousSlot: string | null | undefined;
}

export interface CoordinatorRefusedAccountResult<Status extends CoordinatorAuthStatus> {
  readonly kind: string;
  readonly status: Status;
  readonly error?: unknown;
}

export interface CoordinatorAccountRuntimeDependencies<Status extends CoordinatorAuthStatus> {
  readonly createRuntime: () => CoordinatorRuntime;
  readonly authorizeAccount: (
    slot: string,
    context: CoordinatorAccountTransition,
  ) => Promise<boolean>;
  readonly revokeRefusedAccount: () => Promise<CoordinatorRefusedAccountResult<Status>>;
  readonly prepareAccountTransition: (transition: {
    readonly previousSlot: string;
    readonly nextSlot: string | null;
  }) => Promise<void>;
  readonly resetAccountState: () => void;
  readonly revokeMainDataPort: () => void;
  readonly deliverStatus: (status: Status) => void;
  readonly onProblem: (problem: string) => void;
  readonly onExitTimeout?: (timeoutMs: number) => void;
  readonly exitTimeoutMs?: number;
  readonly delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly localSlot?: () => string | null;
}

export interface CoordinatorAccountRuntime<Status extends CoordinatorAuthStatus> {
  start(status: Status): Promise<void>;
  observe(status: Status): void;
  whenIdle(): Promise<Status>;
  requestRendererPort(sink: (port: unknown) => void): void;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

type RuntimeState =
  | { readonly kind: "unstarted" }
  | { readonly kind: "inactive" }
  | {
      readonly kind: "active";
      readonly slot: string;
      readonly session: CoordinatorRuntime;
      readonly appliedVersion: number;
      readonly rendererRequestRevoked: boolean;
    }
  | {
      readonly kind: "blocked";
      readonly slot: string | null;
      readonly previousSlot: string | null | undefined;
    }
  | { readonly kind: "disposed" };

type StartOutcome<Status extends CoordinatorAuthStatus> =
  | { readonly kind: "accepted" }
  | { readonly kind: "disposed" }
  | { readonly kind: "launch-failed" }
  | { readonly kind: "superseded" }
  | { readonly kind: "refused"; readonly status: Status };

const DEFAULT_EXIT_TIMEOUT_MS = 10_000;

export class SandCoordinatorExitTimeoutError extends Error {}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export const LOCAL_SUBSCRIPTION_COORDINATOR_SLOT = "local-subscription";

export function localSubscriptionSlotFromStore(store: {
  readonly getCursorLoginWallSkipped?: () => boolean;
  readonly getInferenceProvider?: () => string;
} | null | undefined): string | null {
  if (store == null) return null;
  if (store.getCursorLoginWallSkipped?.() === true) return LOCAL_SUBSCRIPTION_COORDINATOR_SLOT;
  const provider = store.getInferenceProvider?.();
  if (provider === "claude-code" || provider === "codex" || provider === "openrouter") return LOCAL_SUBSCRIPTION_COORDINATOR_SLOT;
  return null;
}

export function cursorAccountSlot(status: CoordinatorAuthStatus): string | null {
  if (status.kind !== "logged-in") return null;
  const slot = status.authId ?? status.email;
  return slot == null || slot.length === 0 ? null : slot;
}

export function coordinatorSlotForStatus(
  status: CoordinatorAuthStatus,
  localSlot?: string | null,
): string | null {
  const cursor = cursorAccountSlot(status);
  if (cursor != null) return cursor;
  return localSlot != null && localSlot.length > 0 ? localSlot : null;
}

/**
 * Owns the one coordinator process allowed for the currently settled account.
 * Observations are serialized and version-fenced so an older authorization or
 * shutdown cannot launch a coordinator after a newer auth status has arrived.
 */
export function createCoordinatorAccountRuntime<Status extends CoordinatorAuthStatus>(
  dependencies: CoordinatorAccountRuntimeDependencies<Status>,
): CoordinatorAccountRuntime<Status> {
  const exitTimeoutMs = dependencies.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;
  const delay = dependencies.delay ?? abortableDelay;
  const loggedOut = { kind: "logged-out" } as Status;

  let state: RuntimeState = { kind: "unstarted" };
  let requester: ((port: unknown) => void) | null = null;
  let settledStatus = loggedOut;
  let observedVersion = 0;
  let chain: Promise<void> = Promise.resolve();
  let startWork: Promise<void> = Promise.resolve();
  let releaseStart: () => void = () => {};
  const startArrived = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });

  const isDisposed = (): boolean => state.kind === "disposed";

  const accountSlot = (): string | null | undefined => {
    switch (state.kind) {
      case "unstarted":
      case "disposed":
        return undefined;
      case "inactive":
        return null;
      case "active":
      case "blocked":
        return state.slot;
    }
  };

  const revokeActiveRendererPortRequest = (): void => {
    if (state.kind !== "active" || state.rendererRequestRevoked) return;
    state.session.revokeRendererPortRequest();
    state = { ...state, rendererRequestRevoked: true };
  };

  const detachActive = (): CoordinatorRuntime | undefined => {
    if (state.kind !== "active") return undefined;
    const previous = state.session;
    dependencies.revokeMainDataPort();
    state = { kind: "inactive" };
    return previous;
  };

  const activateSession = (args: {
    readonly slot: string;
    readonly session: CoordinatorRuntime;
    readonly version: number;
  }): void => {
    state = {
      kind: "active",
      slot: args.slot,
      session: args.session,
      appliedVersion: args.version,
      rendererRequestRevoked: false,
    };
    if (requester !== null) args.session.requestRendererPort(requester);
  };

  const stop = async (
    previous: CoordinatorRuntime | undefined,
    onEventualExit?: () => void,
  ): Promise<boolean> => {
    if (previous === undefined) return true;
    const deadlineController = new AbortController();
    const exit = previous.dispose();
    let timedOut = false;
    try {
      await Promise.race([
        exit,
        delay(exitTimeoutMs, deadlineController.signal).then(() => {
          if (deadlineController.signal.aborted) return;
          timedOut = true;
          throw new SandCoordinatorExitTimeoutError(
            `coordinator exit timed out after ${exitTimeoutMs}ms`,
          );
        }),
      ]);
      return true;
    } catch (error) {
      dependencies.onProblem(
        `coordinator exit could not be confirmed: ${String(error)}`,
      );
      if (timedOut) dependencies.onExitTimeout?.(exitTimeoutMs);
      if (timedOut && onEventualExit !== undefined) {
        void exit.then(onEventualExit, (eventualError) => {
          dependencies.onProblem(
            `coordinator exit remained unconfirmed: ${String(eventualError)}`,
          );
        });
      }
      return false;
    } finally {
      deadlineController.abort();
    }
  };

  const startForAccount = async (
    slot: string,
    context: CoordinatorAccountTransition,
    version: number,
  ): Promise<StartOutcome<Status>> => {
    let authorized = false;
    try {
      authorized = await dependencies.authorizeAccount(slot, context);
    } catch (error) {
      dependencies.onProblem(
        `account authorization for coordinator failed: ${String(error)}`,
      );
    }
    if (version !== observedVersion) return { kind: "superseded" };
    if (!authorized) {
      dependencies.onProblem(
        "coordinator kept unavailable because the host is not bound to this account",
      );
      let status = loggedOut;
      try {
        const revocation = await dependencies.revokeRefusedAccount();
        if (revocation.kind === "failed") {
          dependencies.onProblem(
            `refused account credentials could not be removed: ${String(revocation.error)}`,
          );
        }
        status = revocation.status;
      } catch (error) {
        dependencies.onProblem(
          `refused account credentials could not be removed: ${String(error)}`,
        );
      }
      if (version !== observedVersion) return { kind: "superseded" };
      return { kind: "refused", status };
    }
    if (isDisposed()) return { kind: "disposed" };
    let session: CoordinatorRuntime;
    try {
      session = dependencies.createRuntime();
    } catch (error) {
      dependencies.onProblem(`coordinator launch failed: ${String(error)}`);
      return { kind: "launch-failed" };
    }
    activateSession({ slot, session, version });
    return { kind: "accepted" };
  };

  const deliver = (status: Status): void => {
    try {
      dependencies.deliverStatus(status);
    } catch (error) {
      dependencies.onProblem(`auth status delivery failed: ${String(error)}`);
    }
  };

  const settleObservedStatus = (status: Status): void => {
    settledStatus = status;
    deliver(status);
  };

  function enqueueReplacementRecovery(): void {
    chain = chain.then(async () => {
      if (state.kind !== "blocked") return;
      const blocked = state;
      const version = observedVersion;
      const nextSlot = coordinatorSlotForStatus(settledStatus, dependencies.localSlot?.() ?? null);
      if (nextSlot === null || nextSlot !== blocked.slot) {
        state = { kind: "inactive" };
        return;
      }
      const outcome = await startForAccount(
        nextSlot,
        { isStartup: false, previousSlot: blocked.previousSlot },
        version,
      );
      if (isDisposed() || outcome.kind === "disposed") return;
      if (outcome.kind === "accepted") return;
      state = { kind: "inactive" };
      if (outcome.kind === "refused") settleObservedStatus(outcome.status);
    });
  }

  const applyClaim = async (
    nextSlot: string | null,
    status: Status,
    isStartup: boolean,
    version: number,
    settle: (status: Status) => void,
  ): Promise<void> => {
    if (isDisposed()) return;
    const previousSlot = accountSlot();
    if (state.kind === "blocked") {
      state = { ...state, slot: nextSlot };
      settle(status);
      return;
    }
    if (nextSlot === previousSlot) {
      if (state.kind === "active") state = { ...state, appliedVersion: version };
      settle(status);
      return;
    }
    revokeActiveRendererPortRequest();
    if (previousSlot != null) {
      try {
        await dependencies.prepareAccountTransition({ previousSlot, nextSlot });
      } catch (error) {
        dependencies.onProblem(
          `account transition preparation failed: ${String(error)}`,
        );
      }
    }
    if (isDisposed()) return;
    const stopping = stop(detachActive(), enqueueReplacementRecovery);
    if (previousSlot !== undefined) {
      try {
        dependencies.resetAccountState();
      } catch (error) {
        dependencies.onProblem(`account state reset failed: ${String(error)}`);
      }
    }
    if (nextSlot === null) {
      state = { kind: "inactive" };
      settle(status);
      if (!(await stopping) && !isDisposed()) {
        state = { kind: "blocked", slot: null, previousSlot };
      }
      return;
    }
    if (!(await stopping)) {
      if (!isDisposed()) {
        state = { kind: "blocked", slot: nextSlot, previousSlot };
        settle(status);
      }
      return;
    }
    const outcome = await startForAccount(
      nextSlot,
      { isStartup, previousSlot },
      version,
    );
    if (isDisposed() || outcome.kind === "disposed") return;
    if (outcome.kind === "accepted") {
      settle(status);
      return;
    }
    state = { kind: "inactive" };
    if (outcome.kind === "superseded") return;
    settle(outcome.kind === "refused" ? outcome.status : status);
  };

  const waitForIdle = async (): Promise<Status> => {
    await startWork;
    while (true) {
      const pending = chain;
      await pending;
      if (pending === chain) return settledStatus;
    }
  };

  return {
    async start(status) {
      if (state.kind !== "unstarted") return;
      startWork = (async () => {
        try {
          await applyClaim(coordinatorSlotForStatus(status, dependencies.localSlot?.() ?? null), status, true, 0, (settled) => {
            settledStatus = settled;
          });
        } finally {
          releaseStart();
        }
      })();
      await startWork;
    },
    observe(status) {
      if (isDisposed()) return;
      const version = ++observedVersion;
      const nextSlot = coordinatorSlotForStatus(status, dependencies.localSlot?.() ?? null);
      if (nextSlot !== accountSlot()) revokeActiveRendererPortRequest();
      chain = chain.then(async () => {
        await startArrived;
        if (isDisposed()) return;
        await applyClaim(nextSlot, status, false, version, settleObservedStatus);
      });
    },
    whenIdle: waitForIdle,
    requestRendererPort(sink) {
      requester = sink;
      if (state.kind === "active" && state.appliedVersion === observedVersion) {
        state.session.requestRendererPort(sink);
        state = { ...state, rendererRequestRevoked: false };
      }
    },
    restart() {
      if (state.kind === "active" && state.appliedVersion === observedVersion) {
        return state.session.restart();
      }
      const slot = coordinatorSlotForStatus(settledStatus, dependencies.localSlot?.() ?? null);
      if ((state.kind === "inactive" || state.kind === "unstarted") && slot != null) {
        const version = observedVersion;
        chain = chain.then(async () => {
          await startArrived;
          if (isDisposed()) return;
          await applyClaim(slot, settledStatus, false, version, settleObservedStatus);
        });
        return chain;
      }
      return Promise.resolve();
    },
    dispose() {
      if (isDisposed()) return Promise.resolve();
      releaseStart();
      const stopping = stop(detachActive());
      state = { kind: "disposed" };
      return Promise.all([
        stopping,
        startWork.catch((error) => {
          dependencies.onProblem(
            `coordinator startup failed during disposal: ${String(error)}`,
          );
        }),
        chain.catch((error) => {
          dependencies.onProblem(
            `coordinator transition failed during disposal: ${String(error)}`,
          );
        }),
      ]).then(() => undefined);
    },
  };
}
