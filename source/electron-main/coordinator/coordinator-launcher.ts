import { createCoordinatorControlServer } from "./coordinator-control-server.js";

export const COORDINATOR_SERVICE_NAME = "sand-node-agent-coordinator";

export interface CoordinatorMessagePort {
  postMessage(value: unknown): void;
  on(event: "message", listener: (event: { readonly data: unknown }) => void): void;
  on(event: "close", listener: () => void): void;
  start(): void;
  close(): void;
}

export interface CoordinatorMessageChannel {
  readonly port1: CoordinatorMessagePort;
  readonly port2: CoordinatorMessagePort;
}

export interface CoordinatorChildProcess {
  postMessage(value: unknown, ports: CoordinatorMessagePort[]): void;
  on(event: "exit", listener: (code: number | null) => void): void;
  kill(): void;
}

export interface CoordinatorLaunchHandle {
  readonly rendererDataPort: CoordinatorMessagePort;
  readonly mainDataPort: CoordinatorMessagePort;
  readonly controlSettled: Promise<unknown>;
  readonly processExited: Promise<{ readonly code: number | null }>;
  dispose(): void;
}

export interface LaunchCoordinatorDependencies {
  readonly fork: (
    artifactPath: string,
    options: { readonly serviceName: string },
  ) => CoordinatorChildProcess;
  readonly artifactPath: string;
  readonly createChannel: () => CoordinatorMessageChannel;
  readonly executors: Record<string, ((args: unknown) => unknown | Promise<unknown>) | undefined>;
  readonly onEvent: Record<string, (payload: unknown) => void>;
  readonly onProblem: (problem: string) => void;
  readonly processConfig: unknown;
  readonly reportFailure?: (leg: string, error: unknown) => void;
}

export function launchCoordinator(
  dependencies: LaunchCoordinatorDependencies,
): CoordinatorLaunchHandle {
  const child = dependencies.fork(dependencies.artifactPath, {
    serviceName: COORDINATOR_SERVICE_NAME,
  });
  const controlChannel = dependencies.createChannel();
  const dataChannel = dependencies.createChannel();
  const mainDataChannel = dependencies.createChannel();
  const server = createCoordinatorControlServer({
    post: (frame) => controlChannel.port2.postMessage(frame),
    executors: dependencies.executors,
    onEvent: dependencies.onEvent,
    onProblem: dependencies.onProblem,
    ...(dependencies.reportFailure === undefined
      ? {}
      : { reportFailure: dependencies.reportFailure }),
  });

  controlChannel.port2.on("message", (event) => server.handleMessage(event.data));
  controlChannel.port2.on("close", () => server.handlePortClosed());
  controlChannel.port2.start();
  child.postMessage(
    { bootstrap: { processConfig: dependencies.processConfig } },
    [controlChannel.port1, dataChannel.port1, mainDataChannel.port1],
  );

  let exited = false;
  const { promise: processExited, resolve: resolveExited } =
    Promise.withResolvers<{ readonly code: number | null }>();
  let controlSettlementObserved = false;
  void server.settled.then(() => {
    controlSettlementObserved = true;
  });

  child.on("exit", (code) => {
    if (exited) return;
    exited = true;
    resolveExited({ code });
    server.handlePortClosed();
    controlChannel.port2.close();
    dataChannel.port2.close();
    mainDataChannel.port2.close();
  });

  let disposeRequested = false;
  return {
    rendererDataPort: dataChannel.port2,
    mainDataPort: mainDataChannel.port2,
    controlSettled: server.settled,
    processExited,
    dispose() {
      if (disposeRequested || exited) return;
      disposeRequested = true;
      server.dispose();
      if (controlSettlementObserved) {
        child.kill();
        return;
      }
      void server.settled.then(() => {
        if (!exited) child.kill();
      });
    },
  };
}
