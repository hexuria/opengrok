import { DeadlineExceededError, type DeadlinePolicy, type PollingPolicy, type RetryPolicy } from "../../../internal/scheduling.js";
import { CodebaseSnapshotTrigger } from "./codebase-snapshot-trigger.js";
import { createSandCodebaseTelemetryHost } from "./codebase-telemetry-host.js";
import { createCodebaseTelemetryPrivacyMode, type PrivacyMode, type TelemetryAuth } from "./privacy-mode.js";
import type { CsnapsCodebaseTelemetryAdapter, Logger } from "./codebase-telemetry-adapter.js";

export function createSandCodebaseTelemetryLogger(log: (message: string) => void): Logger { const write = (level: string, message: string, error?: unknown) => log(`[codebase-telemetry] ${level}: ${message}${error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`}`); return { error: (message,error) => write("error",message,error), warn: (message,error) => write("warn",message,error), info: (message,error) => write("info",message,error), debug: (message,error) => write("debug",message,error) }; }

export function createCodebaseTelemetryService(options: {
  readonly auth: Parameters<typeof createSandCodebaseTelemetryHost>[0]["auth"];
  readonly experiments: Parameters<typeof createSandCodebaseTelemetryHost>[0]["experiments"];
  readonly events: { on(topic: string, listener: (event: { requestId: string }) => void): () => void };
  readonly createAdapter: (options: { credentials: TelemetryAuth; signal: AbortSignal }) => Promise<CsnapsCodebaseTelemetryAdapter>;
  readonly loadPrivacyMode: (args: { auth: TelemetryAuth; signal: AbortSignal }) => Promise<PrivacyMode>;
  readonly policies: { privacyLookupDeadline: DeadlinePolicy; privacyLookupRetry: RetryPolicy; privacyRefreshPolling: PollingPolicy; sessionRestartDelay: RetryPolicy; shutdownDeadline: DeadlinePolicy };
  readonly logger: Logger;
}) {
  const privacyMode = createCodebaseTelemetryPrivacyMode({ load: options.loadPrivacyMode, lookupDeadline: options.policies.privacyLookupDeadline, lookupRetry: options.policies.privacyLookupRetry, refreshPolling: options.policies.privacyRefreshPolling, logger: options.logger });
  let adapter: CsnapsCodebaseTelemetryAdapter | undefined;
  let adapterAbort: AbortController | undefined;
  let restartDelay: { readonly elapsed: Promise<void>; dispose(): void } | undefined;
  let restartPromise: Promise<void> | undefined;
  let stopping = false;
  let generation = 0;
  const host = createSandCodebaseTelemetryHost({ auth: options.auth, experiments: options.experiments, privacyMode, createAdapter: (value) => options.createAdapter(value as { credentials: TelemetryAuth; signal: AbortSignal }), logger: options.logger });
  const ensureAdapter = async (credentials: TelemetryAuth | undefined) => {
    const currentGeneration = ++generation;
    adapterAbort?.abort();
    adapterAbort = undefined;
    const previous = adapter;
    adapter = undefined;
    await previous?.close();
    if (credentials == null || stopping || currentGeneration !== generation) return;
    const controller = new AbortController();
    adapterAbort = controller;
    try {
      const created = await options.createAdapter({ credentials, signal: controller.signal });
      if (controller.signal.aborted || stopping || currentGeneration !== generation) { await created.close(); return; }
      adapter = created;
      void created.terminalFailure.then(() => scheduleRestart(created));
      await created.setDesiredCodebases(host.desiredCodebases.get());
    } catch (error) {
      if (!controller.signal.aborted && !stopping && currentGeneration === generation) options.logger.error("Failed to start Codebase Telemetry adapter", error);
    }
  };
  const scheduleRestart = (failed: CsnapsCodebaseTelemetryAdapter) => {
    if (stopping || adapter !== failed || restartPromise != null) return;
    restartPromise = (async () => {
      await ensureAdapter(undefined);
      if (stopping) return;
      const delay = options.policies.sessionRestartDelay.schedule(1);
      restartDelay = delay;
      try { await delay.elapsed; }
      catch (error) { if (!stopping) throw error; return; }
      finally { if (restartDelay === delay) restartDelay = undefined; delay.dispose(); }
      if (!stopping) await ensureAdapter(host.auth.get());
    })().finally(() => { restartPromise = undefined; });
    void restartPromise.catch((error) => options.logger.error("Failed to restart Codebase Telemetry after adapter failure", error));
  };
  const authSubscription = host.auth.subscribe((credentials) => void ensureAdapter(credentials));
  void ensureAdapter(host.auth.get());
  const snapshotTrigger = new CodebaseSnapshotTrigger({ getSession: () => adapter, logger: options.logger });
  const offStart = options.events.on("transcript.run-started", ({ requestId }) => snapshotTrigger.handle({ type: "AGENT_REQUEST_START", requestId }));
  const offEnd = options.events.on("transcript.run-ended", ({ requestId }) => snapshotTrigger.handle({ type: "AGENT_REQUEST_END", requestId }));
  let disposePromise: Promise<void> | undefined;
  return {
    api: { async flushPendingUploads() { if (adapter != null) await adapter.flushPendingUploads(); } },
    dispose() {
      stopping = true;
      generation += 1;
      adapterAbort?.abort();
      restartDelay?.dispose();
      return disposePromise ??= (async () => {
        authSubscription.dispose(); offStart(); offEnd();
        try { await options.policies.shutdownDeadline.run(async () => { await adapter?.close(); }); }
        catch (error) { if (!(error instanceof DeadlineExceededError)) throw error; options.logger.warn("Controller shutdown exceeded its deadline", error); }
        finally { adapter = undefined; host.dispose(); privacyMode.dispose(); }
      })();
    }
  };
}
