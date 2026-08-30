import { createDeadlinePolicy, realClock, type Clock, type DeadlinePolicy } from "../../internal/scheduling.js";
import { classifyBaseUrlKind, classifyGatewayFetchFailure, outcomeForHttpStatus } from "./gateway-reachability.js";

export const HEALTH_TIMEOUT_MS = 1_500;
export const HEALTH_PROBE_TTL_MS = 5_000;
export const DISABLE_HEALTH_TTL_ENV = "SAND_DISABLE_GATEWAY_HEALTH_TTL";
export const DISABLE_STREAM_LIVENESS_ENV = "SAND_DISABLE_GATEWAY_STREAM_LIVENESS";

export interface CoordinatorHostSupervisorTiming {
  clock: Clock;
  healthProbeDeadline: DeadlinePolicy;
}

export function createCoordinatorHostSupervisorTiming(): CoordinatorHostSupervisorTiming {
  return { clock: realClock, healthProbeDeadline: createDeadlinePolicy(realClock, { name: "gateway-health-probe", timeoutMs: HEALTH_TIMEOUT_MS }) };
}

export class GatewayConnectResolveAbandonedError extends Error {
  constructor() {
    super("the gateway connection resolve was abandoned before it answered");
    this.name = "GatewayConnectResolveAbandonedError";
  }
}

export interface GatewayConnection {
  baseUrl: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface HealthReachabilityReport {
  outcome: string;
  method: "health";
  latencyMs: number;
  baseUrlKind: "unknown" | "loopback" | "pod_proxy";
  httpStatus?: number;
  causeSummary?: string;
}

export async function fetchHealth(
  timing: CoordinatorHostSupervisorTiming,
  baseUrl: string,
  headers?: Record<string, string>,
  onReachability?: (report: HealthReachabilityReport, baseUrl: string) => void
): Promise<Record<string, unknown> | null> {
  const startMonotonicMs = timing.clock.monotonicNow();
  const report = (value: HealthReachabilityReport) => { try { onReachability?.(value, baseUrl); } catch { /* best effort */ } };
  try {
    const response = await timing.healthProbeDeadline.run((signal) => fetch(`${baseUrl}/health`, { signal, ...(headers == null ? {} : { headers: { ...headers } }) }));
    if (!response.ok) {
      report({ outcome: outcomeForHttpStatus(response.status) ?? "network", method: "health", latencyMs: timing.clock.monotonicNow() - startMonotonicMs, baseUrlKind: classifyBaseUrlKind(baseUrl), httpStatus: response.status });
      return null;
    }
    const health = await response.json() as Record<string, unknown>;
    return health.ok === true ? health : null;
  } catch (error) {
    const { outcome, causeSummary } = classifyGatewayFetchFailure(error);
    report({ outcome, method: "health", latencyMs: timing.clock.monotonicNow() - startMonotonicMs, baseUrlKind: classifyBaseUrlKind(baseUrl), causeSummary });
    return null;
  }
}

interface ConnectionAttempt {
  healthEpoch: number;
  promise: Promise<GatewayConnection>;
  state: "pending" | "settled";
  isRetired: boolean;
  hasWaiter: boolean;
  retirement: Promise<never>;
  retire(): void;
}

export interface SandHostSupervisorOptions {
  timing: CoordinatorHostSupervisorTiming;
  resolveGatewayConnection(): Promise<GatewayConnection>;
  isTransportLive?(): boolean;
  onReachability?(report: HealthReachabilityReport, baseUrl: string): void;
}

export class SandHostSupervisor {
  private connection?: GatewayConnection;
  private lastHealthyAtMs = Number.NEGATIVE_INFINITY;
  private healthEpoch = 0;
  private latestConnectionAttempt?: ConnectionAttempt;
  private readonly healthTtlDisabled: boolean;
  private readonly streamLivenessDisabled: boolean;

  constructor(private readonly options: SandHostSupervisorOptions) {
    this.healthTtlDisabled = process.env[DISABLE_HEALTH_TTL_ENV] === "1";
    this.streamLivenessDisabled = process.env[DISABLE_STREAM_LIVENESS_ENV] === "1";
  }

  private getOrStartConnectionAttempt(healthEpoch: number): ConnectionAttempt {
    const current = this.latestConnectionAttempt;
    if (current != null && current.healthEpoch === healthEpoch && current.state === "pending" && !current.isRetired) return current;
    let release = () => {};
    const retirement = new Promise<never>((_resolve, reject) => { release = () => reject(new GatewayConnectResolveAbandonedError()); });
    void retirement.catch(() => {});
    const attempt: ConnectionAttempt = {
      healthEpoch,
      promise: this.options.resolveGatewayConnection(),
      state: "pending",
      isRetired: false,
      hasWaiter: false,
      retirement,
      retire: () => { if (attempt.isRetired) return; attempt.isRetired = true; release(); }
    };
    this.latestConnectionAttempt = attempt;
    const markSettled = () => { attempt.state = "settled"; };
    void attempt.promise.then(markSettled, markSettled);
    return attempt;
  }

  private getLatestAttemptForCurrentEpoch(): ConnectionAttempt {
    const current = this.latestConnectionAttempt;
    return current != null && current.healthEpoch === this.healthEpoch && !current.isRetired ? current : this.getOrStartConnectionAttempt(this.healthEpoch);
  }

  private async awaitAttempt(attempt: ConnectionAttempt, signal?: AbortSignal): Promise<GatewayConnection> {
    if (signal == null) { attempt.hasWaiter = true; return await Promise.race([attempt.promise, attempt.retirement]); }
    if (signal.aborted) { if (!attempt.hasWaiter) attempt.retire(); throw new GatewayConnectResolveAbandonedError(); }
    attempt.hasWaiter = true;
    const onAbort = () => attempt.retire();
    signal.addEventListener("abort", onAbort, { once: true });
    try { return await Promise.race([attempt.promise, attempt.retirement]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  invalidateHealthCache(): void {
    this.healthEpoch += 1;
    this.lastHealthyAtMs = Number.NEGATIVE_INFINITY;
    this.latestConnectionAttempt?.retire();
  }

  async ensureConnection(signal?: AbortSignal): Promise<GatewayConnection> {
    const cached = this.connection;
    if (cached != null) {
      if (!this.streamLivenessDisabled && this.options.isTransportLive?.() === true) return cached;
      if (!this.healthTtlDisabled && this.options.timing.clock.monotonicNow() - this.lastHealthyAtMs < HEALTH_PROBE_TTL_MS) return cached;
      const epochAtProbe = this.healthEpoch;
      if (await fetchHealth(this.options.timing, cached.baseUrl, cached.headers, this.options.onReachability) != null) {
        if (epochAtProbe === this.healthEpoch) this.lastHealthyAtMs = this.options.timing.clock.monotonicNow();
        return cached;
      }
    }
    const epochAtConnect = this.healthEpoch;
    let attempt = this.getOrStartConnectionAttempt(epochAtConnect);
    for (;;) {
      try {
        const connection = await this.awaitAttempt(attempt, signal);
        const supersedingAttempt = this.latestConnectionAttempt;
        if (attempt.healthEpoch !== this.healthEpoch) { attempt = this.getLatestAttemptForCurrentEpoch(); continue; }
        if (supersedingAttempt !== attempt) {
          if (supersedingAttempt == null) throw new Error("latest gateway connection attempt is missing");
          attempt = supersedingAttempt;
          continue;
        }
        this.connection = connection;
        this.lastHealthyAtMs = Number.NEGATIVE_INFINITY;
        return connection;
      } catch (error) {
        const supersedingAttempt = this.latestConnectionAttempt;
        if (attempt.healthEpoch !== this.healthEpoch) { attempt = this.getLatestAttemptForCurrentEpoch(); continue; }
        if (supersedingAttempt === attempt || supersedingAttempt == null) throw error;
        attempt = supersedingAttempt;
      }
    }
  }
}
