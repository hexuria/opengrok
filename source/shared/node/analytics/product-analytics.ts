import { AnalyticsService } from "../../../packages/proto/generated/aiserver/v1/analytics_connect.js";
import type { TrackEventsRequest } from "../../../packages/proto/generated/aiserver/v1/analytics_pb.js";
import { createSandCursorBackendClient, getSandInferenceBackendUrl } from "../cursor-backend/cursor-inference.js";
import { getSandClientVersion } from "../sand-client-metadata.js";
import { getSandVariant } from "../sand-variant.js";
import {
  AnalyticsBuffer,
  type AnalyticsBufferClient,
} from "../../../packages/analytics-client/buffer.js";
import {
  DeferredAnalyticsBuffer,
  type DeferredAnalyticsEvent,
} from "../../../packages/analytics-client/deferred-buffer.js";

const SAND_PRODUCT_ANALYTICS_GATE = "sand_product_analytics";
const MAX_DEFERRED_EVENTS = 256;

function isAnalyticsOptedOut(): boolean {
  return process.env.SAND_DISABLE_TELEMETRY === "1" || process.env.SAND_DISABLE_ANALYTICS === "1";
}

function isAnalyticsDebug(): boolean {
  return process.env.SAND_ANALYTICS_DEBUG === "1";
}

export interface ProductAnalyticsClient extends AnalyticsBufferClient {
  trackEvents(request: TrackEventsRequest, options: { readonly signal: AbortSignal }): Promise<unknown>;
}

export interface ProductAnalyticsGate {
  checkGate(name: string): Promise<boolean>;
  subscribe(listener: () => void): () => void;
}

interface ProductAnalyticsOptions {
  readonly hostInBox: boolean;
  getAccessToken(options: { backendUrl: string }): Promise<string>;
  getMachineId(): Promise<string>;
  createClient?(): ProductAnalyticsClient;
}

type AnalyticsState =
  | { kind: "disabled" }
  | { kind: "deferred"; buffer: DeferredAnalyticsBuffer }
  | { kind: "active"; buffer: AnalyticsBuffer };

export class SandProductAnalytics {
  state: AnalyticsState;
  activated = false;
  isEvaluating = false;
  gate: ProductAnalyticsGate | undefined;
  unsubscribeGate: (() => void) | undefined;
  baseProps: Readonly<Record<string, string | boolean>>;
  options: ProductAnalyticsOptions;
  debug = isAnalyticsDebug();
  lastActiveDayKeys = new Map<string, string>();

  constructor(options: ProductAnalyticsOptions) {
    this.options = options;
    this.baseProps = {
      client: "sand",
      sand_version: getSandClientVersion(),
      flavor: getSandVariant(),
      os: process.platform,
      arch: process.arch,
      host_in_box: options.hostInBox,
    };
    this.state = isAnalyticsOptedOut()
      ? { kind: "disabled" }
      : { kind: "deferred", buffer: new DeferredAnalyticsBuffer() };
  }

  async activate(gate: ProductAnalyticsGate): Promise<void> {
    if (this.activated) return;
    this.activated = true;
    if (this.state.kind === "disabled") return;
    this.gate = gate;
    try {
      this.unsubscribeGate = gate.subscribe(() => {
        void this.evaluateGate();
      });
    } catch {
      this.unsubscribeGate = undefined;
    }
    await this.evaluateGate();
  }

  private async evaluateGate(): Promise<void> {
    const gate = this.gate;
    if (gate == null) return;
    if (this.state.kind === "active" || this.state.kind === "disabled") {
      this.teardownGateSubscription();
      return;
    }
    if (this.isEvaluating) return;
    this.isEvaluating = true;
    try {
      if (isAnalyticsOptedOut()) {
        this.disable("opted_out");
        return;
      }
      let enabled = false;
      try {
        enabled = await gate.checkGate(SAND_PRODUCT_ANALYTICS_GATE);
      } catch {
        enabled = false;
      }
      if (!enabled) {
        if (this.debug) {
          console.info(`[sand-analytics] gate ${SAND_PRODUCT_ANALYTICS_GATE} off; buffering until a later refresh`);
        }
        return;
      }
      this.goLive();
    } finally {
      this.isEvaluating = false;
    }
  }

  private goLive(): void {
    const deferredBuffer = this.state.kind === "deferred" ? this.state.buffer : undefined;
    try {
      const createClient = this.options.createClient ?? (() =>
        createSandCursorBackendClient(AnalyticsService, {
          getAccessToken: this.options.getAccessToken,
          getMachineId: this.options.getMachineId,
        }));
      const buffer = new AnalyticsBuffer({
        client: createClient(),
        tokenProvider: {
          getAccessToken: async () => {
            try {
              const token = await this.options.getAccessToken({ backendUrl: getSandInferenceBackendUrl() });
              return token.length > 0 ? token : null;
            } catch {
              return null;
            }
          },
        },
        ...(this.debug
          ? { onDebug: (tag: string, payload: unknown) => console.info(`[sand-analytics] ${tag}`, payload) }
          : {}),
      });
      if (deferredBuffer != null) {
        for (const event of deferredBuffer.getEvents() as readonly DeferredAnalyticsEvent[]) {
          buffer.track(event.eventName, event.props, event.timestamp);
        }
        deferredBuffer.clear();
      }
      this.state = { kind: "active", buffer };
      this.teardownGateSubscription();
      if (this.debug) console.info("[sand-analytics] enabled");
    } catch (error) {
      if (this.debug) console.info("[sand-analytics] failed to enable; disabling", error);
      this.disable("error");
    }
  }

  private disable(reason: string): void {
    if (this.state.kind === "deferred") this.state.buffer.clear();
    this.state = { kind: "disabled" };
    this.teardownGateSubscription();
    if (this.debug) console.info(`[sand-analytics] disabled (${reason})`);
  }

  private teardownGateSubscription(): void {
    if (this.unsubscribeGate != null) {
      try {
        this.unsubscribeGate();
      } catch {
        // The artifact isolates gate teardown failures.
      }
      this.unsubscribeGate = undefined;
    }
  }

  trackEvent(event: string, props: Readonly<Record<string, unknown>> = {}): void {
    if (this.state.kind !== "deferred" && this.state.kind !== "active") return;
    if (this.state.kind === "deferred" && this.state.buffer.getEvents().length >= MAX_DEFERRED_EVENTS) return;
    const enriched = this.enrich(props);
    if (this.debug) console.info(`[sand-analytics] track ${event}`, enriched);
    this.state.buffer.track(event, enriched);
  }

  markActive(reason: string): void {
    if (!this.canRecordEvents()) return;
    const dayKey = new Date().toISOString().slice(0, 10);
    if (this.lastActiveDayKeys.get(reason) === dayKey) return;
    this.lastActiveDayKeys.set(reason, dayKey);
    this.trackEvent("sand.app.active", { reason });
  }

  canRecordEvents(): boolean {
    return this.state.kind === "deferred" || this.state.kind === "active";
  }

  async flush(timeoutMs = 2_500): Promise<void> {
    if (this.state.kind !== "active") return;
    try {
      await this.state.buffer.flush(timeoutMs);
    } catch {
      // The artifact isolates flush failures at the product-analytics boundary.
    }
  }

  async dispose(): Promise<void> {
    this.teardownGateSubscription();
    await this.flush();
  }

  private enrich(props: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    return { ...this.baseProps, ...props };
  }
}
