import { randomUUID } from "node:crypto";

import { DeadlineExceededError, type Clock, type DeadlinePolicy } from "../../../internal/scheduling.js";
import {
  SAND_NO_WEBAUTHN_MACHINE_MESSAGE,
  SAND_WEBAUTHN_LIVENESS_WINDOW_MS,
  SAND_WEBAUTHN_MACHINE_UNAVAILABLE_MESSAGE,
  sandWebAuthnOriginClass,
  type WebAuthnCeremony,
  type WebAuthnRequestFrame,
  type WebAuthnResponseFrame
} from "../../../shared/webauthn-gateway.js";

type DesktopStage = { readonly stage: "grant"; readonly outcome: "ok" | "declined" | "failed" } | { readonly stage: "sign"; readonly outcome: "ok" | "failed" };
type Settlement = { readonly ok: true; readonly credentialJson: unknown } | { readonly ok: false; readonly name: string; readonly message: string; readonly code?: string };

function failure(name: string, message: string) { return { ok: false as const, error: { name, message } }; }

export function parseDesktopStage(frame: Extract<WebAuthnResponseFrame, { kind: "stage" }>): DesktopStage | undefined {
  if (frame.stage === "grant" && (frame.outcome === "ok" || frame.outcome === "declined" || frame.outcome === "failed")) return { stage: "grant", outcome: frame.outcome };
  if (frame.stage === "sign" && (frame.outcome === "ok" || frame.outcome === "failed")) return { stage: "sign", outcome: frame.outcome };
  return undefined;
}

export function stageCause(stage: DesktopStage): "consent_declined" | "sign_failed" | "desktop_failed" | undefined {
  if (stage.outcome === "declined") return "consent_declined";
  if (stage.outcome === "failed") return stage.stage === "sign" ? "sign_failed" : "desktop_failed";
  return undefined;
}

interface Funnel { requestId: string; originClass: string; ceremonyKind: "create" | "get"; startedAt: number; }
interface Pending { settle(value: Settlement): void; funnel: Funnel; lastStage?: DesktopStage; }
interface Provider {
  id: string;
  send(frame: WebAuthnRequestFrame): void;
  lastSeenAt: number;
  hasHeartbeat: boolean;
  computerId?: string;
  label?: string;
}

export interface SandWebAuthnBridgeDependencies {
  readonly clock: Clock;
  readonly ceremonyDeadline: DeadlinePolicy;
  readonly report: (report: Record<string, unknown>) => void;
  readonly createId?: () => string;
}

export class SandWebAuthnBridge {
  private readonly providers = new Set<Provider>();
  private readonly providersById = new Map<string, Provider>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: SandWebAuthnBridgeDependencies) {}

  registerProvider(send: (frame: WebAuthnRequestFrame) => void): () => void {
    const provider: Provider = { id: this.deps.createId?.() ?? randomUUID(), send, lastSeenAt: this.deps.clock.now(), hasHeartbeat: false };
    this.providers.add(provider);
    this.providersById.set(provider.id, provider);
    send({ kind: "welcome", providerId: provider.id });
    return () => { this.providers.delete(provider); this.providersById.delete(provider.id); };
  }

  submitResponses(batch: { readonly providerId?: string; readonly frames: readonly WebAuthnResponseFrame[] }): void {
    const provider = batch.providerId === undefined ? undefined : this.providersById.get(batch.providerId);
    if (provider !== undefined) provider.lastSeenAt = this.deps.clock.now();
    for (const frame of batch.frames) {
      switch (frame.kind) {
        case "hello":
          if (provider !== undefined) {
            if (frame.computerId !== undefined) provider.computerId = frame.computerId;
            if (frame.label !== undefined) provider.label = frame.label;
          }
          break;
        case "ping":
          if (provider !== undefined) provider.hasHeartbeat = true;
          break;
        case "stage": {
          const pending = this.pending.get(frame.requestId);
          const stage = parseDesktopStage(frame);
          if (pending !== undefined && stage !== undefined) {
            pending.lastStage = stage;
            this.emit(pending.funnel, { stage: stage.stage, outcome: stage.outcome, cause: stageCause(stage) });
          }
          break;
        }
        case "result": this.settle(frame.requestId, { ok: true, credentialJson: frame.credentialJson }); break;
        case "error": this.settle(frame.requestId, { ok: false, name: frame.name, message: frame.message, ...(frame.code === undefined ? {} : { code: frame.code }) }); break;
      }
    }
  }

  async requestCeremony(ceremony: WebAuthnCeremony): Promise<{ ok: true; credentialJson: unknown } | { ok: false; error: { name: string; message: string } }> {
    const funnel: Funnel = {
      requestId: this.deps.createId?.() ?? randomUUID(),
      originClass: sandWebAuthnOriginClass(ceremony.origin),
      ceremonyKind: ceremony.kind === "create" ? "create" : "get",
      startedAt: this.deps.clock.monotonicNow()
    };
    const provider = this.selectProvider();
    if (provider === undefined) {
      const cause = this.providers.size === 0 ? "no_provider" : "provider_stale";
      this.emit(funnel, { stage: "request", outcome: "failed", cause, ...this.providerCounts() });
      this.emit(funnel, { stage: "complete", outcome: "failed", cause });
      return failure("NotAllowedError", this.providers.size === 0 ? SAND_NO_WEBAUTHN_MACHINE_MESSAGE : SAND_WEBAUTHN_MACHINE_UNAVAILABLE_MESSAGE);
    }
    const { promise: settled, resolve: settle } = Promise.withResolvers<Settlement>();
    this.pending.set(funnel.requestId, { settle, funnel });
    try {
      provider.send({ kind: "ceremony", requestId: funnel.requestId, ceremony });
    } catch (error) {
      this.pending.delete(funnel.requestId);
      this.emit(funnel, { stage: "request", outcome: "failed", cause: "dispatch_failed", ...this.providerCounts() });
      this.emit(funnel, { stage: "complete", outcome: "failed", cause: "dispatch_failed" });
      throw error;
    }
    this.emit(funnel, { stage: "request", outcome: "ok", ...this.providerCounts() });
    try {
      const settlement = await this.deps.ceremonyDeadline.run(() => settled);
      return settlement.ok ? { ok: true, credentialJson: settlement.credentialJson } : failure(settlement.name, settlement.message);
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        if (this.pending.has(funnel.requestId)) this.emit(funnel, { stage: "complete", outcome: "timeout", cause: "timeout" });
        provider.send({ kind: "cancel", requestId: funnel.requestId });
        return failure("NotAllowedError", "The security key ceremony timed out before it was completed.");
      }
      throw error;
    } finally { this.pending.delete(funnel.requestId); }
  }

  private settle(requestId: string, settlement: Settlement): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    if (settlement.ok) this.emit(pending.funnel, { stage: "complete", outcome: "ok" });
    else {
      const cause = (pending.lastStage !== undefined ? stageCause(pending.lastStage) : undefined) ?? "desktop_failed";
      this.emit(pending.funnel, { stage: "complete", outcome: "failed", cause, rawDomErrorName: settlement.name, ...(settlement.code === undefined ? {} : { rawSignErrorClass: settlement.code }) });
    }
    pending.settle(settlement);
  }

  private emit(funnel: Funnel, report: Record<string, unknown>): void {
    this.deps.report({ ...report, requestId: funnel.requestId, originClass: funnel.originClass, ceremonyKind: funnel.ceremonyKind, elapsedMs: this.deps.clock.monotonicNow() - funnel.startedAt });
  }

  providerCounts(): { providerCount: number; liveProviderCount: number } {
    const now = this.deps.clock.now();
    let live = 0;
    for (const provider of this.providers) if (!provider.hasHeartbeat || now - provider.lastSeenAt <= SAND_WEBAUTHN_LIVENESS_WINDOW_MS) live += 1;
    return { providerCount: this.providers.size, liveProviderCount: live };
  }

  private selectProvider(): Provider | undefined {
    const now = this.deps.clock.now();
    let best: Provider | undefined;
    for (const provider of this.providers) {
      const live = !provider.hasHeartbeat || now - provider.lastSeenAt <= SAND_WEBAUTHN_LIVENESS_WINDOW_MS;
      if (live && (best === undefined || provider.lastSeenAt > best.lastSeenAt)) best = provider;
    }
    return best;
  }
}

