import { sanitizeProcessName } from "./redaction.js";

export const PROCESS_METRICS_REPORT_TIMEOUT_MS = 30_000;
export function toWireBigInt(value: number): bigint { return !Number.isFinite(value) || value <= 0 ? 0n : BigInt(Math.trunc(value)); }

export function buildSandProcessMetricsRequest(sample: any, meta: { readonly os: string; readonly osVersion: string; readonly arch: string; readonly clientVersion: string; readonly clientId: string }): any {
  const rows = sample.rows.map((row: any) => {
    const { name, nameHash } = sanitizeProcessName(row.name);
    return { pid: row.pid, ppid: row.ppid, processName: name, processNameHash: nameHash, sampleCpuTimeMs: toWireBigInt(Math.round(row.cpuTimeMsSample)), sampleAvgMemMb: row.sampleAvgMemMb, samplePeakMemMb: row.samplePeakMemMb, sessionPeakMemMb: row.sessionPeakMemMb, memoryDuringSamplePeakMb: row.memoryDuringPeakMb, cpuDuringSamplePeakPct: row.cpuDuringPeakPct };
  });
  return { sampleStart: toWireBigInt(Math.trunc(sample.sample_start)), sampleEnd: toWireBigInt(Math.trunc(sample.sample_end)), numSubsamples: sample.num_subsamples, sampleSeqno: toWireBigInt(sample.sample_seqno), sessionId: sample.session_id, rows, ...meta };
}

export class SandProcessMetricsReporter {
  constructor(private readonly options: { readonly meta: Parameters<typeof buildSandProcessMetricsRequest>[1]; readonly client: { reportSandProcessMetrics(request: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown> } }) {}
  async report(sample: unknown, signal?: AbortSignal): Promise<void> {
    await this.options.client.reportSandProcessMetrics(buildSandProcessMetricsRequest(sample, this.options.meta), { timeoutMs: PROCESS_METRICS_REPORT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) });
  }
}
