import {
  COORDINATOR_PROTOCOL_VERSION,
  parseCoordinatorFrame,
  type CoordinatorFrame,
  type CoordinatorReplyOutcome
} from "../shared/rpc/coordinator-port.js";

export class ControlPortCallError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ControlPortCallError";
  }
}

export interface CoordinatorEndpoint {
  post(frame: CoordinatorFrame): void;
  close(): void;
}

export type ControlPortSettlement =
  | { readonly outcome: "shutdown-requested" | "port-closed" }
  | { readonly outcome: "protocol-breach"; readonly detail: string };

export function createControlPortClient(endpoint: CoordinatorEndpoint) {
  let phase: "serving" | "settled" = "serving";
  let readyObserved = false;
  let nextRequestId = 0;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  const { promise: settled, resolve: resolveSettled } = Promise.withResolvers<ControlPortSettlement>();

  const settle = (settlement: ControlPortSettlement) => {
    if (phase === "settled") return;
    phase = "settled";
    for (const call of pending.values()) call.reject(new Error(`control port settled (${settlement.outcome}) before the reply`));
    pending.clear();
    endpoint.close();
    resolveSettled(settlement);
  };

  const breach = (detail: string) => {
    if (phase === "settled") return;
    endpoint.post({ kind: "lifecycle", phase: "shutdown", reason: "protocol-error", detail });
    settle({ outcome: "protocol-breach", detail });
  };

  endpoint.post({ kind: "lifecycle", phase: "hello", protocolVersion: COORDINATOR_PROTOCOL_VERSION });

  const call = (method: string, args: unknown): Promise<unknown> => {
    if (phase === "settled") return Promise.reject(new Error(`control port settled before ${method} was posted`));
    nextRequestId += 1;
    const requestId = `c-${nextRequestId}`;
    const outcome = new Promise<unknown>((resolve, reject) => pending.set(requestId, { resolve, reject }));
    endpoint.post({ kind: "request", requestId, method, args });
    return outcome;
  };

  const commands = new Proxy({} as Record<string, (args: unknown) => Promise<unknown>>, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      return (args: unknown) => call(property, args);
    }
  });

  const settleReply = (requestId: string, outcome: CoordinatorReplyOutcome) => {
    const waiting = pending.get(requestId);
    if (waiting == null) return;
    pending.delete(requestId);
    if (outcome.status === "ok") waiting.resolve(outcome.value);
    else waiting.reject(new ControlPortCallError(outcome.failure.code, outcome.failure.message));
  };

  const handleFrame = (frame: CoordinatorFrame) => {
    if (frame.kind === "lifecycle" && frame.phase === "shutdown") {
      settle(frame.reason === "requested"
        ? { outcome: "shutdown-requested" }
        : { outcome: "protocol-breach", detail: frame.detail ?? "peer reported a breach" });
      return;
    }
    if (frame.kind === "lifecycle" && frame.phase === "ready") {
      if (readyObserved) { breach("ready repeated on a live control session"); return; }
      if (frame.protocolVersion !== COORDINATOR_PROTOCOL_VERSION) {
        breach(`ready.protocolVersion ${frame.protocolVersion} is not the supported ${COORDINATOR_PROTOCOL_VERSION}`);
        return;
      }
      readyObserved = true;
      return;
    }
    if (frame.kind === "reply") { settleReply(frame.requestId, frame.outcome); return; }
    breach(`main posted a client-direction ${frame.kind} frame`);
  };

  return {
    commands,
    postEvent(family: string, payload: unknown): void {
      if (phase !== "settled") endpoint.post({ kind: "event", family, payload });
    },
    handleMessage(value: unknown): void {
      if (phase === "settled") return;
      const intake = parseCoordinatorFrame(value);
      if (!intake.accepted) { breach(intake.rejection.detail); return; }
      handleFrame(intake.frame);
    },
    handlePortClosed(): void { settle({ outcome: "port-closed" }); },
    shutdown(): void {
      if (phase === "settled") return;
      endpoint.post({ kind: "lifecycle", phase: "shutdown", reason: "requested", detail: null });
      settle({ outcome: "shutdown-requested" });
    },
    settled
  };
}

