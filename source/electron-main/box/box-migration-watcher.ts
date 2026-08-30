import { ConnectError, Code } from "@connectrpc/connect";
import { GrokBotService } from "../../packages/proto/generated/aiserver/v1/grok_bot_connect.js";
import { SandBoxMigrationPhase } from "../../packages/proto/generated/aiserver/v1/sand_box_pb.js";
import { createSandCursorBackendClient, type SandInferenceOptions } from "../../shared/node/cursor-backend/cursor-inference.js";
import { isSameSandBoxMigrationOperation, parseSandBoxMigrationOperationId } from "../../shared/box-migration.js";
import type { RecreateOperationId } from "./box-recreate-commands.js";

export type MigrationPhase = "backing-up" | "creating" | "moving" | "cleaning-up" | "wiping" | "done" | "failed";
export interface MigrationStatus { readonly operationId: RecreateOperationId | null; readonly status: MigrationPhase; readonly detail: string }
export interface MigrationEvent { readonly operationId: RecreateOperationId | null; readonly phase: MigrationPhase; readonly detail: string }
export interface MigrationWatchTelemetry { readonly phase: "attached" | "dropped" | "watch_exhausted"; readonly consecutiveFailures: number; readonly errorClass?: string }
export const MIGRATION_WATCH_RECONNECT_MS = 3_000;
export const MIGRATION_WATCH_STALL_MS = 30_000;
export const MIGRATION_WATCH_MAX_STALL_REATTACHES = 20;

export { isSameSandBoxMigrationOperation, parseSandBoxMigrationOperationId };

export interface MigrationBackendEvent { readonly operationId: unknown; readonly phase: number | string; readonly detail?: string | null; readonly offsetKey: string }
const MIGRATION_PHASE_NAME: Readonly<Record<string | number, MigrationPhase | undefined>> = {
  [SandBoxMigrationPhase.BACKING_UP]: "backing-up",
  [SandBoxMigrationPhase.CREATING]: "creating",
  [SandBoxMigrationPhase.MOVING]: "moving",
  [SandBoxMigrationPhase.CLEANING_UP]: "cleaning-up",
  [SandBoxMigrationPhase.WIPING]: "wiping",
  [SandBoxMigrationPhase.DONE]: "done",
  [SandBoxMigrationPhase.FAILED]: "failed",
};
type InjectedMigrationWatcherDeps = { createClient(): { watchSandBoxMigration(request: { fromOffsetKey: string; includeFinished: true }, options: { signal: AbortSignal }): AsyncIterable<MigrationBackendEvent> }; phaseName: Readonly<Record<string | number, MigrationPhase | undefined>> };
type DirectMigrationWatcherDeps = Omit<SandInferenceOptions, "backendUrl">;
export function createSandMigrationWatcher(deps: InjectedMigrationWatcherDeps | DirectMigrationWatcherDeps) {
  let client: { watchSandBoxMigration(request: { fromOffsetKey: string; includeFinished: true }, options: { signal: AbortSignal }): AsyncIterable<MigrationBackendEvent> } | undefined; let resumeOffsetKey = "";
  return async function* watch(signal: AbortSignal): AsyncGenerator<MigrationStatus> {
    const activeClient = client ??= "createClient" in deps ? deps.createClient() : createSandCursorBackendClient(GrokBotService, deps);
    const phaseName = "phaseName" in deps ? deps.phaseName : MIGRATION_PHASE_NAME;
    const fromOffsetKey = resumeOffsetKey; let received = false;
    try {
      for await (const event of activeClient.watchSandBoxMigration({ fromOffsetKey, includeFinished: true }, { signal })) {
        received = true; if (event.offsetKey !== "") resumeOffsetKey = event.offsetKey;
        const status = phaseName[event.phase];
        if (status != null) yield { operationId: parseSandBoxMigrationOperationId(event.operationId), status, detail: event.detail ?? "" };
      }
    } catch (error) { if (!received && fromOffsetKey !== "" && !signal.aborted) resumeOffsetKey = ""; throw error; }
  };
}

export interface StallWatchdog { readonly name?: string; arm(onIdle: () => void): { kick(): void; dispose(): void } }
export function createDelayStallWatchdog(idleMs: number, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): StallWatchdog {
  return { name: "box-migration-stall", arm(onIdle) { let generation = 0; let disposed = false; const schedule = () => { const scheduled = ++generation; void wait(idleMs).then(() => { if (!disposed && scheduled === generation) onIdle(); }); }; schedule(); return { kick: () => { if (!disposed) schedule(); }, dispose: () => { disposed = true; generation += 1; } }; } };
}
const errorClass = (error: unknown): string => error instanceof ConnectError ? Code[error.code] : error instanceof Error && error.name.length > 0 ? error.name : typeof error;
const defaultDelay = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });

export function createSandBoxMigrationRelay(options: { watch?: (signal: AbortSignal) => AsyncIterable<MigrationStatus>; broadcast(event: MigrationEvent): void; onWatchTelemetry?(event: MigrationWatchTelemetry): void; stallWatchdog?: StallWatchdog; delay?: (ms: number, signal: AbortSignal) => Promise<void> }) {
  const stallWatchdog = options.stallWatchdog ?? createDelayStallWatchdog(MIGRATION_WATCH_STALL_MS);
  let abort: AbortController | null = null; let attempt: AbortController | null = null; let lastUpdate: MigrationEvent | null = null; let lastTerminal: MigrationEvent | null = null;
  let watchdog: ReturnType<StallWatchdog["arm"]> | null = null; let remainingStallReattaches = 0; let owedOperationId: RecreateOperationId | null = null; let consecutiveWatchFailures = 0;
  const disarmWatchdog = (): void => { watchdog?.dispose(); watchdog = null; owedOperationId = null; };
  const armWatchdog = (operationId: RecreateOperationId | null): void => { remainingStallReattaches = MIGRATION_WATCH_MAX_STALL_REATTACHES; if (watchdog != null || abort == null) return; owedOperationId = operationId; watchdog = stallWatchdog.arm(() => { if (remainingStallReattaches <= 0) { options.onWatchTelemetry?.({ phase: "watch_exhausted", consecutiveFailures: consecutiveWatchFailures }); disarmWatchdog(); return; } remainingStallReattaches -= 1; attempt?.abort(); watchdog?.kick(); }); };
  const answersOwed = (operationId: RecreateOperationId | null): boolean => owedOperationId == null || operationId != null && isSameSandBoxMigrationOperation(owedOperationId, operationId);
  const rememberTerminal = (event: MigrationEvent): void => { if (event.phase === "done" || event.phase === "failed") lastTerminal = event; else if (lastTerminal != null && event.operationId != null && !isSameSandBoxMigrationOperation(lastTerminal.operationId, event.operationId)) lastTerminal = null; };
  const ingest = (event: MigrationEvent): void => { lastUpdate = event; rememberTerminal(event); options.broadcast(event); };
  return {
    start(): void {
      if (options.watch == null || abort != null) return; const controller = new AbortController(); abort = controller;
      void (async () => { while (!controller.signal.aborted) { const streamAttempt = new AbortController(); attempt = streamAttempt; const abortAttempt = () => streamAttempt.abort(); controller.signal.addEventListener("abort", abortAttempt, { once: true });
        try { for await (const update of options.watch!(streamAttempt.signal)) { if (consecutiveWatchFailures > 0) { consecutiveWatchFailures = 0; options.onWatchTelemetry?.({ phase: "attached", consecutiveFailures: 0 }); } const event = { operationId: update.operationId, phase: update.status, detail: update.detail } satisfies MigrationEvent; lastUpdate = event; rememberTerminal(event); if (update.status === "done" || update.status === "failed") { if (answersOwed(update.operationId)) disarmWatchdog(); else watchdog?.kick(); } else { armWatchdog(update.operationId); watchdog?.kick(); } options.broadcast(event); } }
        catch (error) { if (!controller.signal.aborted) { consecutiveWatchFailures += 1; options.onWatchTelemetry?.({ phase: "dropped", errorClass: errorClass(error), consecutiveFailures: consecutiveWatchFailures }); } }
        finally { controller.signal.removeEventListener("abort", abortAttempt); if (attempt === streamAttempt) attempt = null; }
        lastUpdate = null; if (controller.signal.aborted) break; try { await (options.delay ?? defaultDelay)(MIGRATION_WATCH_RECONNECT_MS, controller.signal); } catch { break; }
      } })();
    },
    getStatus: (): MigrationEvent | null => lastUpdate ?? lastTerminal,
    ingest,
    noteRecreateAccepted(operationId: RecreateOperationId | null): void { owedOperationId = operationId; armWatchdog(operationId); },
    dispose(): void { disarmWatchdog(); abort?.abort(); abort = null; },
  };
}
