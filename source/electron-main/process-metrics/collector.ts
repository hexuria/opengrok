import { createPollingPolicy, realClock, type Clock, type PollingPolicy } from "../../internal/scheduling.js";
import { ProcessMetricsSampler, type ProcessMetricsSample, type ProcessScanTuple } from "./sampler.js";

export const MIN_SUBSAMPLE_RATE_SEC = 1;
export const MAX_SUBSAMPLE_RATE_SEC = 300;
export const DEFAULT_SUBSAMPLE_RATE_SEC = 10;
export const MIN_SAMPLE_RATE_MIN = 1;
export const MAX_SAMPLE_RATE_MIN = 30;
export const DEFAULT_SAMPLE_RATE_MIN = 5;
export const DEFAULT_PROCESS_METRICS_INIT_DELAY_MS = 10_000;

export interface SandProcessMetricsConfig {
  readonly local_enabled?: boolean;
  readonly backend_reporting_enabled?: boolean;
  readonly subsample_polling_rate_sec?: number;
  readonly sample_polling_rate_min?: number;
}

export interface SandProcessMetricsCollectorOptions {
  readonly getConfig: () => SandProcessMetricsConfig;
  readonly scan: () => Promise<readonly ProcessScanTuple[]>;
  readonly reporter: { report(sample: ProcessMetricsSample, signal: AbortSignal): Promise<void> };
  readonly onConfigChange?: (listener: () => void) => (() => void);
  readonly now?: () => number;
  readonly sessionId?: string;
  readonly isKillSwitchOn?: () => boolean;
  readonly initDelayMs?: number;
  readonly logger?: { error?(message: string, error: unknown): void };
  readonly reportEdgeFailure?: (subsystem: string, leg: string, error: unknown) => void;
  readonly clock?: Clock;
  readonly createPolling?: (intervalMs: number) => PollingPolicy;
}

export function clampProcessMetricsRate(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function defaultProcessMetricsKillSwitch(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SAND_DISABLE_TELEMETRY === "1";
}

export class SandProcessMetricsCollector {
  private readonly sampler: ProcessMetricsSampler;
  private readonly now: () => number;
  private readonly isKillSwitchOn: () => boolean;
  private readonly clock: Clock;
  private tickPolling: { dispose(): void } | undefined;
  private initArm: { dispose(): void } | undefined;
  private unsubscribe: (() => void) | undefined;
  private appliedSubsampleMs = 0;
  private appliedSampleMs = 0;
  private nextSampleAt = 0;
  private schedulerGeneration = 0;
  private started = false;
  private initialized = false;
  private disposed = false;
  private isScanning = false;
  private isReporting = false;
  private collectionGeneration = 0;
  private reportAbort: AbortController | undefined;

  constructor(private readonly options: SandProcessMetricsCollectorOptions) {
    this.sampler = new ProcessMetricsSampler({ ...(options.now === undefined ? {} : { now: options.now }), ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) });
    this.now = options.now ?? Date.now;
    this.isKillSwitchOn = options.isKillSwitchOn ?? defaultProcessMetricsKillSwitch;
    this.clock = options.clock ?? realClock;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.initArm = this.clock.schedule(this.options.initDelayMs ?? DEFAULT_PROCESS_METRICS_INIT_DELAY_MS, () => {
      this.initArm = undefined;
      this.initialized = true;
      try { this.applyConfig(); } catch (error) { this.safeLog("process-metrics init failed", error); }
    });
    if (this.options.onConfigChange != null) {
      this.unsubscribe = this.options.onConfigChange(() => {
        if (!this.initialized) return;
        try { this.applyConfig(); } catch (error) { this.safeLog("process-metrics applyConfig failed", error); }
      });
    }
  }

  isEnabled(config: SandProcessMetricsConfig): boolean {
    return !this.isKillSwitchOn() && config.local_enabled === true;
  }

  applyConfig(): void {
    if (this.disposed) return;
    const config = this.options.getConfig();
    if (!this.isEnabled(config)) {
      this.stopTimers();
      this.sampler.reset();
      this.collectionGeneration += 1;
      this.reportAbort?.abort();
      return;
    }
    const subsampleMs = clampProcessMetricsRate(config.subsample_polling_rate_sec, MIN_SUBSAMPLE_RATE_SEC, MAX_SUBSAMPLE_RATE_SEC, DEFAULT_SUBSAMPLE_RATE_SEC) * 1_000;
    const sampleMs = clampProcessMetricsRate(config.sample_polling_rate_min, MIN_SAMPLE_RATE_MIN, MAX_SAMPLE_RATE_MIN, DEFAULT_SAMPLE_RATE_MIN) * 60_000;
    if (sampleMs !== this.appliedSampleMs) {
      this.appliedSampleMs = sampleMs;
      this.nextSampleAt = this.now() + sampleMs;
    }
    if (this.tickPolling == null || subsampleMs !== this.appliedSubsampleMs) {
      this.appliedSubsampleMs = subsampleMs;
      this.restartTickTimer(subsampleMs);
    }
  }

  async subsampleTick(): Promise<void> {
    try {
      if (this.disposed || !this.isEnabled(this.options.getConfig()) || this.isScanning) return;
      this.isScanning = true;
      const generation = this.collectionGeneration;
      try {
        const tuples = await this.options.scan();
        if (this.disposed || this.collectionGeneration !== generation || !this.isEnabled(this.options.getConfig())) return;
        if (tuples.length > 0) this.sampler.recordSubsample(tuples);
      } finally { this.isScanning = false; }
    } catch (error) { this.safeLog("process-metrics subsample scan failed", error); }
  }

  async sampleTick(): Promise<void> {
    try {
      if (this.disposed) return;
      const config = this.options.getConfig();
      if (!this.isEnabled(config) || this.isReporting) return;
      const sample = this.sampler.createSample();
      if (sample == null || config.backend_reporting_enabled !== true) return;
      this.isReporting = true;
      const abort = new AbortController();
      this.reportAbort = abort;
      try { await this.options.reporter.report(sample, abort.signal); }
      finally { this.isReporting = false; this.reportAbort = undefined; }
    } catch (error) { this.safeLog("process-metrics sample tick failed", error); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.collectionGeneration += 1;
    this.reportAbort?.abort();
    this.initArm?.dispose();
    this.initArm = undefined;
    this.stopTimers();
    if (this.unsubscribe != null) {
      try { this.unsubscribe(); } catch (error) { this.reportEdgeFailure("unsubscribe", error); }
      this.unsubscribe = undefined;
    }
  }

  private restartTickTimer(subsampleMs: number): void {
    this.tickPolling?.dispose();
    this.schedulerGeneration += 1;
    const generation = this.schedulerGeneration;
    let isFirstTick = true;
    const polling = this.options.createPolling?.(subsampleMs) ?? createPollingPolicy(this.clock, { name: "process-metrics-scan", intervalMs: subsampleMs });
    this.tickPolling = polling.start(async () => {
      if (isFirstTick) { isFirstTick = false; await this.subsampleTick(); return; }
      await this.tick(generation);
    });
  }

  private async tick(generation: number): Promise<void> {
    await this.subsampleTick();
    if (this.disposed || generation !== this.schedulerGeneration) return;
    if (this.now() >= this.nextSampleAt) {
      do { this.nextSampleAt += this.appliedSampleMs; } while (this.now() >= this.nextSampleAt);
      void this.sampleTick();
    }
  }

  private safeLog(message: string, error: unknown): void {
    try { this.options.logger?.error?.(message, error); }
    catch (loggerError) { this.reportEdgeFailure("logger", loggerError); }
  }

  private reportEdgeFailure(leg: string, error: unknown): void {
    try { this.options.reportEdgeFailure?.("process-metrics", leg, error); } catch { /* diagnostics stay fail-safe */ }
  }

  private stopTimers(): void {
    this.tickPolling?.dispose();
    this.tickPolling = undefined;
    this.schedulerGeneration += 1;
    this.appliedSubsampleMs = 0;
    this.appliedSampleMs = 0;
    this.nextSampleAt = 0;
  }
}
