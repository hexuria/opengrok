import { createRealPollingPolicy, type PollingPolicy } from "../../internal/scheduling.js";
import { SAND_CLIENT_PAUSE_REASON } from "../../shared/gateway-reachability.js";
import {
  commandCarriesLocalExecGeneration,
  localExecDiscoveryTimeMatchesProcess,
  sameLocalExecProcessIdentity,
  type ExpectedLocalExecProcessIdentity,
  type LocalExecProcessIdentity,
} from "../../shared/local-exec-process-identity.js";
import {
  readLocalExecDaemonDiscovery,
  removeLocalExecDaemonFile,
  removeLocalExecDaemonDiscoveryIfMatches,
  resolveLocalExecDaemonPaths,
  writeLocalExecDaemonConnection,
  writeLocalExecDaemonCredential,
  writeLocalExecSupervisorHeartbeat
} from "./daemon-files.js";

export const LOCAL_EXEC_DAEMON_REFRESH_INTERVAL_MS = 30_000;
export const LOCAL_EXEC_DAEMON_LIVENESS_INTERVAL_MS = 1_000;
export const LOCAL_EXEC_DAEMON_READINESS_TIMEOUT_MS = 5_000;
export const LOCAL_EXEC_DAEMON_READINESS_POLL_MS = 50;
export const LOCAL_EXEC_DAEMON_DISCOVERY_MISS_LIMIT = 2;
export const LOCAL_EXEC_DAEMON_RESPAWN_LIMIT = 10;

export function createLocalExecDaemonRefreshPolicy(): PollingPolicy {
  return createRealPollingPolicy({ name: "local-exec-daemon-refresh", intervalMs: LOCAL_EXEC_DAEMON_REFRESH_INTERVAL_MS });
}

export function createLocalExecDaemonLivenessPolicy(): PollingPolicy {
  return createRealPollingPolicy({ name: "local-exec-daemon-liveness", intervalMs: LOCAL_EXEC_DAEMON_LIVENESS_INTERVAL_MS });
}

export type LocalExecDaemonAction =
  | { readonly kind: "spawn" }
  | { readonly kind: "adopt"; readonly pid: number }
  | { readonly kind: "replace"; readonly pid: number };

export function decideLocalExecDaemonAction(existing: { readonly pid: number; readonly inflightCount?: number } | null): LocalExecDaemonAction {
  if (existing == null) return { kind: "spawn" };
  if ((existing.inflightCount ?? 0) > 0) return { kind: "adopt", pid: existing.pid };
  return { kind: "replace", pid: existing.pid };
}

export type LocalExecDaemonState =
  | { readonly phase: "absent" }
  | { readonly phase: "adopting" | "replacing"; readonly pid: number }
  | { readonly phase: "active"; readonly daemon: { readonly origin: "spawned" | "adopted"; readonly pid: number; readonly startedAt: number; readonly processStartEpochMs: number; readonly command: string; readonly entryRealpath: string; readonly generationToken: string } }
  | { readonly phase: "failed"; readonly reason: string };

interface LocalExecControl {
  resolveGatewayConnection(args: { readonly purpose?: "local-exec-daemon" }): Promise<unknown>;
  mintLocalExecDaemonCredential(args: Record<string, never>): Promise<unknown | null>;
  spawnLocalExecDaemon(args: { readonly env: Readonly<Record<string, string>>; readonly logPath: string }): Promise<LocalExecProcessIdentity>;
  isProcessAlive(args: { readonly pid: number }): Promise<boolean>;
  getProcessIdentity(args: ExpectedLocalExecProcessIdentity): Promise<LocalExecProcessIdentity | null>;
  waitLocalExecDaemonExit(identity: LocalExecProcessIdentity): Promise<{ readonly identity: LocalExecProcessIdentity; readonly exitCode: number | null; readonly signal: string | null }>;
  terminateProcess(args: { readonly identity: LocalExecProcessIdentity }): Promise<{ readonly terminated: boolean }>;
}

export interface LocalExecDaemonSupervisorOptions {
  readonly dataDir: string;
  readonly isPackaged: boolean;
  readonly control: LocalExecControl;
  readonly refreshPolicy: PollingPolicy;
  readonly livenessPolicy?: PollingPolicy;
  readonly readinessTimeoutMs?: number;
  readonly readinessPollMs?: number;
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isClientPauseRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.includes(SAND_CLIENT_PAUSE_REASON);
}

function isProcessIdentity(value: unknown): value is LocalExecProcessIdentity { if (typeof value !== "object" || value == null) return false; const identity = value as Partial<LocalExecProcessIdentity>; return Number.isInteger(identity.pid) && (identity.pid ?? 0) > 0 && typeof identity.startEpochMs === "number" && Number.isFinite(identity.startEpochMs) && typeof identity.command === "string" && identity.command.length > 0 && typeof identity.entryRealpath === "string" && identity.entryRealpath.length > 0 && typeof identity.generationToken === "string" && identity.generationToken.length > 0 && commandCarriesLocalExecGeneration(identity.command, identity.entryRealpath, identity.generationToken); }
function descriptorHasIdentity(discovery: { readonly entryRealpath?: string; readonly generationToken?: string }): discovery is { readonly entryRealpath: string; readonly generationToken: string } { return typeof discovery.entryRealpath === "string" && discovery.entryRealpath.length > 0 && typeof discovery.generationToken === "string" && discovery.generationToken.length > 0; }
function descriptorMatchesProcess(discovery: { readonly pid: number; readonly startedAt: number; readonly entryRealpath?: string; readonly generationToken?: string }, identity: LocalExecProcessIdentity, observedAtMs: number): boolean { return descriptorHasIdentity(discovery) && discovery.pid === identity.pid && localExecDiscoveryTimeMatchesProcess(discovery.startedAt, identity.startEpochMs, observedAtMs) && discovery.entryRealpath === identity.entryRealpath && discovery.generationToken === identity.generationToken && commandCarriesLocalExecGeneration(identity.command, identity.entryRealpath, identity.generationToken); }
function activeGeneration(origin: "spawned" | "adopted", discovery: { readonly pid: number; readonly startedAt: number }, identity: LocalExecProcessIdentity): Extract<LocalExecDaemonState, { phase: "active" }> { return { phase: "active", daemon: { origin, pid: discovery.pid, startedAt: discovery.startedAt, processStartEpochMs: identity.startEpochMs, command: identity.command, entryRealpath: identity.entryRealpath, generationToken: identity.generationToken } }; }
function identityFromActive(state: Extract<LocalExecDaemonState, { phase: "active" }>): LocalExecProcessIdentity { return { pid: state.daemon.pid, startEpochMs: state.daemon.processStartEpochMs, command: state.daemon.command, entryRealpath: state.daemon.entryRealpath, generationToken: state.daemon.generationToken }; }

export function createLocalExecDaemonSupervisor(options: LocalExecDaemonSupervisorOptions) {
  const paths = resolveLocalExecDaemonPaths(options.dataDir);
  let state: LocalExecDaemonState = { phase: "absent" };
  let started = false;
  let startPromise: Promise<void> | undefined;
  let credentialHandedOff = false;
  let disposed = false;
  let polling: { dispose(): void } | undefined;
  let livenessPolling: { dispose(): void } | undefined;
  let refreshSequence = 0;
  let descriptorWrite = Promise.resolve();
  let paused = false;
  let refusedForClientPause = false;
  let reconciliation = Promise.resolve();
  let missingDiscoveryTicks = 0;
  let consecutiveRespawns = 0;
  let quarantinedIdentity: LocalExecProcessIdentity | undefined;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const readinessTimeoutMs = options.readinessTimeoutMs ?? LOCAL_EXEC_DAEMON_READINESS_TIMEOUT_MS;
  const readinessPollMs = options.readinessPollMs ?? LOCAL_EXEC_DAEMON_READINESS_POLL_MS;

  const enqueue = async <T>(work: () => Promise<T>): Promise<T> => { const run = reconciliation.then(work); reconciliation = run.then(() => undefined, () => undefined); return run; };

  const currentIdentity = async (expected: ExpectedLocalExecProcessIdentity): Promise<LocalExecProcessIdentity | null> => { const identity = await options.control.getProcessIdentity(expected); return isProcessIdentity(identity) ? identity : null; };
  const terminateIfStillOwned = async (expected: LocalExecProcessIdentity): Promise<boolean> => (await options.control.terminateProcess({ identity: expected })).terminated;
  const quarantineBlocksSpawn = async (): Promise<boolean> => {
    if (quarantinedIdentity == null) return false;
    const quarantined = quarantinedIdentity;
    const observed = await currentIdentity(quarantined);
    if (observed != null && sameLocalExecProcessIdentity(observed, quarantined)) return true;
    if (await options.control.isProcessAlive({ pid: quarantined.pid })) return true;
    quarantinedIdentity = undefined;
    return false;
  };
  const observeSpawnedExit = (identity: LocalExecProcessIdentity) => { void options.control.waitLocalExecDaemonExit(identity).then((settlement) => enqueue(async () => { if (disposed || !sameLocalExecProcessIdentity(settlement.identity, identity) || state.phase !== "active" || !sameLocalExecProcessIdentity(identityFromActive(state), identity)) return; if (consecutiveRespawns >= LOCAL_EXEC_DAEMON_RESPAWN_LIMIT) { state = { phase: "failed", reason: "respawn limit reached" }; return; } state = { phase: "absent" }; if (!paused && !refusedForClientPause) { consecutiveRespawns += 1; await establishDaemon(); } }), () => {}); };

  const refreshConnectionInternal = async () => {
    if (disposed || paused) return;
    const refreshId = ++refreshSequence;
    try {
      const connection = await options.control.resolveGatewayConnection({ purpose: "local-exec-daemon" });
      const write = descriptorWrite.then(async () => {
        if (disposed || refreshId !== refreshSequence) return;
        await writeLocalExecDaemonConnection(connection, paths.connectionPath);
      });
      descriptorWrite = write.then(() => undefined, () => undefined);
      await write;
      await writeLocalExecSupervisorHeartbeat(paths.supervisorHeartbeatPath);
      refusedForClientPause = false;
    } catch (error) {
      if (!isClientPauseRefusal(error)) return;
      refusedForClientPause = true;
      await retireDaemonForPause();
    }
  };

  const refreshCredential = async () => {
    if (credentialHandedOff || disposed || paused) return;
    try {
      const credential = await options.control.mintLocalExecDaemonCredential({});
      if (credential == null || disposed) return;
      await writeLocalExecDaemonCredential(credential, paths.credentialPath);
      credentialHandedOff = true;
    } catch {}
  };

  const spawnDaemon = async () => {
    if (paused || refusedForClientPause) return;
    const spawned = await options.control.spawnLocalExecDaemon({
      env: { ELECTRON_RUN_AS_NODE: "1", SAND_PACKAGED: options.isPackaged ? "1" : "0" },
      logPath: paths.logPath
    });
    if (!isProcessIdentity(spawned)) throw new Error("local-exec spawn did not return a valid daemon identity");
    observeSpawnedExit(spawned);
    const cleanupFailedSpawn = async () => {
      await terminateIfStillOwned(spawned);
      const discovery = await readLocalExecDaemonDiscovery(paths.discoveryPath);
      if (discovery != null
        && discovery.pid === spawned.pid
        && discovery.entryRealpath === spawned.entryRealpath
        && discovery.generationToken === spawned.generationToken) await removeLocalExecDaemonDiscoveryIfMatches(paths.discoveryPath, discovery);
    };
    try {
      const deadline = now() + readinessTimeoutMs;
      for (;;) {
        if (disposed || paused || refusedForClientPause) { await cleanupFailedSpawn(); return; }
        const discovery = await readLocalExecDaemonDiscovery(paths.discoveryPath);
        const observed = await currentIdentity(spawned);
        if (observed == null || !sameLocalExecProcessIdentity(observed, spawned)) throw new Error(`local-exec daemon ${spawned.pid} exited or changed identity before readiness`);
        if (discovery != null && descriptorMatchesProcess(discovery, spawned, now())) {
          quarantinedIdentity = undefined;
          state = activeGeneration("spawned", discovery, spawned);
          missingDiscoveryTicks = 0;
          return;
        }
        if (now() >= deadline) throw new Error(`local-exec daemon ${spawned.pid} did not publish matching discovery before readiness timeout`);
        await delay(readinessPollMs);
      }
    } catch (error) {
      await cleanupFailedSpawn();
      throw error;
    }
  };

  const retireDaemonForPause = async () => {
    refreshSequence += 1;
    try {
      if (await quarantineBlocksSpawn()) {
        const existing = await readLocalExecDaemonDiscovery(paths.discoveryPath);
        if (existing != null) await removeLocalExecDaemonDiscoveryIfMatches(paths.discoveryPath, existing);
        await removeLocalExecDaemonFile(paths.connectionPath);
        state = { phase: "failed", reason: "local-exec active discovery generation changed while its verified process remained live" };
        missingDiscoveryTicks = 0;
        return;
      }
      const active = state.phase === "active" ? state : null;
      if (active != null) await terminateIfStillOwned(identityFromActive(active));
      const existing = await readLocalExecDaemonDiscovery(paths.discoveryPath);
      if (existing != null) {
        const identity = descriptorHasIdentity(existing) ? await currentIdentity({ ...existing, discoveryStartedAt: existing.startedAt }) : null;
        if (identity != null && descriptorMatchesProcess(existing, identity, now())) await terminateIfStillOwned(identity);
        await removeLocalExecDaemonDiscoveryIfMatches(paths.discoveryPath, existing);
      }
      await removeLocalExecDaemonFile(paths.connectionPath);
      quarantinedIdentity = undefined;
      state = { phase: "absent" };
      missingDiscoveryTicks = 0;
    } catch (error) { state = { phase: "failed", reason: failureReason(error) }; }
  };

  const establishDaemon = async () => {
    if (paused || refusedForClientPause) return;
    try {
      const existing = await readLocalExecDaemonDiscovery(paths.discoveryPath);
      if (disposed) return;
      if (existing != null) {
        const identity = descriptorHasIdentity(existing) ? await currentIdentity({ ...existing, discoveryStartedAt: existing.startedAt }) : null;
        if (identity == null || !descriptorMatchesProcess(existing, identity, now())) {
          await removeLocalExecDaemonDiscoveryIfMatches(paths.discoveryPath, existing);
          await spawnDaemon();
          return;
        }
        if ((existing.inflightCount ?? 0) > 0) {
          quarantinedIdentity = undefined;
          state = { phase: "adopting", pid: existing.pid };
          state = activeGeneration("adopted", existing, identity);
          missingDiscoveryTicks = 0;
          return;
        }
        state = { phase: "replacing", pid: existing.pid };
        await terminateIfStillOwned(identity);
        if (disposed) return;
        await removeLocalExecDaemonDiscoveryIfMatches(paths.discoveryPath, existing);
        await spawnDaemon();
        return;
      }
      await spawnDaemon();
    } catch (error) {
      state = { phase: "failed", reason: failureReason(error) };
    }
  };

  const healDaemonInternal = async () => {
    if (paused || refusedForClientPause) { await retireDaemonForPause(); return; }
    if (state.phase === "absent") { consecutiveRespawns = 0; await establishDaemon(); return; }
    if (state.phase === "failed") {
      if (await quarantineBlocksSpawn()) return;
      if (consecutiveRespawns >= LOCAL_EXEC_DAEMON_RESPAWN_LIMIT) return;
      consecutiveRespawns += 1;
      await establishDaemon();
      return;
    }
    if (state.phase !== "active") return;
    let discovery;
    try { discovery = await readLocalExecDaemonDiscovery(paths.discoveryPath); }
    catch (error) { state = { phase: "failed", reason: `local-exec discovery unreadable: ${failureReason(error)}` }; return; }
    const active = state;
    const activeIdentity = identityFromActive(active);
    if (discovery == null) {
      missingDiscoveryTicks += 1;
      if (missingDiscoveryTicks < LOCAL_EXEC_DAEMON_DISCOVERY_MISS_LIMIT) return;
      await terminateIfStillOwned(activeIdentity);
      state = { phase: "absent" };
    } else if (discovery.pid === active.daemon.pid
      && discovery.startedAt === active.daemon.startedAt
      && discovery.entryRealpath === active.daemon.entryRealpath
      && discovery.generationToken === active.daemon.generationToken) {
      const observed = await currentIdentity(activeIdentity);
      if (observed != null && sameLocalExecProcessIdentity(observed, activeIdentity)) { missingDiscoveryTicks = 0; consecutiveRespawns = 0; return; }
      await removeLocalExecDaemonDiscoveryIfMatches(paths.discoveryPath, discovery);
      state = { phase: "absent" };
    } else {
      if (discovery.pid === active.daemon.pid) {
        await removeLocalExecDaemonDiscoveryIfMatches(paths.discoveryPath, discovery);
        const observed = await currentIdentity(activeIdentity);
        if (observed != null && sameLocalExecProcessIdentity(observed, activeIdentity)) {
          quarantinedIdentity = activeIdentity;
          missingDiscoveryTicks = 0;
          state = { phase: "failed", reason: "local-exec active discovery generation changed while its verified process remained live" };
          return;
        }
        state = { phase: "absent" };
      } else {
        const successorIdentity = descriptorHasIdentity(discovery) ? await currentIdentity({ ...discovery, discoveryStartedAt: discovery.startedAt }) : null;
        if (successorIdentity != null && descriptorMatchesProcess(discovery, successorIdentity, now())) {
          await terminateIfStillOwned(activeIdentity);
          quarantinedIdentity = undefined;
          state = activeGeneration("adopted", discovery, successorIdentity);
          missingDiscoveryTicks = 0;
          consecutiveRespawns = 0;
          return;
        }
        await removeLocalExecDaemonDiscoveryIfMatches(paths.discoveryPath, discovery);
        await terminateIfStillOwned(activeIdentity);
        state = { phase: "absent" };
      }
    }
    if (consecutiveRespawns >= LOCAL_EXEC_DAEMON_RESPAWN_LIMIT) {
      state = { phase: "failed", reason: "respawn limit reached" };
      return;
    }
    consecutiveRespawns += 1;
    await establishDaemon();
  };
  const healDaemon = async () => {
    try { await healDaemonInternal(); }
    catch (error) { state = { phase: "failed", reason: `local-exec reconciliation failed: ${failureReason(error)}` }; }
  };

  return {
    async start(): Promise<void> {
      if (startPromise !== undefined) return startPromise;
      if (disposed) return;
      started = true;
      startPromise = (async () => {
        await enqueue(async () => { await refreshConnectionInternal(); await refreshCredential(); if (!disposed) await establishDaemon(); });
        if (disposed) return;
        let absorbedImmediateTick = false;
        polling = options.refreshPolicy.start(async () => {
          if (!absorbedImmediateTick) { absorbedImmediateTick = true; return; }
          await enqueue(async () => { await refreshConnectionInternal(); await refreshCredential(); });
        });
        let absorbedImmediateLivenessTick = false;
        livenessPolling = (options.livenessPolicy ?? createLocalExecDaemonLivenessPolicy()).start(async () => {
          if (!absorbedImmediateLivenessTick) { absorbedImmediateLivenessTick = true; return; }
          await enqueue(healDaemon);
        });
      })();
      return startPromise;
    },
    refreshConnection: () => enqueue(refreshConnectionInternal),
    async setPaused(next: boolean): Promise<void> {
      await enqueue(async () => {
        if (disposed || paused === next) return;
        paused = next;
        if (next) { await retireDaemonForPause(); return; }
        if (!started) return;
        await refreshConnectionInternal();
        await refreshCredential();
        if (await quarantineBlocksSpawn()) {
          state = { phase: "failed", reason: "local-exec active discovery generation changed while its verified process remained live" };
          return;
        }
        await establishDaemon();
      });
    },
    state: () => state,
    whenIdle: () => reconciliation,
    dispose(): Promise<void> {
      if (disposed) return reconciliation;
      disposed = true;
      polling?.dispose();
      polling = undefined;
      livenessPolling?.dispose();
      livenessPolling = undefined;
      return enqueue(async () => {});
    }
  };
}
