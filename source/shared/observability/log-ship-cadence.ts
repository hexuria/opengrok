import { getConnectRetryAfterMs, isRateLimitConnectError } from "../connect-errors.js";

export const LOG_SHIP_INTERVAL_MS = 15_000;
export const LOG_SHIP_MAX_BATCH_ENTRIES = 128;
export const LOG_SHIP_MAX_BATCH_BYTES = 256 * 1_024;
export const LOG_SHIP_FAILURE_MAX_BACKOFF_MS = 60_000;
export const LOG_SHIP_RATE_LIMIT_MAX_BACKOFF_MS = 5 * 60_000;
export const LOG_SHIP_JITTER_RATIO = 0.25;
export type LogShipResult = { readonly delivered: true; readonly receipt?: { logsProcessed: number; logsDropped: number } } | { readonly delivered: false; readonly error: unknown };
export function nextLogShipDelayMs(input: { readonly outcome: "shipped" | "failed" | "rate_limited"; readonly streak: number; readonly retryAfterMs?: number; readonly random?: () => number }): number {
  const random = input.random ?? Math.random;
  const backoff = (capMs: number): number => Math.min(capMs, LOG_SHIP_INTERVAL_MS * 2 ** Math.max(0, input.streak));
  const baseMs = input.outcome === "shipped" ? LOG_SHIP_INTERVAL_MS : input.outcome === "failed" ? backoff(LOG_SHIP_FAILURE_MAX_BACKOFF_MS) : Math.max(input.retryAfterMs ?? 0, backoff(LOG_SHIP_RATE_LIMIT_MAX_BACKOFF_MS));
  return Math.round(baseMs + random() * baseMs * LOG_SHIP_JITTER_RATIO);
}
export class LogShipSchedule {
  private nextShipAtMs = 0; private failureStreak = 0; private rateLimitStreak = 0;
  isDue(eager: boolean, nowMs = Date.now()): boolean { return nowMs >= this.nextShipAtMs || (eager && !this.isBackingOff()); }
  shipNext(): void { if (!this.isBackingOff()) this.nextShipAtMs = 0; }
  record(result: LogShipResult, nowMs = Date.now()): void {
    if (result.delivered) { this.failureStreak = 0; this.rateLimitStreak = 0; this.nextShipAtMs = nowMs + nextLogShipDelayMs({ outcome: "shipped", streak: 0 }); }
    else if (isRateLimitConnectError(result.error)) { this.failureStreak = 0; const retryAfterMs = getConnectRetryAfterMs(result.error, nowMs); this.nextShipAtMs = nowMs + nextLogShipDelayMs({ outcome: "rate_limited", streak: ++this.rateLimitStreak, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }); }
    else { this.rateLimitStreak = 0; this.nextShipAtMs = nowMs + nextLogShipDelayMs({ outcome: "failed", streak: ++this.failureStreak }); }
  }
  isBackingOff(): boolean { return this.failureStreak + this.rateLimitStreak > 0; }
}
export interface LogShipBufferedEntry { readonly message: string; readonly metadata: Readonly<Record<string, string>> }
export function takeLogShipBatch<T extends LogShipBufferedEntry>(buffer: readonly T[]): { batch: T[]; remaining: T[] } {
  let bytes = 0; let count = 0;
  for (const entry of buffer) {
    if (count >= LOG_SHIP_MAX_BATCH_ENTRIES) break;
    let entryBytes = entry.message.length; for (const [key, value] of Object.entries(entry.metadata)) entryBytes += key.length + value.length;
    if (count > 0 && bytes + entryBytes > LOG_SHIP_MAX_BATCH_BYTES) break;
    bytes += entryBytes; count += 1;
  }
  return { batch: buffer.slice(0, count), remaining: buffer.slice(count) };
}
