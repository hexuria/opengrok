export const EDGE_UNKNOWN_METHOD = "edge/unknown-method";
export const EDGE_HANDLER_FAILED = "edge/handler-failed";

export interface RpcMethodTable {
  readonly [method: string]: { readonly args: "none" | "object" };
}

export interface RpcEdgeTransport {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

export interface EdgeReplyFailure {
  readonly code: string;
  readonly detail: string;
}

export class EdgeCallFailure extends Error {
  override readonly name = "EdgeCallFailure";
  readonly code: string;
  readonly detail: string;

  constructor(failure: EdgeReplyFailure) {
    super(`${failure.code}: ${failure.detail}`);
    this.code = failure.code;
    this.detail = failure.detail;
  }
}

function isEdgeReplyEnvelope(value: unknown): value is
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly failure: EdgeReplyFailure } {
  return typeof value === "object" && value != null && "ok" in value && typeof value.ok === "boolean";
}

export function methodChannel(edge: string, method: string): string {
  return `sand-rpc:${edge}:m:${method}`;
}

export function eventChannel(edge: string, event: string): string {
  return `sand-rpc:${edge}:e:${event}`;
}

/** Artifact-parity renderer half of dune's RPC edge protocol. */
export function bridgeRpcEdge(
  edge: string,
  table: RpcMethodTable,
  transport: RpcEdgeTransport,
  hasEvents = false,
): Record<string, any> {
  const bridge: Record<string, any> = {};
  const callMethod = async (method: string, payload: unknown): Promise<unknown> => {
    let reply: unknown;
    try {
      reply = await transport.invoke(methodChannel(edge, method), payload);
    } catch (error) {
      throw new EdgeCallFailure({
        code: EDGE_UNKNOWN_METHOD,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (!isEdgeReplyEnvelope(reply)) {
      throw new EdgeCallFailure({ code: EDGE_HANDLER_FAILED, detail: "The edge replied outside its envelope." });
    }
    if (reply.ok) return reply.value;
    throw new EdgeCallFailure(reply.failure);
  };
  for (const [method, row] of Object.entries(table)) {
    bridge[method] = row.args === "none"
      ? () => callMethod(method, {})
      : (args: unknown) => callMethod(method, args);
  }
  if (hasEvents) {
    bridge.subscribe = (handlers: Record<string, ((payload: unknown) => void) | null | undefined>): (() => void) => {
      const unsubscribes: Array<() => void> = [];
      for (const [event, listener] of Object.entries(handlers)) {
        if (listener != null) unsubscribes.push(transport.on(eventChannel(edge, event), listener));
      }
      return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
    };
  }
  return bridge;
}
