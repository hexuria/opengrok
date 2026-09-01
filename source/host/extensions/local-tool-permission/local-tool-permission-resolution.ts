import { type SandLocalToolPermissionController, type SandLocalToolResolution } from "./local-tool-permission-controller.js";

export class SandLocalToolPermissionResolutionError extends Error {}
export function isSandLocalToolPermissionResolution(value: unknown): value is SandLocalToolResolution { return value === "allow-once" || value === "allow-session" || value === "deny" || value === "always" || value === "never"; }

export interface LocalToolPermissionResolutionArgs { readonly agentId: string; readonly entryId: string; readonly requestId: string; readonly resolution: unknown; }
export interface LocalToolPermissionTranscript { readonly widgetResponses: { settleStaleLocalToolPermissionCard(args: { readonly agentId: string; readonly entryId: string; readonly requestId: string }): Promise<boolean | "retired">; expireAllPendingLocalToolPermissionCards?(args: { readonly ifPendingBeforeMs: number }): Promise<void>; }; }

export async function resolveLocalToolPermissionAsk(deps: { readonly asks: SandLocalToolPermissionController; readonly transcript: LocalToolPermissionTranscript; readonly onStrandedRetirement?: () => void }, args: LocalToolPermissionResolutionArgs): Promise<void> {
  const staleError = new Error("That local-tool permission request is no longer waiting for an answer.");
  if (!isSandLocalToolPermissionResolution(args.resolution)) throw new SandLocalToolPermissionResolutionError("Unknown local-tool permission resolution.");
  const pending = deps.asks.getPendingRequestById(args.requestId);
  if (pending === undefined) { if (deps.asks.wasSettled(args.requestId)) return; const settle = await deps.transcript.widgetResponses.settleStaleLocalToolPermissionCard({ agentId: args.agentId, entryId: args.entryId, requestId: args.requestId }); if (settle !== false) { if (settle === "retired") deps.onStrandedRetirement?.(); return; } throw staleError; }
  if (pending.agentId !== args.agentId) throw staleError;
  if (deps.asks.resolveRequest(args.requestId, args.resolution) === undefined) throw staleError;
}
