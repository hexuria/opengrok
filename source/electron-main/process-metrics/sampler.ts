import { randomUUID } from "node:crypto";

export type ProcessScanTuple = readonly [
  pid: number,
  ppid: number,
  name: string,
  command: unknown,
  cpuTimeMsCumulative: number,
  memoryMb: number,
  ...rest: readonly unknown[],
];

export interface ProcessMetricsRow {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly cpuTimeMsSample: number;
  readonly sampleAvgMemMb: number;
  readonly samplePeakMemMb: number;
  readonly sessionPeakMemMb: number;
  readonly memoryDuringPeakMb: number;
  readonly cpuDuringPeakPct: number;
}

export interface ProcessMetricsSample {
  readonly sample_start: number;
  readonly sample_end: number;
  readonly num_subsamples: number;
  readonly sample_seqno: number;
  readonly session_id: string;
  readonly rows: readonly ProcessMetricsRow[];
}

interface ProcessTracker {
  readonly pid: number;
  ppid: number;
  name: string;
  cpuBaselineMs: number | undefined;
  cpuLastMs: number | undefined;
  memSumMb: number;
  memCount: number;
  memPeakMb: number;
  sessionPeakMemMb: number;
  lastSeenGeneration: number;
  lastSampleTimeMs: number | undefined;
  lastCpuMsForUtil: number | undefined;
  latestMemMb: number;
  latestCpuUtilPct: number;
  memoryAtSamplePeakMb: number;
  cpuUtilAtSamplePeakPct: number;
}

export class ProcessMetricsSampler {
  private readonly now: () => number;
  readonly sessionId: string;
  private readonly processTrackers = new Map<number, ProcessTracker>();
  private sampleSeqno = 0;
  private windowStartMs: number | undefined;
  private windowLastSeenMs = 0;
  private windowSubsampleCount = 0;
  private windowGeneration = 0;
  private samplePeakTotalMemMb = -1;
  private samplePeakTotalCpuUtilPct = -1;

  constructor(options: { readonly now?: () => number; readonly sessionId?: string } = {}) {
    this.now = options.now ?? Date.now;
    this.sessionId = options.sessionId ?? randomUUID();
  }

  recordSubsample(tuples: readonly ProcessScanTuple[]): void {
    if (tuples.length === 0) return;
    const currentTime = this.now();
    this.windowStartMs ??= currentTime;
    this.windowLastSeenMs = currentTime;
    this.windowSubsampleCount += 1;
    let totalMemThisSubsample = 0;
    let totalCpuUtilThisSubsample = 0;
    const trackersThisSubsample: ProcessTracker[] = [];

    for (const tuple of tuples) {
      const [pid, ppid, name, , cpuTimeMsCumulative, memoryMb] = tuple;
      let tracker = this.processTrackers.get(pid);
      if (tracker == null) {
        tracker = {
          pid, ppid, name, cpuBaselineMs: undefined, cpuLastMs: undefined,
          memSumMb: 0, memCount: 0, memPeakMb: 0, sessionPeakMemMb: memoryMb,
          lastSeenGeneration: this.windowGeneration, lastSampleTimeMs: undefined,
          lastCpuMsForUtil: undefined, latestMemMb: memoryMb, latestCpuUtilPct: 0,
          memoryAtSamplePeakMb: 0, cpuUtilAtSamplePeakPct: 0,
        };
        this.processTrackers.set(pid, tracker);
      }
      tracker.ppid = ppid;
      tracker.name = name;
      tracker.lastSeenGeneration = this.windowGeneration;
      tracker.latestMemMb = memoryMb;
      tracker.sessionPeakMemMb = Math.max(tracker.sessionPeakMemMb, memoryMb);
      tracker.cpuBaselineMs ??= cpuTimeMsCumulative;
      tracker.cpuLastMs = cpuTimeMsCumulative;
      tracker.memSumMb += memoryMb;
      tracker.memCount += 1;
      tracker.memPeakMb = Math.max(tracker.memPeakMb, memoryMb);

      let cpuUtilPct = 0;
      if (tracker.lastSampleTimeMs !== undefined && tracker.lastCpuMsForUtil !== undefined) {
        const elapsedMs = currentTime - tracker.lastSampleTimeMs;
        if (elapsedMs > 0) cpuUtilPct = Math.max(0, cpuTimeMsCumulative - tracker.lastCpuMsForUtil) / elapsedMs * 100;
      }
      tracker.latestCpuUtilPct = cpuUtilPct;
      tracker.lastSampleTimeMs = currentTime;
      tracker.lastCpuMsForUtil = cpuTimeMsCumulative;
      totalMemThisSubsample += memoryMb;
      totalCpuUtilThisSubsample += cpuUtilPct;
      trackersThisSubsample.push(tracker);
    }

    if (totalMemThisSubsample > this.samplePeakTotalMemMb) {
      this.samplePeakTotalMemMb = totalMemThisSubsample;
      for (const tracker of this.processTrackers.values()) tracker.memoryAtSamplePeakMb = 0;
      for (const tracker of trackersThisSubsample) tracker.memoryAtSamplePeakMb = tracker.latestMemMb;
    }
    if (totalCpuUtilThisSubsample > this.samplePeakTotalCpuUtilPct) {
      this.samplePeakTotalCpuUtilPct = totalCpuUtilThisSubsample;
      for (const tracker of this.processTrackers.values()) tracker.cpuUtilAtSamplePeakPct = 0;
      for (const tracker of trackersThisSubsample) tracker.cpuUtilAtSamplePeakPct = tracker.latestCpuUtilPct;
    }
  }

  createSample(): ProcessMetricsSample | null {
    if (this.windowSubsampleCount === 0) return null;
    const sampleStartMs = this.windowStartMs ?? this.windowLastSeenMs;
    const sampleEndMs = this.windowLastSeenMs;
    const numSubsamples = this.windowSubsampleCount;
    const rows: ProcessMetricsRow[] = [];
    for (const tracker of this.processTrackers.values()) {
      if (tracker.memCount === 0 || tracker.cpuBaselineMs === undefined || tracker.cpuLastMs === undefined) continue;
      rows.push({
        pid: tracker.pid,
        ppid: tracker.ppid,
        name: tracker.name,
        cpuTimeMsSample: Math.max(0, tracker.cpuLastMs - tracker.cpuBaselineMs),
        sampleAvgMemMb: tracker.memSumMb / tracker.memCount,
        samplePeakMemMb: tracker.memPeakMb,
        sessionPeakMemMb: tracker.sessionPeakMemMb,
        memoryDuringPeakMb: tracker.memoryAtSamplePeakMb,
        cpuDuringPeakPct: tracker.cpuUtilAtSamplePeakPct,
      });
    }
    this.windowStartMs = this.windowLastSeenMs;
    this.windowLastSeenMs = 0;
    this.windowSubsampleCount = 0;
    this.resetSampleAggregates();
    this.evictUnseen();
    this.windowGeneration += 1;
    return { sample_start: sampleStartMs, sample_end: sampleEndMs, num_subsamples: numSubsamples, sample_seqno: this.sampleSeqno++, session_id: this.sessionId, rows };
  }

  reset(): void {
    this.processTrackers.clear();
    this.windowStartMs = undefined;
    this.windowLastSeenMs = 0;
    this.windowSubsampleCount = 0;
    this.windowGeneration = 0;
    this.samplePeakTotalMemMb = -1;
    this.samplePeakTotalCpuUtilPct = -1;
  }

  private evictUnseen(): void {
    for (const [pid, tracker] of this.processTrackers) {
      if (tracker.lastSeenGeneration !== this.windowGeneration) this.processTrackers.delete(pid);
    }
  }

  private resetSampleAggregates(): void {
    for (const tracker of this.processTrackers.values()) {
      if (tracker.cpuLastMs !== undefined) tracker.cpuBaselineMs = tracker.cpuLastMs;
      tracker.memSumMb = 0;
      tracker.memCount = 0;
      tracker.memPeakMb = 0;
      tracker.memoryAtSamplePeakMb = 0;
      tracker.cpuUtilAtSamplePeakPct = 0;
    }
    this.samplePeakTotalMemMb = -1;
    this.samplePeakTotalCpuUtilPct = -1;
  }
}
