import { randomUUID } from "node:crypto";
export const SNAPSHOT_TIMEOUT_MS = 5_000;
export const MAX_DOMAIN_LENGTH = 64;
export interface HandoffRequest { agentId: string; instruction: string; telemetry?: { reason?: string; domain?: string; idpDomain?: string } }
export interface PendingHandoff { requestId: string; instruction: string; snapshotDataUrl?: string }
export type HandoffTrigger = { resolution?: "completed" | "cancelled"; trigger?: string } | string;
export interface BoxHandoffDeps {
  grabScreenshot?(agentId: string): Promise<string | Uint8Array | null>;
  prepare?(agentId: string, request: Record<string, unknown>): Promise<void>;
  onStarted?(event: { agentId: string; instruction: string }): void;
  onEnded?(event: { agentId: string; requestId: string; resolution: string; trigger: string }): void | Promise<void>;
  onStatusChanged?(agentId: string): void;
  telemetry?: { reportBoxHelp(event: Record<string, unknown>): void; trackEvent(name: string, properties: Record<string, unknown>): void };
  report?(event: Record<string, unknown>): void;
  timeoutMs?: number;
}
export function decideBoxHandBack(pending: PendingHandoff | undefined, trigger: HandoffTrigger): { kind: "none" } | { kind: "end"; requestId: string; resolution: string; trigger: string } { if (pending == null) return { kind: "none" }; if (typeof trigger === "string") return { kind: "end", requestId: pending.requestId, resolution: trigger === "cancel" ? "cancelled" : "completed", trigger }; return { kind: "end", requestId: pending.requestId, resolution: trigger.resolution ?? "completed", trigger: trigger.trigger ?? "unknown" }; }
export class BoxHandoffService {
  private readonly pending = new Map<string, PendingHandoff>();
  constructor(readonly deps: BoxHandoffDeps) {}
  get(agentId: string): PendingHandoff | null { return this.pending.get(agentId) ?? null; }
  forget(agentId: string): void { this.pending.delete(agentId); }
  start(request: HandoffRequest): { kind: "started"; requestId: string } | { kind: "already-pending"; requestId: string; instruction: string } {
    const live = this.pending.get(request.agentId); if (live != null) return { kind: "already-pending", requestId: live.requestId, instruction: live.instruction };
    const requestId = randomUUID(); this.pending.set(request.agentId, { requestId, instruction: request.instruction }); this.deps.onStarted?.({ agentId: request.agentId, instruction: request.instruction }); this.deps.onStatusChanged?.(request.agentId); void this.captureSnapshot(request, requestId); return { kind: "started", requestId };
  }
  async end(agentId: string, trigger: HandoffTrigger): Promise<void> { const decision = decideBoxHandBack(this.pending.get(agentId), trigger); if (decision.kind === "none") return; this.pending.delete(agentId); await this.deps.onEnded?.({ agentId, requestId: decision.requestId, resolution: decision.resolution, trigger: decision.trigger }); this.deps.onStatusChanged?.(agentId); }
  private async captureSnapshot(request: HandoffRequest, requestId: string): Promise<void> { let captured = false, timer: NodeJS.Timeout | undefined; try { if (this.deps.prepare != null) await this.deps.prepare(request.agentId, request as unknown as Record<string, unknown>); const timeout = new Promise<null>((resolve) => { const handle=setTimeout(resolve, this.deps.timeoutMs ?? SNAPSHOT_TIMEOUT_MS) as unknown as NodeJS.Timeout;timer=handle;handle.unref(); }), screenshot = await Promise.race([this.deps.grabScreenshot?.(request.agentId) ?? Promise.resolve(null), timeout]); if (screenshot != null && screenshot.length > 0) { const live = this.pending.get(request.agentId); if (live?.requestId === requestId) { const encoded = typeof screenshot === "string" ? screenshot : Buffer.from(screenshot).toString("base64"); this.pending.set(request.agentId, { ...live, snapshotDataUrl: `data:image/webp;base64,${encoded}` }); captured = true; this.deps.onStatusChanged?.(request.agentId); } } } catch {} finally { if(timer!=null)clearTimeout(timer);const reason = request.telemetry?.reason, analyticsReason = reason === "auth" || reason === "captcha" || reason === "payment" ? reason : reason == null ? undefined : "other"; this.deps.telemetry?.reportBoxHelp({ conversationId: request.agentId, snapshotCaptured: captured, reason }); this.deps.telemetry?.trackEvent("sand.box_help", { agent_id: request.agentId, snapshot_captured: captured, ...(analyticsReason == null ? {} : { reason: analyticsReason }), ...(request.telemetry?.domain == null ? {} : { domain: request.telemetry.domain.slice(0, MAX_DOMAIN_LENGTH) }), ...(request.telemetry?.idpDomain == null ? {} : { idp_domain: request.telemetry.idpDomain.slice(0, MAX_DOMAIN_LENGTH) }) }); this.deps.report?.({ outcome: captured ? "ready" : "no_snapshot", agentId: request.agentId }); } }
}
