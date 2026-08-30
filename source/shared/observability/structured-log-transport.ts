import type { DeadlinePolicy, ExpiryPolicy, PollingPolicy } from "../../internal/scheduling.js";
import { SandError, sandErrorTags } from "../errors/registry.js";
import { LogShipSchedule, takeLogShipBatch, type LogShipResult } from "./log-ship-cadence.js";
import { BOX_LOG_EVENT, HOST_LOG_EVENT, TELEMETRY_DROPPED_EVENT, TELEMETRY_DROP_REASONS, TELEMETRY_DROP_UNIT_BY_REASON, TELEMETRY_SHIP_TIMEOUT_EVENT, type TelemetryDropReason } from "./telemetry-events.js";

export const MAX_BUFFER_SIZE = 1_000;
export const STRUCTURED_LOG_SUBMIT_DEADLINE_MS = 15_000;
export const STRUCTURED_LOG_REPLAY_MAX_AGE_MS = 17 * 60 * 60 * 1_000;
export const DEADLINE_EXPIRY_CODE = "deadline_exceeded";
export type StructuredLogLevel = "debug" | "info" | "warn" | "error";
export enum ClientLogLevel { UNSPECIFIED = 0, INFO = 1, DEBUG = 2, WARN = 3, ERROR = 4 }
export interface StructuredLogEntry { readonly level: ClientLogLevel; readonly message: string; readonly metadata: Readonly<Record<string, string>>; readonly timestamp: bigint; readonly key: string }
export interface BufferedStructuredLog { readonly level: StructuredLogLevel; readonly message: string; readonly metadata: Record<string, string>; readonly timestamp: number; readonly onSettled?: (settlement: "delivered" | "dropped") => void }
interface DropCounter { observed: number; acknowledgedThrough: number }
export type DropCounters = Record<TelemetryDropReason, DropCounter>;
export interface StructuredLogCheckpoint { readonly counterId: string; readonly counters: DropCounters; readonly records: readonly BufferedStructuredLog[] }
export interface StructuredLogClient { submitLogs(request: { readonly logs: readonly StructuredLogEntry[] }, options: { readonly signal: AbortSignal }): Promise<{ readonly logsProcessed: number; readonly logsDropped: number }> }
export function isDeadlineExpiry(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === DEADLINE_EXPIRY_CODE; }
export function createDropCounterId(): string { const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes); return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
export function emptyDropCounters(): DropCounters { return { ship_failed: { observed: 0, acknowledgedThrough: 0 }, overflow_evicted: { observed: 0, acknowledgedThrough: 0 }, replay_expired: { observed: 0, acknowledgedThrough: 0 }, backend_dropped: { observed: 0, acknowledgedThrough: 0 }, account_rotated: { observed: 0, acknowledgedThrough: 0 } }; }
export function cloneDropCounters(counters: DropCounters): DropCounters { return { ship_failed: { ...counters.ship_failed }, overflow_evicted: { ...counters.overflow_evicted }, replay_expired: { ...counters.replay_expired }, backend_dropped: { ...counters.backend_dropped }, account_rotated: { ...counters.account_rotated } }; }
export function isValidLogShipReceipt(response: { logsProcessed: unknown; logsDropped: unknown }, requestSize: number): response is { logsProcessed: number; logsDropped: number } { return Number.isSafeInteger(response.logsProcessed) && (response.logsProcessed as number) >= 0 && Number.isSafeInteger(response.logsDropped) && (response.logsDropped as number) >= 0 && (response.logsProcessed as number) + (response.logsDropped as number) === requestSize; }
export function cleanStructuredLogMetadata(metadata: Readonly<Record<string, string | undefined>>): Record<string, string> { const result: Record<string, string> = {}; for (const [key, value] of Object.entries(metadata)) if (value !== undefined && value.length > 0) result[key] = value; return result; }
export function truncateStructuredLogValue(value: string, max: number): string { return value.length > max ? value.slice(0, max) : value; }
export function toClientLogLevel(level: StructuredLogLevel): ClientLogLevel { return level === "debug" ? ClientLogLevel.DEBUG : level === "info" ? ClientLogLevel.INFO : level === "warn" ? ClientLogLevel.WARN : ClientLogLevel.ERROR; }

export interface StructuredLogTransportOptions {
  readonly platformTags: Readonly<Record<string, string | undefined>>; readonly key: string; readonly disabled?: boolean;
  readonly initialCheckpoint?: StructuredLogCheckpoint; readonly holdForIdentity?: boolean; readonly identityHoldExpiry?: ExpiryPolicy; readonly polling: PollingPolicy;
  readonly submitDeadline: DeadlinePolicy; createClient(): StructuredLogClient; readonly retainUndeliveredOnDispose?: boolean;
}
export class StructuredLogTransport {
  private readonly platformTags: Record<string, string>; private readonly shipSchedule = new LogShipSchedule(); private dropCounterId: string; private dropCounters: DropCounters;
  private buffer: BufferedStructuredLog[]; private activeBatch: BufferedStructuredLog[] = []; private client: StructuredLogClient | undefined; private pollingHandle: { dispose(): void } | undefined; private identityHoldHandle: { dispose(): void } | undefined;
  private identityTags: Record<string, string> = {}; private isDisposed = false; private deliveryGeneration = 0; private readonly requestAbortControllers = new Set<AbortController>();
  private flushHeldForIdentity: boolean; private flushTickListener: (() => void) | undefined; private flushSettledListener: (() => void | Promise<void>) | undefined; private flushChain: Promise<boolean> = Promise.resolve(false);
  private eagerFlushQueued = false; private eagerDrainRequested = false; private submitTimeoutStreakActive = false;
  constructor(private readonly options: StructuredLogTransportOptions) {
    this.platformTags = cleanStructuredLogMetadata(options.platformTags); this.dropCounterId = options.initialCheckpoint?.counterId ?? createDropCounterId(); this.dropCounters = options.initialCheckpoint ? cloneDropCounters(options.initialCheckpoint.counters) : emptyDropCounters();
    this.buffer = (options.initialCheckpoint?.records ?? []).slice(-MAX_BUFFER_SIZE).map((record) => ({ ...record, metadata: { ...record.metadata } })); this.flushHeldForIdentity = options.holdForIdentity === true;
    if (this.flushHeldForIdentity) {
      if (options.identityHoldExpiry === undefined) throw new TypeError("identityHoldExpiry is required when holdForIdentity is true");
      this.identityHoldHandle = options.identityHoldExpiry.arm("structured-log-host-identity", () => this.releaseIdentityHold());
    }
    this.ensurePolling();
  }
  setIdentityTags(tags: Readonly<Record<string, string | undefined>>): void { this.identityTags = cleanStructuredLogMetadata(tags); this.releaseIdentityHold(); }
  setFlushTickListener(listener?: () => void): void { this.flushTickListener = listener; if (listener !== undefined) this.ensurePolling(); else if (this.options.disabled) { this.pollingHandle?.dispose(); this.pollingHandle = undefined; } }
  setFlushSettledListener(listener?: () => void | Promise<void>): void { this.flushSettledListener = listener; }
  enqueue(level: StructuredLogLevel, message: string, metadata: Readonly<Record<string, string | undefined>>, onSettled?: BufferedStructuredLog["onSettled"]): void { this.enqueueAt(level, message, metadata, Date.now(), onSettled); }
  enqueueAt(level: StructuredLogLevel, message: string, metadata: Readonly<Record<string, string | undefined>>, timestamp: number, onSettled?: BufferedStructuredLog["onSettled"]): void {
    if (this.options.disabled || this.isDisposed) { onSettled?.("dropped"); return; }
    this.buffer.push({ level, message, metadata: { ...this.platformTags, ...cleanStructuredLogMetadata(metadata) }, timestamp, ...(onSettled === undefined ? {} : { onSettled }) }); this.dropBufferOverflow();
    if (level === "error") this.shipSchedule.shipNext(); if (this.buffer.length >= 128) { this.eagerDrainRequested = true; this.queueEagerDrain(); }
  }
  async shipConfirmed(level: StructuredLogLevel, message: string, metadata: Readonly<Record<string, string | undefined>>): Promise<boolean> {
    if (this.options.disabled) return true; if (this.isDisposed) return false; const generation = this.deliveryGeneration;
    const result = await this.shipLogs([this.buildLogEntry(level, message, { ...this.platformTags, ...cleanStructuredLogMetadata(metadata) }, Date.now())]); if (generation === this.deliveryGeneration) this.recordSourceResult(result); return result.delivered;
  }
  capturePending(): BufferedStructuredLog[] { return [...this.activeBatch, ...this.buffer].map((record) => ({ ...record, metadata: { ...record.metadata } })); }
  captureCheckpoint(): StructuredLogCheckpoint { return { counterId: this.dropCounterId, counters: cloneDropCounters(this.dropCounters), records: this.capturePending() }; }
  recordDropped(reason: TelemetryDropReason, count: number): void { this.recordDrop(reason, count); }
  clearPending(): Promise<void> {
    this.deliveryGeneration += 1; for (const controller of this.requestAbortControllers) controller.abort(); this.requestAbortControllers.clear(); this.settle([...this.activeBatch, ...this.buffer], "dropped"); this.activeBatch = []; this.buffer = []; this.eagerDrainRequested = false; this.client = undefined; this.dropCounterId = createDropCounterId(); this.dropCounters = emptyDropCounters();
    this.flushChain = this.flushChain.then(() => false, () => false); return this.flushChain.then(() => undefined);
  }
  async flushNow(): Promise<boolean> { return this.isDisposed ? this.pendingCount() === 0 && !this.hasPendingDrops() : await this.drain(); }
  async dispose(): Promise<boolean> {
    if (this.isDisposed) return this.pendingCount() === 0 && !this.hasPendingDrops(); this.isDisposed = true; this.pollingHandle?.dispose(); this.pollingHandle = undefined; this.flushHeldForIdentity = false; this.identityHoldHandle?.dispose(); this.identityHoldHandle = undefined;
    const drained = await this.drain(); if (!drained && this.options.retainUndeliveredOnDispose !== true) { const stranded = [...this.activeBatch, ...this.buffer]; this.activeBatch = []; this.buffer = []; this.settle(stranded, "dropped"); } return drained;
  }
  private async drain(): Promise<boolean> { while (this.pendingCount() > 0 || this.hasPendingDrops()) { const progressed = await this.flush(); if (!progressed && (this.pendingCount() > 0 || this.hasPendingDrops())) return false; } return true; }
  private pendingCount(): number { return this.activeBatch.length + this.buffer.length; }
  private ensurePolling(): void {
    if (this.isDisposed || this.pollingHandle !== undefined || (this.options.disabled && this.flushTickListener === undefined)) return;
    this.pollingHandle = this.options.polling.start(async () => { try { this.flushTickListener?.(); } catch {} try { await this.flushIfDue(false); } catch (error) { console.error("[structured-log-transport] flush tick failed:", error); } });
  }
  private releaseIdentityHold(): void { if (!this.flushHeldForIdentity) return; this.flushHeldForIdentity = false; this.identityHoldHandle?.dispose(); this.identityHoldHandle = undefined; void this.flushIfDue(true); }
  private async flushIfDue(eager: boolean): Promise<void> { if ((this.buffer.length === 0 && !this.hasPendingDrops()) || !this.shipSchedule.isDue(eager)) return; await this.flush(); this.queueEagerDrain(); }
  private queueEagerDrain(): void {
    if (this.isDisposed || this.eagerFlushQueued || !this.eagerDrainRequested || this.flushHeldForIdentity || this.buffer.length === 0 || !this.shipSchedule.isDue(true)) return;
    this.eagerFlushQueued = true; void this.drainEager().finally(() => { this.eagerFlushQueued = false; this.queueEagerDrain(); });
  }
  private async drainEager(): Promise<void> { while (!this.isDisposed && this.eagerDrainRequested && !this.flushHeldForIdentity && this.buffer.length > 0 && this.shipSchedule.isDue(true)) await this.flush(); if (this.buffer.length === 0) this.eagerDrainRequested = false; }
  private flush(): Promise<boolean> { this.flushChain = this.flushChain.then(() => this.flushOnce(), () => this.flushOnce()); return this.flushChain; }
  private async finishFlush(progressed: boolean): Promise<boolean> { await this.flushSettledListener?.(); return progressed; }
  private async flushOnce(): Promise<boolean> {
    if (this.flushHeldForIdentity) return false; const generation = this.deliveryGeneration;
    if (this.buffer.length === 0) { const attempt = await this.reportPendingDrops(generation); if (generation !== this.deliveryGeneration) return this.finishFlush(true); if (attempt !== undefined) this.shipSchedule.record(attempt.result); return this.finishFlush(attempt?.acknowledged ?? false); }
    this.expireBufferedLogs(); if (this.buffer.length === 0) { const attempt = await this.reportPendingDrops(generation); if (generation !== this.deliveryGeneration) return this.finishFlush(true); if (attempt !== undefined) this.shipSchedule.record(attempt.result); return this.finishFlush(attempt?.acknowledged ?? false); }
    const { batch, remaining } = takeLogShipBatch(this.buffer); this.buffer = remaining; this.activeBatch = batch; const result = await this.shipLogs(batch.map((log) => this.buildLogEntry(log.level, log.message, log.metadata, log.timestamp)));
    if (generation !== this.deliveryGeneration) { this.activeBatch = []; return this.finishFlush(true); }
    if (!result.delivered) { this.buffer = [...batch, ...this.buffer]; this.recordSourceResult(result); this.dropBufferOverflow(); this.activeBatch = []; this.shipSchedule.record(result); return this.finishFlush(false); }
    this.activeBatch = []; this.settle(batch, "delivered"); this.recordSourceResult(result); this.shipSchedule.record(result); await this.reportPendingDrops(generation); return this.finishFlush(true);
  }
  private expireBufferedLogs(): void { const now = Date.now(); const expired = this.buffer.filter((log) => now - log.timestamp > STRUCTURED_LOG_REPLAY_MAX_AGE_MS); this.buffer = this.buffer.filter((log) => now - log.timestamp <= STRUCTURED_LOG_REPLAY_MAX_AGE_MS); this.recordDrop("replay_expired", expired.length); this.settle(expired, "dropped"); }
  private recordDrop(reason: TelemetryDropReason, count: number): void { if (count <= 0) return; const counter = this.dropCounters[reason]; counter.observed += Math.min(count, Number.MAX_SAFE_INTEGER - counter.observed); }
  private recordSourceResult(result: LogShipResult): void { if (!result.delivered) this.recordDrop("ship_failed", 1); else this.recordDrop("backend_dropped", result.receipt?.logsDropped ?? 0); }
  private hasPendingDrops(): boolean { return TELEMETRY_DROP_REASONS.some((reason) => this.dropCounters[reason].observed > this.dropCounters[reason].acknowledgedThrough); }
  private snapshotPendingDrops(): { reason: TelemetryDropReason; through: number }[] { return TELEMETRY_DROP_REASONS.flatMap((reason) => { const counter = this.dropCounters[reason]; return counter.observed > counter.acknowledgedThrough ? [{ reason, through: counter.observed }] : []; }); }
  private async reportPendingDrops(generation: number): Promise<{ result: LogShipResult; acknowledged: boolean } | undefined> {
    const snapshot = this.snapshotPendingDrops(); if (snapshot.length === 0) return undefined; const timestamp = Date.now();
    const reports = snapshot.map(({ reason, through }) => this.buildLogEntry("warn", TELEMETRY_DROPPED_EVENT, { ...this.platformTags, reason, unit: TELEMETRY_DROP_UNIT_BY_REASON[reason], count: String(through), counter_id: this.dropCounterId }, timestamp)); const result = await this.shipLogs(reports);
    if (generation !== this.deliveryGeneration) return { result, acknowledged: true }; if (!result.delivered || result.receipt?.logsProcessed !== reports.length || result.receipt.logsDropped !== 0) return { result, acknowledged: false };
    for (const { reason, through } of snapshot) this.dropCounters[reason].acknowledgedThrough = Math.max(this.dropCounters[reason].acknowledgedThrough, through); return { result, acknowledged: true };
  }
  private dropBufferOverflow(): void {
    let overflow = this.buffer.length - MAX_BUFFER_SIZE; if (overflow <= 0) return; const evicted: BufferedStructuredLog[] = [];
    this.buffer = this.buffer.filter((entry) => { if (overflow > 0 && (entry.message === HOST_LOG_EVENT || entry.message === BOX_LOG_EVENT)) { overflow -= 1; evicted.push(entry); return false; } return true; }); evicted.push(...this.buffer.splice(0, overflow)); this.recordDrop("overflow_evicted", evicted.length); this.settle(evicted, "dropped");
  }
  private settle(logs: readonly BufferedStructuredLog[], settlement: "delivered" | "dropped"): void { for (const log of logs) log.onSettled?.(settlement); }
  private buildLogEntry(level: StructuredLogLevel, message: string, metadata: Readonly<Record<string, string>>, timestamp: number): StructuredLogEntry { return { level: toClientLogLevel(level), message, metadata: { ...this.identityTags, ...metadata }, timestamp: BigInt(timestamp), key: this.options.key }; }
  private reportSubmitTimeout(error: unknown, batchEntries: number): void { if (!isDeadlineExpiry(error)) { this.submitTimeoutStreakActive = false; return; } if (this.submitTimeoutStreakActive) return; this.submitTimeoutStreakActive = true; this.enqueue("warn", TELEMETRY_SHIP_TIMEOUT_EVENT, sandErrorTags(SandError.logShipTimeout({ batchEntries }))); }
  private async shipLogs(logs: readonly StructuredLogEntry[]): Promise<LogShipResult> {
    if (logs.length === 0) return { delivered: true, receipt: { logsProcessed: 0, logsDropped: 0 } }; const controller = new AbortController(); this.requestAbortControllers.add(controller); const client = this.client ?? (this.client = this.options.createClient());
    try { const response = await this.options.submitDeadline.run((signal) => client.submitLogs({ logs }, { signal: AbortSignal.any([signal, controller.signal]) })); this.submitTimeoutStreakActive = false; return { delivered: true, ...(isValidLogShipReceipt(response, logs.length) ? { receipt: { logsProcessed: response.logsProcessed, logsDropped: response.logsDropped } } : {}) }; }
    catch (error) { if (this.client === client) this.client = undefined; this.reportSubmitTimeout(error, logs.length); return { delivered: false, error }; }
    finally { this.requestAbortControllers.delete(controller); }
  }
}
