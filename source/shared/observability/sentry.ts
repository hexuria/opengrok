import { projectSandSentryEnvelope } from "./sentry-scrub.gen.js";
import type { SandSentryPrivacyTier } from "./sentry-privacy-mode.js";

export const SAND_SENTRY_DSN = "https://9fb7a1b8cb70c207a28a00476311bd40@metrics.cursor.sh/4511747394240513";
export const SAND_SENTRY_CONVERSATION_TAG = "sand.conversation_id";
export const SENTRY_EVENT_ID_PATTERN = /^[0-9a-f]{32}$/;
export const MAX_SPOOL_PURGE_SHIFTS = 64;
export type SandSentryEnvelope = [Record<string, unknown>, Array<[Record<string, unknown>, unknown]>];
type EnvelopeResult = Promise<unknown>;
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function isUnknownProcessEnvelope(envelope: SandSentryEnvelope): boolean { for (const [header, payload] of envelope[1]) if (header.type === "event" && isRecord(payload) && isRecord(payload.tags) && payload.tags["event.process"] === "unknown") return true; return false; }
export function envelopeAccount(envelope: SandSentryEnvelope, currentUserId?: string): "match" | "mismatch" | "missing" { if (currentUserId === undefined) return "match"; let matched = false; for (const [header, payload] of envelope[1]) { if (!isRecord(payload)) continue; let id: unknown; if (header.type === "event" && isRecord(payload.user)) id = payload.user.id; else if (header.type === "session") id = payload.did; if (typeof id === "string" || typeof id === "number") { if (String(id) !== currentUserId) return "mismatch"; matched = true; } } return matched ? "match" : "missing"; }

export class SandSentryPrivacyGate {
  private tier: SandSentryPrivacyTier = "fatal-metadata"; private userId: string | undefined;
  setTier(tier: SandSentryPrivacyTier): void { this.tier = tier; }
  setUserId(userId?: string): void { this.userId = userId; }
  handle(envelope: SandSentryEnvelope): SandSentryEnvelope | undefined { if (isUnknownProcessEnvelope(envelope)) return undefined; const account = envelopeAccount(envelope, this.userId); let tier = this.tier; if (account === "mismatch") tier = "fatal-metadata"; else if (account === "missing" && tier === "full") tier = "scrubbed"; return projectSandSentryEnvelope(envelope, tier) as SandSentryEnvelope | undefined; }
  belongsToCurrentAccount(envelope: SandSentryEnvelope): boolean { return envelopeAccount(envelope, this.userId) === "match"; }
}

export function gateEnvelopeSend(gate: SandSentryPrivacyGate, send: (envelope: SandSentryEnvelope) => EnvelopeResult, onAccepted?: (envelope: SandSentryEnvelope) => void): (envelope: SandSentryEnvelope) => EnvelopeResult { return (envelope) => { const projected = gate.handle(envelope); if (projected === undefined) return Promise.resolve({}); if (onAccepted !== undefined && gate.belongsToCurrentAccount(envelope)) onAccepted(projected); return send(projected); }; }
export function gateTransport<T extends { send(envelope: SandSentryEnvelope): EnvelopeResult }>(gate: SandSentryPrivacyGate, transport: T, onAccepted?: (envelope: SandSentryEnvelope) => void): T { return { ...transport, send: gateEnvelopeSend(gate, (envelope) => transport.send(envelope), onAccepted) }; }

export interface SandSentrySpoolStore { push(envelope: unknown): unknown; unshift(envelope: unknown): Promise<unknown>; shift(): Promise<unknown | undefined>; }
export function purgeableSpoolStore<T extends SandSentrySpoolStore>(store: T): T & { purge(): Promise<number> } { let purgeEpoch = 0; const shiftedAtEpoch = new WeakMap<object, number>(); return { ...store, push: (envelope) => store.push(envelope), unshift: (envelope) => { const epoch = typeof envelope === "object" && envelope !== null ? shiftedAtEpoch.get(envelope) : undefined; return epoch !== undefined && epoch < purgeEpoch ? Promise.resolve() : store.unshift(envelope); }, shift: async () => { const envelope = await store.shift(); if (typeof envelope === "object" && envelope !== null) shiftedAtEpoch.set(envelope, purgeEpoch); return envelope; }, purge: async () => { let purged = 0; while (purged < MAX_SPOOL_PURGE_SHIFTS && await store.shift() !== undefined) purged += 1; purgeEpoch += 1; return purged; } } as T & { purge(): Promise<number> }; }
export function captureOfflineSpoolStore(transportOptions: unknown, capture: (store: ReturnType<typeof purgeableSpoolStore>) => void): void { if (!isRecord(transportOptions) || typeof transportOptions.createStore !== "function") return; const createStore = transportOptions.createStore as (...args: unknown[]) => SandSentrySpoolStore; transportOptions.createStore = (...args: unknown[]) => { const store = purgeableSpoolStore(createStore.apply(transportOptions, args)); capture(store); return store; }; }

export class SandSentryAccountPrivacySync { private sequence = 0; private authId: string | undefined; begin(authId?: string): { sequence: number; reset: boolean; identityChanged: boolean } { const reset = authId === undefined || authId !== this.authId; const identityChanged = this.authId !== undefined && authId !== this.authId; this.authId = authId; return { sequence: ++this.sequence, reset, identityChanged }; } isCurrent(request: { sequence: number }): boolean { return request.sequence === this.sequence; } finish<T>(request: { sequence: number }, value: T): T | undefined { return this.isCurrent(request) ? value : undefined; } }
export class SandSentryEventIdRing { private ids: string[] = []; constructor(readonly capacity: number) {} record(envelope: SandSentryEnvelope): void { for (const [header, payload] of envelope[1]) { if (header.type !== "event" || !isRecord(payload)) continue; const id = payload.event_id; if (typeof id !== "string" || !SENTRY_EVENT_ID_PATTERN.test(id)) continue; this.ids = [id, ...this.ids.filter((known) => known !== id)].slice(0, this.capacity); } } list(): string[] { return this.ids; } clear(): void { this.ids = []; } }
