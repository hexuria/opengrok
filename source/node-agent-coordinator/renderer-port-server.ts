import {
  COORDINATOR_CANCELLED,
  COORDINATOR_PROTOCOL_VERSION,
  COORDINATOR_UNKNOWN_METHOD,
  parseCoordinatorFrame,
  type CoordinatorFrame,
  type CoordinatorReplyOutcome
} from "../shared/rpc/coordinator-port.js";

export interface RendererPort {
  post(frame: CoordinatorFrame): void;
  close(): void;
}

export type RendererPortSettlement =
  | { readonly outcome: "shutdown-requested" | "port-closed" }
  | { readonly outcome: "protocol-breach"; readonly detail: string };

export interface RendererPortServerOptions {
  readonly dispatchRequest?: (method: string, args: unknown, signal: AbortSignal) => Promise<CoordinatorReplyOutcome>;
  readonly onServing?: () => void;
}

export function createRendererPortServer(port: RendererPort, options: RendererPortServerOptions = {}) {
  let phase: "awaiting-hello" | "serving" | "settled" = "awaiting-hello";
  const { promise: settled, resolve: resolveSettled } = Promise.withResolvers<RendererPortSettlement>();
  const inFlight = new Map<string, AbortController>();

  const settle = (settlement: RendererPortSettlement) => {
    if (phase === "settled") return;
    phase = "settled";
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
    port.close();
    resolveSettled(settlement);
  };
  const breach = (detail: string) => {
    if (phase === "settled") return;
    port.post({ kind: "lifecycle", phase: "shutdown", reason: "protocol-error", detail });
    settle({ outcome: "protocol-breach", detail });
  };
  const reply = (requestId: string, outcome: CoordinatorReplyOutcome) => port.post({ kind: "reply", requestId, outcome });
  const dispatchRequest = (requestId: string, method: string, args: unknown) => {
    const dispatch = options.dispatchRequest;
    if (dispatch == null) {
      reply(requestId, { status: "failed", failure: { code: COORDINATOR_UNKNOWN_METHOD, message: "no method table serves this session yet" } });
      return;
    }
    const controller = new AbortController();
    inFlight.set(requestId, controller);
    void dispatch(method, args, controller.signal).then(
      (outcome) => {
        if (phase !== "serving" || inFlight.get(requestId) !== controller) return;
        inFlight.delete(requestId);
        reply(requestId, outcome);
      },
      () => breach(`request ${requestId} dispatch rejected instead of settling`)
    );
  };
  const handleFrame = (frame: CoordinatorFrame) => {
    if (frame.kind === "lifecycle" && frame.phase === "shutdown") { settle({ outcome: "shutdown-requested" }); return; }
    if (frame.kind === "reply" || frame.kind === "event") { breach(`client posted a server-direction ${frame.kind} frame`); return; }
    if (frame.kind === "lifecycle" && frame.phase === "ready") { breach("client posted a server-direction ready frame"); return; }
    if (phase === "awaiting-hello") {
      if (frame.kind !== "lifecycle") { breach(`${frame.kind} frame before hello`); return; }
      if (frame.protocolVersion !== COORDINATOR_PROTOCOL_VERSION) {
        breach(`hello.protocolVersion ${frame.protocolVersion} is not the supported ${COORDINATOR_PROTOCOL_VERSION}`);
        return;
      }
      phase = "serving";
      port.post({ kind: "lifecycle", phase: "ready", protocolVersion: COORDINATOR_PROTOCOL_VERSION });
      options.onServing?.();
      return;
    }
    if (frame.kind === "lifecycle") { breach("hello repeated on a live session"); return; }
    if (frame.kind === "request") {
      if (inFlight.has(frame.requestId)) { breach(`request.requestId ${frame.requestId} reused while in flight`); return; }
      dispatchRequest(frame.requestId, frame.method, frame.args);
      return;
    }
    const controller = inFlight.get(frame.requestId);
    if (controller == null) return;
    inFlight.delete(frame.requestId);
    controller.abort();
    reply(frame.requestId, { status: "failed", failure: { code: COORDINATOR_CANCELLED, message: "request cancelled" } });
  };
  return {
    handleMessage(value: unknown): void {
      if (phase === "settled") return;
      const intake = parseCoordinatorFrame(value);
      if (!intake.accepted) { breach(intake.rejection.detail); return; }
      handleFrame(intake.frame);
    },
    handlePortClosed(): void { settle({ outcome: "port-closed" }); },
    postEvent(family: string, payload: unknown): void {
      if (phase === "serving") port.post({ kind: "event", family, payload });
    },
    settled
  };
}

