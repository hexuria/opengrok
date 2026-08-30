import { createDeadlinePolicy, realClock, type DeadlinePolicy } from "../../internal/scheduling.js";
import { sessionReportToTelemetry, type SessionSignoutCause } from "./session-funnel-telemetry.js";

export const STRUCTURED_LOG_SUBMIT_DEADLINE_MS = 15_000;
export const DESKTOP_SESSION_EVENT = "sand.desktop.session";
export const SAND_LOG_KEY = "sand";
const settlementShipDeadline = createDeadlinePolicy(realClock, { name: "cursor-auth-session-settlement-ship", timeoutMs: STRUCTURED_LOG_SUBMIT_DEADLINE_MS });

export type SessionSettlement =
  | { readonly kind: "signed_out"; readonly cause: SessionSignoutCause; readonly durable: boolean; readonly accessToken: string }
  | { readonly kind: "keychain_unavailable"; readonly accessToken: string };
export interface StructuredSessionLog {
  readonly level: "INFO" | "WARN";
  readonly message: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly timestamp: bigint;
  readonly key: string;
}

export function settlementReport(settlement: SessionSettlement) {
  return settlement.kind === "signed_out"
    ? { phase: "signed_out" as const, cause: settlement.cause, durable: settlement.durable }
    : { phase: "keychain_unavailable" as const };
}

export interface SessionSettlementShipperOptions {
  readonly getMachineId: () => Promise<string>;
  readonly getClientVersion: () => string;
  readonly submitLogs: (args: { readonly accessToken: string; readonly getMachineId: () => Promise<string>; readonly logs: readonly StructuredSessionLog[]; readonly signal: AbortSignal }) => Promise<void>;
  readonly onShipFailure: (error: unknown) => void;
  readonly now?: () => number;
  readonly appVersion?: string;
  readonly arch?: string;
  readonly platform?: string;
  readonly deadline?: DeadlinePolicy;
}

export function createSessionSettlementShipper(options: SessionSettlementShipperOptions): (settlement: SessionSettlement) => void {
  return (settlement) => { void shipSettlement(options, settlement).catch(options.onShipFailure); };
}

export async function shipSettlement(options: SessionSettlementShipperOptions, settlement: SessionSettlement): Promise<void> {
  const projection = sessionReportToTelemetry(settlementReport(settlement));
  const machineId = await options.getMachineId();
  const entry: StructuredSessionLog = {
    level: projection.level === "warn" ? "WARN" : "INFO",
    message: DESKTOP_SESSION_EVENT,
    metadata: {
      client: "sand",
      "client.type": "sand",
      "client.machine_id": machineId,
      client_version: options.getClientVersion(),
      app_version: options.appVersion ?? "0.18.0",
      arch: options.arch ?? process.arch,
      platform: options.platform ?? process.platform,
      ...projection.metadata,
    },
    timestamp: BigInt((options.now ?? Date.now)()),
    key: SAND_LOG_KEY,
  };
  await (options.deadline ?? settlementShipDeadline).run((signal) => options.submitLogs({ accessToken: settlement.accessToken, getMachineId: options.getMachineId, logs: [entry], signal }));
}
