import type { Clock } from "../../internal/scheduling.js";

export const SSE_ECHO_STAGE = "echo-coordinator-sse";
export const MAX_IN_FLIGHT_TRANSPORT_REPORTS = 64;
export const PENDING_SEND_ECHO_MAX = 64;
export const PENDING_SEND_ECHO_TTL_MS = 120_000;

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

export function createTransportStageRecorder(options: { readonly clock: Clock; readonly egress: TransportStageEgress }) {
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
  const pendingEchoes = new Map<string, { traceparent: string; armedAtMonotonicMs: number }>();
  const armEcho = (key: { accountSlot: string; clientNonce: string }, traceparent: string) => {
    const nowMonotonicMs = clock.monotonicNow();
    for (const [armedKey, pending] of pendingEchoes) {
      if (nowMonotonicMs - pending.armedAtMonotonicMs > PENDING_SEND_ECHO_TTL_MS) pendingEchoes.delete(armedKey);
    }
    if (pendingEchoes.size >= PENDING_SEND_ECHO_MAX) {
      const oldest = pendingEchoes.keys().next().value;
      if (oldest !== undefined) pendingEchoes.delete(oldest);
    }
    pendingEchoes.set(sendKeyOf(key), { traceparent, armedAtMonotonicMs: nowMonotonicMs });
  };
  return {
    beginSend(identity: TransportIdentity) {
      const { accountSlot, clientNonce, traceparent } = identity;
      if (clientNonce == null || clientNonce === "") return INERT_TRACE;
      const sampledTraceparent = traceparent == null || traceparent === "" ? null : traceparent;
      if (sampledTraceparent != null) armEcho({ accountSlot, clientNonce }, sampledTraceparent);
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
      forwardStage({ accountSlot: key.accountSlot, clientNonce: key.clientNonce, stage: SSE_ECHO_STAGE, attempt: 0, traceparent: pending.traceparent, startEpochMs: clock.now(), durationMs: 0, isError: false });
    },
    recordTransportStage: forwardStage,
    recordGatewayCommandSpan(report: unknown) { forward(() => egress.reportGatewayCommandSpan(report)); },
    recordGatewayReachability(report: unknown) { forward(() => egress.reportGatewayReachability(report)); },
    recordGatewayDnsDiagnostic(report: unknown) { forward(() => egress.reportGatewayDnsDiagnostic(report)); }
  };
}

