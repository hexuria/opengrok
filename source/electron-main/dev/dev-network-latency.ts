export const SIMULATED_GATEWAY_LATENCY_MAX_MS = 10_000; let simulatedLatencyMs = 0;
export function getSimulatedGatewayLatencyMs(): number { return simulatedLatencyMs; }
export function setSimulatedGatewayLatencyMs(ms: number): number { simulatedLatencyMs = Number.isFinite(ms) && ms > 0 ? Math.min(Math.floor(ms), SIMULATED_GATEWAY_LATENCY_MAX_MS) : 0; return simulatedLatencyMs; }
