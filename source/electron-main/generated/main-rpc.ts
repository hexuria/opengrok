import { EdgeCallFailure } from "../main-edge.js";
import {
  MAIN_METHOD_TABLE,
  MAIN_RPC_CONTRACT_NAME,
  MAIN_RPC_EVENT_FAMILY,
} from "../../shared/rpc/main.js";

export const EDGE_UNTRUSTED_SENDER = "edge/untrusted-sender";
export const EDGE_HANDLER_FAILED = "edge/handler-failed";

export interface RpcContract {
  readonly edge: string;
  readonly hasEvents: boolean;
}

export function declareRpcContract(edge: string, ...events: readonly string[]): RpcContract {
  return { edge, hasEvents: events.length > 0 };
}

export const mainRpcContract = declareRpcContract(
  MAIN_RPC_CONTRACT_NAME,
  MAIN_RPC_EVENT_FAMILY,
);

export { MAIN_METHOD_TABLE };

export function methodChannel(edge: string, method: string): string {
  return `sand-rpc:${edge}:m:${method}`;
}

export function eventChannel(edge: string, event: string): string {
  return `sand-rpc:${edge}:e:${event}`;
}

export class EdgeTrustPolicyMissingError extends Error {
  constructor(claim: { readonly edge: string; readonly method: string; readonly trust: string }) {
    super(`serveEdge(${claim.edge}): "${claim.method}" names undeclared trust policy "${claim.trust}".`);
    this.name = "EdgeTrustPolicyMissingError";
  }
}

interface EdgeSender {}
interface EdgeMethodHandler {
  readonly trust: string;
  readonly run: (payload: unknown, sender: EdgeSender) => unknown;
}
interface EdgeTrustPolicy {
  readonly kind: string;
  readonly test: (sender: EdgeSender) => boolean;
  readonly denial: string;
}
interface EdgeTransport {
  handle(channel: string, run: (sender: EdgeSender, payload: unknown) => unknown): void;
  removeHandler(channel: string): void;
  broadcast(channel: string, payload: unknown): void;
}

export interface ServeEdgeOptions {
  readonly handlers: Readonly<Record<string, EdgeMethodHandler>>;
  readonly trust: Readonly<Record<string, EdgeTrustPolicy>>;
  readonly transport: EdgeTransport;
  readonly report?: (failure: { readonly method: string; readonly trust: string }) => void;
}

/** Exact dune/src/internal/rpc/edge.ts implementation emitted at main.cjs:494629. */
export function serveEdge(
  contract: RpcContract,
  table: Readonly<Record<string, unknown>>,
  options: ServeEdgeOptions,
): { readonly emit: (event: string, payload: unknown) => void; readonly dispose: () => void } {
  const channels: string[] = [];
  for (const method of Object.keys(table)) {
    const handler = options.handlers[method];
    if (handler == null) {
      throw new EdgeTrustPolicyMissingError({
        edge: contract.edge,
        method,
        trust: "<missing handler>",
      });
    }
    const policy = options.trust[handler.trust];
    if (policy == null) {
      throw new EdgeTrustPolicyMissingError({ edge: contract.edge, method, trust: handler.trust });
    }
    const channel = methodChannel(contract.edge, method);
    channels.push(channel);
    options.transport.handle(channel, async (sender, payload) => {
      if (policy.kind === "require" && !policy.test(sender)) {
        options.report?.({ method, trust: handler.trust });
        return {
          ok: false,
          failure: { code: EDGE_UNTRUSTED_SENDER, detail: policy.denial },
        };
      }
      try {
        return { ok: true, value: await handler.run(payload, sender) };
      } catch (error) {
        if (error instanceof EdgeCallFailure) {
          return { ok: false, failure: { code: error.code, detail: error.detail } };
        }
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, failure: { code: EDGE_HANDLER_FAILED, detail } };
      }
    });
  }
  let disposed = false;
  return {
    emit(event, payload): void {
      options.transport.broadcast(eventChannel(contract.edge, event), payload);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const channel of channels) options.transport.removeHandler(channel);
    },
  };
}
