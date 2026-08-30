import { installInvariantReporter } from "../shared/invariant.js";
import { gatewayScheme, resolveGatewayServerConfig } from "./gateway-config.js";
import { startGatewayServer } from "./gateway-server.js";
import { clearGatewayDiscovery, writeGatewayDiscovery } from "./host-discovery.js";
import { pinHostDiagnosticsReporter } from "./host-diagnostics.js";
import { acquireHostLock } from "./host-lock.js";
import { getSandRootDir } from "./host-paths.js";
import path from "node:path";
import { installProcessCrashGuards } from "./process-crash-guard.js";
import {
  createProductionSandHost,
  type ProductionSandHostPorts
} from "./sand-host.js";
import {
  resolveBoxExecDaemonEntry,
  startBoxExecDaemonProcess,
  type OwnedBoxExecDaemon,
} from "./box/exec-daemon-process.js";

export const BOX_COPY_IN_ARG = "--box-copy-in";
export const BOX_COPY_IN_EXIT_FAILED = 1;
export const SHUTDOWN_WATCHDOG_MS = 5_000;

export interface HostProcessControl {
  readonly argv: readonly string[];
  readonly pid: number;
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): void;
  exit(code: number): void;
}

export interface HostLock {
  release(): void;
}

export interface HostLockResult {
  readonly lock: HostLock;
  readonly outcome: string;
  readonly previousPid?: number;
}

export interface GatewayServerConfig {
  readonly host: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly tls?: unknown;
}

export interface StartedGateway {
  readonly port: number;
  close(): Promise<void>;
}

export interface HostMainHost {
  readonly startedAt: number;
  start(): Promise<void>;
  dispose(): Promise<void>;
  getApi(): unknown;
  subscribe(listener: (event: unknown) => void): () => void;
  getHealth(): unknown;
  noteEventStreamClosed(): void;
  noteDesktopContact(): void;
  prepareForUpgrade(): Promise<unknown>;
  getLocalExecBridge(): unknown;
  getWebAuthnBridge(): unknown;
  reportProcessCrash(error: unknown, kind: string): void;
  reportInvariantViolation(report: unknown): void;
  reportHostDiagnostic(diagnostic: unknown): void;
  reportGatewayCommandError(report: unknown): void;
  reportGatewayCommandSuccess(report: unknown): void;
  flushTelemetryForFatalExit(): Promise<void>;
  reportBoxReady(): Promise<void>;
}

export interface ProcessCrashGuards {
  setReporter(reporter: (error: unknown, kind: string) => void): void;
}

export interface HostMainDependencies {
  executeBoxCopyInFromEnv(): Promise<number>;
  installProcessCrashGuards(options: { scope: "sand-host" }): ProcessCrashGuards;
  installInvariantReporter(reporter: (report: unknown) => void): void;
  pinHostDiagnosticsReporter(reporter: (diagnostic: unknown) => void): void;
  acquireHostLock(): Promise<HostLockResult>;
  startBoxExecDaemon?(): Promise<OwnedBoxExecDaemon>;
  getSandRootDir(): string;
  createHost(): HostMainHost;
  resolveGatewayServerConfig(): GatewayServerConfig;
  gatewayScheme(config: GatewayServerConfig): string;
  startGatewayServer(options: {
    api: unknown;
    subscribe(listener: (event: unknown) => void): () => void;
    getHealth(): unknown;
    onEventStreamClosed(): void;
    onDesktopContact(): void;
    prepareForUpgrade(): Promise<unknown>;
    startedAt: number;
    host: string;
    port?: number;
    authToken?: string;
    tls?: unknown;
    localExec: unknown;
    webauthn: unknown;
    onCommandError(report: unknown): void;
    onCommandComplete(report: unknown): void;
  }): Promise<StartedGateway>;
  writeGatewayDiscovery(discovery: {
    port: number;
    pid: number;
    startedAt: number;
    scheme: string;
    host: string;
    token?: string;
  }): Promise<void>;
  clearGatewayDiscovery(): Promise<void>;
  readonly log?: Pick<Console, "log" | "error">;
}

/** The copy-in bootstrap is supplied by the recovered Box-store composition. */
export interface HostProductionPorts extends ProductionSandHostPorts {
  executeBoxCopyInFromEnv(): Promise<number>;
}

/** Builds the source-only process/bootstrap graph used by the packaged host entry. */
export function createProductionHostMainDependencies(
  ports: HostProductionPorts
): HostMainDependencies {
  const useExistingBoxExecDaemon = process.env.SAND_USE_EXISTING_BOX_EXEC_DAEMON === "1";
  return {
    executeBoxCopyInFromEnv: ports.executeBoxCopyInFromEnv,
    installProcessCrashGuards: options => installProcessCrashGuards(options),
    installInvariantReporter: reporter => { void installInvariantReporter(reporter); },
    pinHostDiagnosticsReporter: reporter => pinHostDiagnosticsReporter(
      reporter as Parameters<typeof pinHostDiagnosticsReporter>[0]
    ),
    acquireHostLock,
    ...(useExistingBoxExecDaemon ? {} : { startBoxExecDaemon: () => startBoxExecDaemonProcess({
        entryPath: resolveBoxExecDaemonEntry(),
        generated: ports.extensionHost.boxGenerated,
        workspaceRoot: path.join(getSandRootDir(), "box-workspace"),
        terminalsDirectory: path.join(getSandRootDir(), "box-terminals"),
        ...(ports.log === undefined ? {} : { log: ports.log }),
      }) }),
    getSandRootDir,
    createHost: () => createProductionSandHost({
      ...ports,
      extensionHost: {
        ...ports.extensionHost,
        standaloneBoxExecDaemon: !useExistingBoxExecDaemon,
      },
    }),
    resolveGatewayServerConfig,
    gatewayScheme,
    startGatewayServer: options => startGatewayServer(
      options as Parameters<typeof startGatewayServer>[0]
    ),
    writeGatewayDiscovery: discovery => writeGatewayDiscovery({
      ...discovery,
      scheme: discovery.scheme as "http" | "https"
    }),
    clearGatewayDiscovery,
    ...(ports.log === undefined ? {} : { log: ports.log })
  };
}

/** Starts the concrete clean-source host graph from explicit generated ports. */
export function startProductionHost(
  ports: HostProductionPorts,
  processControl: HostProcessControl = defaultProcessControl
): Promise<void> {
  return main(createProductionHostMainDependencies(ports), processControl);
}

export interface ShutdownRegistration {
  shutdown(signal: "SIGTERM" | "SIGINT"): void;
}

const defaultProcessControl: HostProcessControl = {
  argv: process.argv,
  pid: process.pid,
  on: (signal, listener) => process.on(signal, listener),
  exit: code => process.exit(code)
};

/**
 * Runs the artifact's two startup modes: the fail-closed box-copy helper, or
 * the long-lived host/gateway composition.
 */
export async function main(
  deps: HostMainDependencies,
  processControl: HostProcessControl = defaultProcessControl
): Promise<void> {
  const log = deps.log ?? console;

  if (processControl.argv.includes(BOX_COPY_IN_ARG)) {
    let code: number;
    try {
      code = await deps.executeBoxCopyInFromEnv();
    } catch (error) {
      log.error("[box-copy-in] unexpected error (failing closed):", error);
      code = BOX_COPY_IN_EXIT_FAILED;
    }
    processControl.exit(code);
    return;
  }

  const crashGuards = deps.installProcessCrashGuards({ scope: "sand-host" });
  const lockResult = await deps.acquireHostLock();
  reportLockOutcome(lockResult, deps.getSandRootDir(), log);

  const hostLock = lockResult.lock;
  let boxExecDaemon: OwnedBoxExecDaemon | undefined;
  const host = deps.createHost();
  crashGuards.setReporter((error, kind) => {
    host.reportProcessCrash(error, kind);
  });
  deps.installInvariantReporter(report => host.reportInvariantViolation(report));
  deps.pinHostDiagnosticsReporter(diagnostic => {
    host.reportHostDiagnostic(diagnostic);
  });

  try {
    boxExecDaemon = await deps.startBoxExecDaemon?.();
    await host.start();
    const gatewayConfig = deps.resolveGatewayServerConfig();
    const scheme = deps.gatewayScheme(gatewayConfig);
    const gateway = await deps.startGatewayServer({
      api: host.getApi(),
      subscribe: listener => host.subscribe(listener),
      getHealth: () => host.getHealth(),
      onEventStreamClosed: () => host.noteEventStreamClosed(),
      onDesktopContact: () => host.noteDesktopContact(),
      prepareForUpgrade: () => host.prepareForUpgrade(),
      startedAt: host.startedAt,
      host: gatewayConfig.host,
      ...(gatewayConfig.port === undefined ? {} : { port: gatewayConfig.port }),
      ...(gatewayConfig.authToken === undefined
        ? {}
        : { authToken: gatewayConfig.authToken }),
      ...(gatewayConfig.tls === undefined ? {} : { tls: gatewayConfig.tls }),
      localExec: host.getLocalExecBridge(),
      webauthn: host.getWebAuthnBridge(),
      onCommandError: report => host.reportGatewayCommandError(report),
      onCommandComplete: report => host.reportGatewayCommandSuccess(report)
    });

    await deps.writeGatewayDiscovery({
      port: gateway.port,
      pid: processControl.pid,
      startedAt: host.startedAt,
      scheme,
      host: gatewayConfig.host,
      ...(gatewayConfig.authToken === undefined
        ? {}
        : { token: gatewayConfig.authToken })
    });

    log.log(
      `[sand-host] gateway listening on ${scheme}://${gatewayConfig.host}:${gateway.port}` +
      (gatewayConfig.authToken != null ? " (auth required)" : "")
    );

    installShutdownHandlers(
      host,
      gateway,
      hostLock,
      deps.clearGatewayDiscovery,
      processControl,
      log,
      SHUTDOWN_WATCHDOG_MS,
      boxExecDaemon,
    );
    void host.reportBoxReady();
  } catch (error) {
    host.reportProcessCrash(error, "fatal_startup");
    await host.flushTelemetryForFatalExit();
    await boxExecDaemon?.close().catch(closeError => host.reportProcessCrash(closeError, "box_exec_daemon_startup_cleanup"));
    hostLock.release();
    processControl.exit(1);
  }
}

export function reportLockOutcome(
  result: HostLockResult,
  sandRootDir: string,
  log: Pick<Console, "log">
): void {
  if (result.outcome === "took-over") {
    log.log(
      `[sand-host] took over ${sandRootDir} from live host pid ${result.previousPid}`
    );
  } else if (result.previousPid != null) {
    log.log(
      `[sand-host] reclaimed ${sandRootDir} lock (${result.outcome}) from pid ${result.previousPid}`
    );
  }
}

export function installShutdownHandlers(
  host: Pick<
    HostMainHost,
    "dispose" | "reportProcessCrash" | "flushTelemetryForFatalExit"
  >,
  gateway: Pick<StartedGateway, "close">,
  hostLock: HostLock,
  clearGatewayDiscovery: () => Promise<void>,
  processControl: HostProcessControl = defaultProcessControl,
  log: Pick<Console, "log"> = console,
  watchdogMs = SHUTDOWN_WATCHDOG_MS,
  boxExecDaemon?: OwnedBoxExecDaemon,
): ShutdownRegistration {
  let isShuttingDown = false;

  const shutdown = (signal: "SIGTERM" | "SIGINT") => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.log(`[sand-host] received ${signal}, shutting down`);

    const watchdog = setTimeout(() => {
      host.reportProcessCrash(null, "shutdown_watchdog");
      void host.flushTelemetryForFatalExit().finally(() => {
        hostLock.release();
        processControl.exit(1);
      });
    }, watchdogMs);
    watchdog.unref();

    void (async () => {
      try {
        await gateway.close();
        await host.dispose();
        await boxExecDaemon?.close();
        await clearGatewayDiscovery();
      } catch (error) {
        host.reportProcessCrash(error, "shutdown_error");
        await host.flushTelemetryForFatalExit();
      } finally {
        clearTimeout(watchdog);
        hostLock.release();
        processControl.exit(0);
      }
    })();
  };

  processControl.on("SIGTERM", () => shutdown("SIGTERM"));
  processControl.on("SIGINT", () => shutdown("SIGINT"));
  return { shutdown };
}
