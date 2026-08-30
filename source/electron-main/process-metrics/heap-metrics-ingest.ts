import { parseHeapMetricsReport } from "../../shared/observability/heap-metrics.js";

export const SAND_HEAP_USED_METRIC = "sand.heap.used";
export const SAND_HEAP_LIMIT_METRIC = "sand.heap.limit";
export const SAND_LOADED_AGENTS_METRIC = "sand.loaded_agents.count";
export const SAND_LOADED_TRANSCRIPT_ENTRIES_METRIC = "sand.loaded_transcript_entries.total";
export const SAND_IDLE_MINUTES_METRIC = "sand.idleMinutes.last15m";

export function ingestHeapMetricsReport(report: unknown, sink: { report(metric: string, value: number): void }): boolean {
  const parsed = parseHeapMetricsReport(report);
  if (parsed == null) return false;
  sink.report(SAND_HEAP_USED_METRIC, parsed.usedBytes);
  sink.report(SAND_HEAP_LIMIT_METRIC, parsed.limitBytes);
  if (parsed.loadedAgents !== undefined) sink.report(SAND_LOADED_AGENTS_METRIC, parsed.loadedAgents);
  if (parsed.loadedTranscriptEntries !== undefined) sink.report(SAND_LOADED_TRANSCRIPT_ENTRIES_METRIC, parsed.loadedTranscriptEntries);
  if (parsed.idleMinutesLast15m !== undefined) sink.report(SAND_IDLE_MINUTES_METRIC, parsed.idleMinutesLast15m);
  return true;
}

export function createFlushCoalescer(flush: () => Promise<void>, reportFailure: (error: unknown) => void = () => undefined): () => void {
  let inFlight = false;
  let pending = false;
  const run = (): void => {
    inFlight = true;
    void flush().catch(reportFailure).finally(() => {
      inFlight = false;
      if (pending) { pending = false; run(); }
    });
  };
  return () => { if (inFlight) { pending = true; return; } run(); };
}
