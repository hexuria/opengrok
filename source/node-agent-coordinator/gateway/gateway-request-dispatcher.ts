import { COORDINATOR_UNKNOWN_METHOD, type CoordinatorReplyOutcome } from "../../shared/rpc/coordinator-port.js";
import { isCoordinatorMethod, validateCoordinatorReply } from "../../shared/rpc/coordinator.js";
import { SandGatewayCommandError } from "./gateway-errors.js";
import { SandGatewayUnreachableError } from "./gateway-reachability.js";

export const GATEWAY_COMMAND_FAILED = "gateway-command-failed";
export const GATEWAY_UNREACHABLE = "gateway-unreachable";
export const GATEWAY_TRANSPORT_FAILED = "gateway-transport-failed";

export function failureFor(error: unknown): { code: string; message: string; transportKind?: string } {
  if (error instanceof SandGatewayCommandError) return { code: GATEWAY_COMMAND_FAILED, message: error.message };
  if (error instanceof SandGatewayUnreachableError) return { code: GATEWAY_UNREACHABLE, message: error.message, transportKind: error.kind };
  return { code: GATEWAY_TRANSPORT_FAILED, message: error instanceof Error ? error.message : String(error) };
}

export interface GatewayCommandClient {
  dispatchCommand(method: string, args: unknown, options: { signal?: AbortSignal }): Promise<unknown>;
}

let lastReported = "";

function reportGatewayFailure(method: string, failure: { code: string; message: string }): void {
  // One line per distinct failure: a refused gateway fails on every poll, and a
  // log that repeats itself hides the moment things changed.
  const line = `${method} ${failure.code} ${failure.message}`;
  if (line === lastReported) return;
  lastReported = line;
  try { process.stderr.write(`[sand:gateway] ${line}\n`); } catch { /* nothing to be done */ }
}

export function createGatewayRequestDispatch(client: GatewayCommandClient, serves: (method: string) => boolean = isCoordinatorMethod) {
  return async (method: string, args: unknown, signal?: AbortSignal): Promise<CoordinatorReplyOutcome> => {
    if (!serves(method)) return { status: "failed", failure: { code: COORDINATOR_UNKNOWN_METHOD, message: `no coordinator method named ${method}` } };
    try {
      const value = validateCoordinatorReply(method, await client.dispatchCommand(method, args, { ...(signal === undefined ? {} : { signal }) }));
      return { status: "ok", value };
    } catch (error) {
      const failure = failureFor(error);
      reportGatewayFailure(method, failure);
      return { status: "failed", failure };
    }
  };
}
