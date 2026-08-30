export interface HeapMetricsReport {
  readonly usedBytes: number;
  readonly limitBytes: number;
  readonly loadedAgents?: number;
  readonly loadedTranscriptEntries?: number;
  readonly idleMinutesLast15m?: number;
}

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function isMetricCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseHeapMetricsReport(value: unknown): HeapMetricsReport | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const usedBytes = ownDataValue(value, "usedBytes");
    const limitBytes = ownDataValue(value, "limitBytes");
    const loadedAgents = ownDataValue(value, "loadedAgents");
    const loadedTranscriptEntries = ownDataValue(value, "loadedTranscriptEntries");
    const idleMinutesLast15m = ownDataValue(value, "idleMinutesLast15m");
    if (typeof usedBytes !== "number" || !Number.isFinite(usedBytes) || usedBytes < 0) return null;
    if (typeof limitBytes !== "number" || !Number.isFinite(limitBytes) || limitBytes <= 0) return null;
    return {
      usedBytes: usedBytes === 0 ? 0 : usedBytes,
      limitBytes,
      ...(isMetricCount(loadedAgents) ? { loadedAgents } : {}),
      ...(isMetricCount(loadedTranscriptEntries) ? { loadedTranscriptEntries } : {}),
      ...(isMetricCount(idleMinutesLast15m) ? { idleMinutesLast15m } : {}),
    };
  } catch { return null; }
}
