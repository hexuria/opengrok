import {
  AnalyticsEvent as AnalyticsEventMessage,
  TrackEventsRequest,
} from "../proto/generated/aiserver/v1/analytics_pb.js";
import { toEventData, type AnalyticsEventProperties } from "./to-event-data.js";

const DEFAULT_BUFFER_LIMIT = 200;
const DEFAULT_FLUSH_INTERVAL_MS = 3_000;
const DEFAULT_NORMAL_FLUSH_TIMEOUT_MS = 2_500;
const TOKEN_CHECK_TIMEOUT = Symbol("token_check_timeout");

export interface AnalyticsBufferClient {
  trackEvents(request: TrackEventsRequest, options: { readonly signal: AbortSignal }): Promise<unknown>;
}

export interface AnalyticsBufferTokenProvider {
  getAccessToken(): Promise<string | null | undefined>;
}

export interface AnalyticsBufferOptions {
  readonly client: AnalyticsBufferClient;
  readonly tokenProvider: AnalyticsBufferTokenProvider;
  readonly bufferLimit?: number | undefined;
  readonly flushIntervalMs?: number | undefined;
  readonly normalFlushTimeoutMs?: number | undefined;
  readonly onDebug?: ((tag: string, payload: unknown) => void) | undefined;
}

export class AnalyticsBuffer {
  private buffer: AnalyticsEventMessage[];
  private flushTimer: NodeJS.Timeout | null;
  private activeFlush: Promise<number> | null;
  private client: AnalyticsBufferClient;
  private tokenProvider: AnalyticsBufferTokenProvider;
  private bufferLimit: number;
  private flushIntervalMs: number;
  private normalFlushTimeoutMs: number;
  private onDebug: (tag: string, payload: unknown) => void;

  constructor(options: AnalyticsBufferOptions) {
    this.buffer = [];
    this.flushTimer = null;
    this.activeFlush = null;
    this.client = options.client;
    this.tokenProvider = options.tokenProvider;
    this.bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.normalFlushTimeoutMs = options.normalFlushTimeoutMs ?? DEFAULT_NORMAL_FLUSH_TIMEOUT_MS;
    this.onDebug = options.onDebug ?? (() => {});
  }

  track(eventName: string, props: AnalyticsEventProperties | null | undefined, timestamp?: number): void {
    const timestampValue = typeof timestamp === "number" ? BigInt(timestamp) : BigInt(Date.now());
    const event = new AnalyticsEventMessage({
      eventName,
      eventData: toEventData(props),
      timestamp: timestampValue,
    });
    this.buffer.push(event);
    if (this.buffer.length >= this.bufferLimit) this.flushInBackground();
    else this.scheduleFlush();
  }

  async flush(timeoutMs: number): Promise<void> {
    while (true) {
      if (this.activeFlush) {
        await this.activeFlush;
        if (this.buffer.length === 0) return;
        continue;
      }
      if (this.buffer.length === 0) return;
      const flushPromise = this.flushOnce(timeoutMs);
      this.activeFlush = flushPromise;
      let sentCount = 0;
      try {
        sentCount = await flushPromise;
      } finally {
        if (this.activeFlush === flushPromise) this.activeFlush = null;
      }
      if (this.buffer.length === 0 || sentCount === 0) return;
    }
  }

  private async flushOnce(timeoutMs: number): Promise<number> {
    if (this.buffer.length === 0) return 0;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      try {
        const token = await Promise.race([
          this.tokenProvider.getAccessToken(),
          new Promise<typeof TOKEN_CHECK_TIMEOUT>(resolve => {
            controller.signal.addEventListener("abort", () => resolve(TOKEN_CHECK_TIMEOUT), { once: true });
          }),
        ]);
        if (token === TOKEN_CHECK_TIMEOUT) {
          this.onDebug("analytics.flush.deferred", { reason: "token_check_timed_out", count: this.buffer.length });
          return 0;
        }
        if (!token) {
          this.onDebug("analytics.flush.deferred", { reason: "no_token", count: this.buffer.length });
          return 0;
        }
      } catch (error) {
        this.onDebug("analytics.flush.deferred", { reason: "token_check_failed", error, count: this.buffer.length });
        return 0;
      }
      const toSend = this.buffer.slice();
      if (toSend.length === 0) return 0;
      try {
        await this.client.trackEvents(new TrackEventsRequest({ events: toSend }), { signal: controller.signal });
        this.buffer.splice(0, toSend.length);
        return toSend.length;
      } catch (error) {
        this.onDebug("analytics.flush.error", { error });
        if (this.buffer.length > this.bufferLimit) this.buffer.splice(0, this.buffer.length - this.bufferLimit);
        return 0;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private flushInBackground(): void {
    void this.flush(this.normalFlushTimeoutMs);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushInBackground();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }
}
