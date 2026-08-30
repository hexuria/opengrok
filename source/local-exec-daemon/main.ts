import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createDeadlinePolicy, realClock } from "../internal/scheduling.js";
import { LOCAL_EXEC_GENERATION_TOKEN_ARG, LOCAL_EXEC_GENERATION_TOKEN_ENV } from "../shared/local-exec-process-identity.js";
import { runLocalExecDaemon, type RunLocalExecDaemonOptions } from "../host/local-exec/local-exec-daemon.js";
import { installProcessCrashGuards, type ProcessCrashKind } from "../host/process-crash-guard.js";
import { flushSandSentry, initSandSentryDaemon, type SandSentryDaemonRuntime } from "../host/local-exec/sentry.js";
import { installInvariantReporter } from "../shared/invariant.js";
import { writeInvariantViolationLog } from "./invariant-violation-log.js";
import {
  createDefaultProductionLocalExecExecutor,
  type ProductionLocalExecExecutorFactory,
} from "./production-executor.js";

export const LOCAL_EXEC_DAEMON_SHUTDOWN_TIMEOUT_MS = 2_000;
export const LOCAL_EXEC_DAEMON_LIFETIME_TICK_MS = 60_000;

export interface LocalExecDaemonLifetime {
  release(): void;
}

/**
 * Node promises and the shared scheduling policies do not keep a process alive:
 * the latter intentionally unref their timers. The standalone daemon therefore
 * owns one referenced handle until its signal-driven shutdown has closed the
 * provider and cleared discovery.
 */
export function holdLocalExecDaemonProcessOpen(
  setIntervalImpl: typeof setInterval = setInterval,
  clearIntervalImpl: typeof clearInterval = clearInterval,
): LocalExecDaemonLifetime {
  const timer = setIntervalImpl(() => {}, LOCAL_EXEC_DAEMON_LIFETIME_TICK_MS);
  timer.ref?.();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      clearIntervalImpl(timer);
    },
  };
}

export interface LocalExecDaemonMainDeps {
  readonly runDaemon: (options?: RunLocalExecDaemonOptions) => Promise<{ close(): Promise<void> }>;
  readonly daemonOptions?: RunLocalExecDaemonOptions;
  readonly initCrashReporter?: () => ((error: Error, kind: ProcessCrashKind | "fatal") => void) | undefined;
  readonly flushCrashReporter?: (timeoutMs: number) => Promise<boolean>;
  readonly process?: Pick<NodeJS.Process, "pid" | "on" | "exit">;
  readonly log?: (message: string) => void;
  readonly holdProcessOpen?: () => LocalExecDaemonLifetime;
}

export async function runLocalExecDaemonMain(deps: LocalExecDaemonMainDeps): Promise<{ shutdown(signal: "SIGTERM" | "SIGINT"): void }> {
  const processLike = deps.process ?? process; const log = deps.log ?? console.log; const shutdownDeadline = createDeadlinePolicy(realClock, { name: "local-exec-daemon-shutdown", timeoutMs: LOCAL_EXEC_DAEMON_SHUTDOWN_TIMEOUT_MS });
  installInvariantReporter((report) => writeInvariantViolationLog(report)); const guards = installProcessCrashGuards({ scope: "sand-local-exec-daemon" }); const reportCrash = deps.initCrashReporter?.(); if (reportCrash !== undefined) guards.setReporter(reportCrash);
  const lifetime = (deps.holdProcessOpen ?? holdLocalExecDaemonProcessOpen)(); let daemon: { close(): Promise<void> } | undefined; let pendingSignal: "SIGTERM" | "SIGINT" | undefined; let isShuttingDown = false;
  const beginShutdown = (signal: "SIGTERM" | "SIGINT") => { if (isShuttingDown) return; if (daemon === undefined) { pendingSignal ??= signal; log(`[sand-local-exec-daemon] received ${signal} during startup; shutdown queued`); return; } isShuttingDown = true; const runningDaemon = daemon; log(`[sand-local-exec-daemon] received ${signal}, shutting down`); void shutdownDeadline.run(() => runningDaemon.close()).finally(() => { lifetime.release(); processLike.exit(0); }); };
  processLike.on("SIGTERM", () => beginShutdown("SIGTERM")); processLike.on("SIGINT", () => beginShutdown("SIGINT"));
  try { daemon = await deps.runDaemon(deps.daemonOptions); }
  catch (error) { lifetime.release(); throw error; }
  if (pendingSignal !== undefined) beginShutdown(pendingSignal);
  else log(`[sand-local-exec-daemon] started (pid ${processLike.pid}); serving local exec over the gateway`);
  return { shutdown: beginShutdown };
}

export async function reportLocalExecDaemonFatal(deps: Pick<LocalExecDaemonMainDeps, "initCrashReporter" | "flushCrashReporter" | "process">, error: unknown): Promise<never> {
  const processLike = deps.process ?? process; const deadline = createDeadlinePolicy(realClock, { name: "local-exec-daemon-shutdown", timeoutMs: LOCAL_EXEC_DAEMON_SHUTDOWN_TIMEOUT_MS }); const reportCrash = deps.initCrashReporter?.();
  await deadline.run(async () => { reportCrash?.(error instanceof Error ? error : new Error(String(error)), "fatal"); await deps.flushCrashReporter?.(1_500); }).catch(() => {}); processLike.exit(1); throw new Error("process.exit returned unexpectedly");
}

export function loadLocalExecSentryRuntime(
  requireModule: (id: string) => unknown = createRequire(import.meta.url),
): SandSentryDaemonRuntime | undefined {
  try {
    const runtime = requireModule("@sentry/node") as Partial<SandSentryDaemonRuntime>;
    if (runtime.init == null || runtime.captureException == null || runtime.flush == null || runtime.makeNodeTransport == null) return undefined;
    return runtime as SandSentryDaemonRuntime;
  } catch {
    return undefined;
  }
}

export function composeLocalExecDaemonOptions(
  daemonOptions: RunLocalExecDaemonOptions | undefined,
  productionExecutorFactory: ProductionLocalExecExecutorFactory | undefined,
): RunLocalExecDaemonOptions | undefined {
  if (daemonOptions?.executor !== undefined || productionExecutorFactory === undefined) return daemonOptions;
  return { ...daemonOptions, executor: productionExecutorFactory() };
}

export async function runLocalExecDaemonEntrypoint(options: {
  readonly daemonOptions?: RunLocalExecDaemonOptions;
  readonly productionExecutorFactory?: ProductionLocalExecExecutorFactory;
  readonly sentryRuntime?: SandSentryDaemonRuntime;
  readonly process?: Pick<NodeJS.Process, "pid" | "on" | "exit">;
} = {}): Promise<void> {
  const sentryRuntime = options.sentryRuntime ?? loadLocalExecSentryRuntime();
  let reporterInitialized = false;
  let reportCrash: ((error: Error, kind: ProcessCrashKind | "fatal") => void) | undefined;
  const initCrashReporter = (): typeof reportCrash => {
    if (!reporterInitialized) {
      reporterInitialized = true;
      reportCrash = sentryRuntime === undefined ? undefined : initSandSentryDaemon(sentryRuntime);
    }
    return reportCrash;
  };
  try {
    const daemonOptions = composeLocalExecDaemonOptions(
      options.daemonOptions,
      options.productionExecutorFactory ?? createDefaultProductionLocalExecExecutor,
    );
    const invokedEntry = process.argv[1];
    const generationToken = process.env[LOCAL_EXEC_GENERATION_TOKEN_ENV];
    const argvGeneration = process.argv.find((argument) => argument.startsWith(LOCAL_EXEC_GENERATION_TOKEN_ARG))?.slice(LOCAL_EXEC_GENERATION_TOKEN_ARG.length);
    if (invokedEntry === undefined || generationToken === undefined || generationToken.length === 0 || argvGeneration !== generationToken) throw new Error("local-exec daemon entry identity is not bound");
    const boundDaemonOptions = { ...(daemonOptions ?? {}), entryRealpath: realpathSync(invokedEntry), generationToken };
    await runLocalExecDaemonMain({
      runDaemon: runLocalExecDaemon,
      daemonOptions: boundDaemonOptions,
      initCrashReporter,
      flushCrashReporter: flushSandSentry,
      ...(options.process === undefined ? {} : { process: options.process }),
    });
  } catch (error) {
    await reportLocalExecDaemonFatal({
      initCrashReporter,
      flushCrashReporter: flushSandSentry,
      ...(options.process === undefined ? {} : { process: options.process }),
    }, error);
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void runLocalExecDaemonEntrypoint();
}
