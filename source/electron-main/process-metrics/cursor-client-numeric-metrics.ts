import { randomUUID } from "node:crypto";
import { AiService } from "../../packages/proto/generated/aiserver/v1/aiserver_connect.js";
import { ClientNumericMetric } from "../../packages/proto/generated/aiserver/v1/aiserver_pb.js";
import { createSandCursorBackendClient } from "../../shared/node/cursor-backend/cursor-inference.js";
import { reportDesktopEdgeFailure } from "../desktop-edge-failures.js";

const MAX_PENDING_METRICS = 1_000;
export interface NumericMetricSample { readonly metric: string; readonly value: number; readonly timestampMs: number }

export class SandClientNumericMetricsManager {
  private client: { reportClientNumericMetrics(request: unknown): Promise<unknown> } | undefined;
  private pending: NumericMetricSample[] = [];
  private disposed = false;
  private flushTail = Promise.resolve();
  readonly sessionId: string;

  constructor(private readonly options: {
    readonly isFlushEnabled: () => boolean;
    readonly clientVersion: string;
    readonly clientForTesting?: { reportClientNumericMetrics(request: unknown): Promise<unknown> };
    readonly createClient?: () => { reportClientNumericMetrics(request: unknown): Promise<unknown> };
    readonly getCursorAccessToken?: (options: { readonly backendUrl: string }) => Promise<string>;
    readonly getMachineId?: () => Promise<string> | string;
    readonly onRequestId?: (requestId: string) => void;
    readonly createMetric?: (sample: NumericMetricSample & { readonly clientVersion: string; readonly sessionId: string; readonly os: NodeJS.Platform; readonly timestampMsBigInt: bigint }) => unknown;
    readonly now?: () => number;
    readonly sessionId?: string;
    readonly platform?: NodeJS.Platform;
    readonly reportFailure?: (operation: "flush" | "submit", error: unknown) => void;
  }) { this.sessionId = options.sessionId ?? randomUUID(); }

  report(metric: string, value: number): void {
    if (this.disposed || !Number.isFinite(value) || !this.options.isFlushEnabled()) return;
    this.pending.push({ metric, value, timestampMs: (this.options.now ?? Date.now)() });
    if (this.pending.length > MAX_PENDING_METRICS) this.pending.splice(0, this.pending.length - MAX_PENDING_METRICS);
  }

  flush(): Promise<void> {
    this.flushTail = this.flushTail.then(() => this.flushOnce()).catch((error: unknown) => {
      reportDesktopEdgeFailure("numeric-metrics", "flush", error);
      this.options.reportFailure?.("flush", error);
    });
    return this.flushTail;
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; void this.flush(); }

  private getClient() {
    if (this.options.clientForTesting != null) return this.options.clientForTesting;
    this.client ??= this.options.createClient?.() ?? (
      this.options.getCursorAccessToken !== undefined && this.options.getMachineId !== undefined
        ? createSandCursorBackendClient(AiService, {
            getAccessToken: this.options.getCursorAccessToken,
            getMachineId: this.options.getMachineId,
            ...(this.options.onRequestId === undefined ? {} : { onRequestId: this.options.onRequestId }),
          }) as unknown as { reportClientNumericMetrics(request: unknown): Promise<unknown> }
        : undefined
    );
    if (this.client == null) throw new Error("Numeric metrics client is unavailable");
    return this.client;
  }

  private async flushOnce(): Promise<void> {
    if (!this.options.isFlushEnabled()) { this.pending = []; return; }
    const toSend = this.pending.splice(0);
    if (toSend.length === 0) return;
    try {
      await this.getClient().reportClientNumericMetrics({ metrics: toSend.map((sample) => {
        const input = { ...sample, timestampMsBigInt: BigInt(sample.timestampMs), clientVersion: this.options.clientVersion, sessionId: this.sessionId, os: this.options.platform ?? process.platform };
        if (this.options.createMetric !== undefined) return this.options.createMetric(input);
        if (this.options.clientForTesting !== undefined) return input;
        return new ClientNumericMetric({
          metric: sample.metric,
          value: sample.value,
          timestampMs: BigInt(sample.timestampMs),
          clientVersion: this.options.clientVersion,
          sessionId: this.sessionId,
          os: process.platform,
        });
      }) });
    } catch (error) {
      reportDesktopEdgeFailure("numeric-metrics", "submit", error);
      this.options.reportFailure?.("submit", error);
    }
  }
}
