import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HEALTHY_COORDINATOR_UPTIME_MS,
  classifyCoordinatorExitCode,
} from "./coordinator-telemetry.js";
import {
  launchCoordinator,
  type CoordinatorLaunchHandle,
  type LaunchCoordinatorDependencies,
} from "./coordinator-launcher.js";

export function resolveCoordinatorArtifactPath(
  importMetaUrl = import.meta.url,
): string {
  const here = dirname(fileURLToPath(importMetaUrl));
  return join(here, "..", "node-agent-coordinator", "main.cjs");
}

export const COORDINATOR_PORT_REQUEST_CHANNEL = "sand:coordinator-port-request";
export const COORDINATOR_PORT_CHANNEL = "sand:coordinator-port";

type GenerationPayload = { readonly generation: number };
type TransportDownPayload = GenerationPayload & {
  readonly reason: string;
  readonly cause?: string | null;
};
type CoordinatorEventConsumer = Record<string, (payload: any) => void> & {
  "transport-connected": (payload: GenerationPayload) => void;
  "transport-down": (payload: TransportDownPayload) => void;
};

export function fenceStaleGenerations<T extends CoordinatorEventConsumer>(
  consumer: T,
): T {
  let highestGeneration = 0;
  const passes = (generation: number): boolean => {
    if (generation < highestGeneration) return false;
    highestGeneration = generation;
    return true;
  };

  return {
    ...consumer,
    "transport-connected": (payload: GenerationPayload) => {
      if (!passes(payload.generation)) return;
      consumer["transport-connected"](payload);
    },
    "transport-down": (payload: TransportDownPayload) => {
      if (!passes(payload.generation)) return;
      consumer["transport-down"](payload);
    },
  } as T;
}

export interface CoordinatorRelaunchDelay {
  readonly elapsed: Promise<void>;
  dispose(): void;
}

export interface CoordinatorRuntimeDependencies
  extends Omit<LaunchCoordinatorDependencies, "onEvent" | "reportFailure"> {
  readonly onEvent: CoordinatorEventConsumer;
  readonly monotonicNow: () => number;
  readonly onMainDataPort: (port: unknown) => void;
  readonly onLifecycle: (event: CoordinatorLifecycleEvent) => void;
  readonly relaunchBackoff: {
    schedule(attempt: number): CoordinatorRelaunchDelay;
  };
  readonly launch?: (
    dependencies: LaunchCoordinatorDependencies,
  ) => CoordinatorLaunchHandle;
}

export type CoordinatorLifecycleEvent =
  | {
      readonly outcome: "exited";
      readonly exitCodeClass: ReturnType<typeof classifyCoordinatorExitCode>;
      readonly uptimeMs: number;
      readonly relaunchSeq: number;
    }
  | {
      readonly outcome: "relaunched";
      readonly delayMs: number;
      readonly relaunchSeq: number;
    };

export interface CoordinatorRuntime {
  requestRendererPort(sink: (port: unknown) => void): void;
  revokeRendererPortRequest(): void;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

export function createCoordinatorRuntime(
  dependencies: CoordinatorRuntimeDependencies,
): CoordinatorRuntime {
  let disposed = false;
  let current: CoordinatorLaunchHandle;
  const launchedHandles = new Set<CoordinatorLaunchHandle>();
  let disposeCompletion: Promise<void> | undefined;
  let launchedAtMs = 0;
  let relaunchSeq = 0;
  let fastExitAttempt = 0;
  let pendingRelaunch: CoordinatorRelaunchDelay | undefined;

  const cancelPendingRelaunch = (): void => {
    pendingRelaunch?.dispose();
    pendingRelaunch = undefined;
  };

  let portTransferred = false;
  let requester: ((port: unknown) => void) | null = null;
  const serveRequester = (): void => {
    if (requester === null || portTransferred || disposed) return;
    portTransferred = true;
    try {
      requester(current.rendererDataPort);
    } catch (error) {
      dependencies.onProblem(`renderer port transfer failed: ${String(error)}`);
      requester = null;
    }
  };

  const launch = (): void => {
    const handle = (dependencies.launch ?? launchCoordinator)({
      fork: dependencies.fork,
      createChannel: dependencies.createChannel,
      executors: dependencies.executors,
      // Generations restart at one with each child. The old control server stops
      // dispatching when that child exits, so every launch gets a fresh fence.
      onEvent: fenceStaleGenerations(dependencies.onEvent),
      onProblem: dependencies.onProblem,
      processConfig: dependencies.processConfig,
      artifactPath: dependencies.artifactPath,
    });
    current = handle;
    launchedHandles.add(handle);
    portTransferred = false;
    launchedAtMs = dependencies.monotonicNow();

    try {
      dependencies.onMainDataPort(handle.mainDataPort);
    } catch (error) {
      dependencies.onProblem(`main data port handoff failed: ${String(error)}`);
    }

    void handle.processExited.then(({ code }) => {
      launchedHandles.delete(handle);
      if (disposed || current !== handle) return;

      const uptimeMs = dependencies.monotonicNow() - launchedAtMs;
      relaunchSeq += 1;
      fastExitAttempt =
        uptimeMs < HEALTHY_COORDINATOR_UPTIME_MS ? fastExitAttempt + 1 : 1;
      dependencies.onLifecycle({
        outcome: "exited",
        exitCodeClass: classifyCoordinatorExitCode(code),
        uptimeMs,
        relaunchSeq,
      });
      dependencies.onProblem(
        `coordinator exited (code ${String(code)}); relaunching`,
      );

      const scheduledAtMs = dependencies.monotonicNow();
      const delay = dependencies.relaunchBackoff.schedule(fastExitAttempt);
      pendingRelaunch = delay;
      void delay.elapsed.then(
        () => {
          if (disposed || pendingRelaunch !== delay) return;
          pendingRelaunch = undefined;
          dependencies.onLifecycle({
            outcome: "relaunched",
            delayMs: dependencies.monotonicNow() - scheduledAtMs,
            relaunchSeq,
          });
          launch();
          serveRequester();
        },
        () => {},
      );
    });
  };

  launch();
  return {
    requestRendererPort(sink) {
      requester = sink;
      if (disposed) return;
      if (pendingRelaunch !== undefined) {
        cancelPendingRelaunch();
        launch();
        serveRequester();
        return;
      }
      if (!portTransferred) {
        serveRequester();
        return;
      }
      const previous = current;
      launch();
      previous.dispose();
      serveRequester();
    },
    revokeRendererPortRequest() {
      requester = null;
    },
    restart() {
      if (disposed) return Promise.resolve();
      cancelPendingRelaunch();
      const previous = current;
      launch();
      previous.dispose();
      serveRequester();
      return previous.processExited.then(() => undefined);
    },
    dispose() {
      if (disposeCompletion !== undefined) return disposeCompletion;
      disposed = true;
      cancelPendingRelaunch();
      current.dispose();
      disposeCompletion = Promise.all(
        [...launchedHandles].map((handle) => handle.processExited),
      ).then(() => undefined);
      return disposeCompletion;
    },
  };
}
