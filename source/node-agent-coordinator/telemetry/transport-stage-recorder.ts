import type { Clock } from "../../internal/scheduling.js";

export const SSE_ECHO_STAGE = "echo-coordinator-sse";
/** Reported once for a send whose user-message echo never came back over the stream. This is the
 *  silent failure: the POST was accepted, the server ran the turn, and the page shows nothing. */
export const SSE_ECHO_MISSING_STAGE = "echo-coordinator-sse-missing";
export const MAX_IN_FLIGHT_TRANSPORT_REPORTS = 64;
export const PENDING_SEND_ECHO_MAX = 64;
export const PENDING_SEND_ECHO_TTL_MS = 120_000;
/** How long after a send its echo may still arrive before the stream is judged dead. The server
 *  echoes the user message within a second of accepting it; 30s is many pings' worth of margin. */
export const SSE_ECHO_MISSING_AFTER_MS = 30_000;
export const SSE_ECHO_SWEEP_INTERVAL_MS = 5_000;

export interface TransportIdentity {
  readonly accountSlot: string;
  readonly clientNonce?: string | null;
  readonly traceparent?: string | null;
}

export interface TransportStageReport {
  readonly accountSlot: string;
  readonly clientNonce: string;
  readonly stage: string;
  readonly attempt: number;
  readonly traceparent: string | null;
  readonly startEpochMs: number;
  readonly durationMs: number;
  readonly isError: boolean;
}

export interface TransportStageEgress {
  reportTransportStage(report: TransportStageReport): Promise<unknown>;
  reportGatewayCommandSpan(report: unknown): Promise<unknown>;
  reportGatewayReachability(report: unknown): Promise<unknown>;
  reportGatewayDnsDiagnostic(report: unknown): Promise<unknown>;
}

const INERT_STAGE = { complete() {}, fail() {} };
const INERT_TRACE = { beginStage: () => INERT_STAGE, markStage() {} };

function sendKeyOf(key: { readonly accountSlot: string; readonly clientNonce: string }): string {
  return `${key.accountSlot}\0${key.clientNonce}`;
}

export function createTransportStageRecorder(options: {
  readonly clock: Clock;
  readonly egress: TransportStageEgress;
  /** Called once per send whose echo did not arrive within `SSE_ECHO_MISSING_AFTER_MS`. */
  readonly onEchoMissing?: (key: { readonly accountSlot: string; readonly clientNonce: string }) => void;
  /** Interval of the background sweep; `null` disables it (tests call `sweepEchoes` directly). */
  readonly sweepIntervalMs?: number | null;
}) {
  const { clock, egress } = options;
  let inFlightReports = 0;
  const forward = (dispatch: () => Promise<unknown>) => {
    if (inFlightReports >= MAX_IN_FLIGHT_TRANSPORT_REPORTS) return;
    inFlightReports += 1;
    const settle = () => { inFlightReports -= 1; };
    try { void dispatch().then(settle, settle); }
    catch { settle(); }
  };
  const forwardStage = (report: TransportStageReport) => forward(() => egress.reportTransportStage(report));
  const pendingEchoes = new Map<string, { accountSlot: string; clientNonce: string; traceparent: string | null; armedAtMonotonicMs: number; reportedMissing: boolean }>();
  // A send whose echo is overdue is reported ONCE as missing and kept armed until the TTL, so a
  // late echo still closes it (and says how late) rather than being counted as a fresh event.
  const sweepEchoes = () => {
    const nowMonotonicMs = clock.monotonicNow();
    for (const [armedKey, pending] of pendingEchoes) {
      const age = nowMonotonicMs - pending.armedAtMonotonicMs;
      if (age > PENDING_SEND_ECHO_TTL_MS) { pendingEchoes.delete(armedKey); continue; }
      if (pending.reportedMissing || age < SSE_ECHO_MISSING_AFTER_MS) continue;
      pending.reportedMissing = true;
      forwardStage({ accountSlot: pending.accountSlot, clientNonce: pending.clientNonce, stage: SSE_ECHO_MISSING_STAGE, attempt: 0, traceparent: pending.traceparent, startEpochMs: clock.now(), durationMs: age, isError: true });
      try { options.onEchoMissing?.({ accountSlot: pending.accountSlot, clientNonce: pending.clientNonce }); } catch { /* a listener must not break the recorder */ }
    }
  };
  const sweepIntervalMs = options.sweepIntervalMs === undefined ? SSE_ECHO_SWEEP_INTERVAL_MS : options.sweepIntervalMs;
  const sweeper = sweepIntervalMs == null ? undefined : setInterval(sweepEchoes, sweepIntervalMs);
  sweeper?.unref?.();
  const armEcho = (key: { accountSlot: string; clientNonce: string }, traceparent: string | null) => {
    const nowMonotonicMs = clock.monotonicNow();
    for (const [armedKey, pending] of pendingEchoes) {
      if (nowMonotonicMs - pending.armedAtMonotonicMs > PENDING_SEND_ECHO_TTL_MS) pendingEchoes.delete(armedKey);
    }
    if (pendingEchoes.size >= PENDING_SEND_ECHO_MAX) {
      const oldest = pendingEchoes.keys().next().value;
      if (oldest !== undefined) pendingEchoes.delete(oldest);
    }
    pendingEchoes.set(sendKeyOf(key), { accountSlot: key.accountSlot, clientNonce: key.clientNonce, traceparent, armedAtMonotonicMs: nowMonotonicMs, reportedMissing: false });
  };
  return {
    beginSend(identity: TransportIdentity) {
      const { accountSlot, clientNonce, traceparent } = identity;
      if (clientNonce == null || clientNonce === "") return INERT_TRACE;
      const sampledTraceparent = traceparent == null || traceparent === "" ? null : traceparent;
      // Every send is armed, sampled or not: the missing-echo detector is a liveness check on the
      // stream, and a stream that is dead for an unsampled send is just as dead.
      armEcho({ accountSlot, clientNonce }, sampledTraceparent);
      return {
        beginStage(stage: string, attempt: number) {
          const startEpochMs = clock.now();
          const startMonotonicMs = clock.monotonicNow();
          let settled = false;
          const settle = (isError: boolean) => {
            if (settled) return;
            settled = true;
            forwardStage({ accountSlot, clientNonce, stage, attempt, traceparent: sampledTraceparent, startEpochMs, durationMs: clock.monotonicNow() - startMonotonicMs, isError });
          };
          return { complete: () => settle(false), fail: () => settle(true) };
        },
        markStage(stage: string, attempt: number) {
          forwardStage({ accountSlot, clientNonce, stage, attempt, traceparent: sampledTraceparent, startEpochMs: clock.now(), durationMs: 0, isError: false });
        }
      };
    },
    recordSendEcho(key: { readonly accountSlot: string; readonly clientNonce: string }) {
      const armedKey = sendKeyOf(key);
      const pending = pendingEchoes.get(armedKey);
      if (pending == null) return;
      pendingEchoes.delete(armedKey);
      forwardStage({ accountSlot: key.accountSlot, clientNonce: key.clientNonce, stage: SSE_ECHO_STAGE, attempt: pending.reportedMissing ? 1 : 0, traceparent: pending.traceparent, startEpochMs: clock.now(), durationMs: clock.monotonicNow() - pending.armedAtMonotonicMs, isError: false });
    },
    recordTransportStage: forwardStage,
    sweepEchoes,
    pendingEchoCount: () => pendingEchoes.size,
    dispose() { if (sweeper !== undefined) clearInterval(sweeper); },
    recordGatewayCommandSpan(report: unknown) { forward(() => egress.reportGatewayCommandSpan(report)); },
    recordGatewayReachability(report: unknown) { forward(() => egress.reportGatewayReachability(report)); },
    recordGatewayDnsDiagnostic(report: unknown) { forward(() => egress.reportGatewayDnsDiagnostic(report)); }
  };
}

