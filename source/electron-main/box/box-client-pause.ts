import { SAND_CLIENT_PAUSE_BLOCKED_MESSAGE } from "../../shared/gateway-reachability.js";

export const SAND_CLIENT_PAUSE_GATE = "sand_client_pause";

export class SandClientPausedError extends Error {
  constructor() {
    super(SAND_CLIENT_PAUSE_BLOCKED_MESSAGE);
    this.name = "SandClientPausedError";
  }
}

export interface RemoteHostConnector<TConnection, TRecreateArgs = unknown, TRecreateResult = unknown, TCredential = unknown> {
  connect(): Promise<TConnection>;
  recreate?(args: TRecreateArgs): Promise<TRecreateResult>;
  forceRecreate?(): Promise<TRecreateResult>;
  issueLocalExecDaemonCredential?(): Promise<TCredential | undefined>;
}

export function wrapRemoteHostConnectorWithClientPause<TConnection, TRecreateArgs, TRecreateResult, TCredential>(
  base: RemoteHostConnector<TConnection, TRecreateArgs, TRecreateResult, TCredential>,
  isPaused: () => boolean,
): RemoteHostConnector<TConnection, TRecreateArgs, TRecreateResult, TCredential> {
  const refuseWhilePaused = (): void => { if (isPaused()) throw new SandClientPausedError(); };
  return {
    connect: async () => { refuseWhilePaused(); return await base.connect(); },
    ...(base.recreate == null ? {} : { recreate: async (args: TRecreateArgs) => { refuseWhilePaused(); return await base.recreate!.call(base, args); } }),
    ...(base.forceRecreate == null ? {} : { forceRecreate: async () => { refuseWhilePaused(); return await base.forceRecreate!.call(base); } }),
    ...(base.issueLocalExecDaemonCredential == null ? {} : {
      issueLocalExecDaemonCredential: async () => isPaused() ? undefined : await base.issueLocalExecDaemonCredential!.call(base),
    }),
  };
}

export function createSandClientPauseControl<TConnection, TRecreateArgs, TRecreateResult, TCredential>(
  gates: { checkFeatureGate(name: string): boolean },
  coordinator: { setGatewayPaused(args: { paused: boolean }): Promise<{ paused: boolean }> },
  egress: { dropObservedConnection(): void },
) {
  const isPaused = (): boolean => gates.checkFeatureGate(SAND_CLIENT_PAUSE_GATE);
  let coordinatorPaused = false;
  let egressDroppedForPause = false;
  let chain: Promise<unknown> = Promise.resolve();
  const serializeAndConsumeRejection = (operation: () => Promise<void>): void => {
    const run = chain.then(operation);
    chain = Promise.allSettled([run]);
  };
  const sync = (): void => {
    const paused = isPaused();
    if (paused && !egressDroppedForPause) egress.dropObservedConnection();
    egressDroppedForPause = paused;
    serializeAndConsumeRejection(async () => {
      if (paused === coordinatorPaused) return;
      coordinatorPaused = (await coordinator.setGatewayPaused({ paused })).paused;
    });
  };
  return {
    isPaused,
    guard: (base: RemoteHostConnector<TConnection, TRecreateArgs, TRecreateResult, TCredential>) => wrapRemoteHostConnectorWithClientPause(base, isPaused),
    noteGateMayHaveChanged: sync,
    reapplyAfterCoordinatorLaunch: () => { coordinatorPaused = false; sync(); },
  };
}
