import { ensureFinitePositive } from "./validation.js";

const DEFAULT_MULTIPLIER = 2;
const DEFAULT_JITTER = 0;
export interface BackoffOptions { baseDelayMs: number; maxDelayMs: number; multiplier?: number; jitter?: number; random?: () => number }
export class BackoffScheduler {
  private consecutiveFailures = 0;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly multiplier: number;
  private readonly jitter: number;
  private readonly random: () => number;
  constructor(options: BackoffOptions) {
    this.baseDelayMs = ensureFinitePositive({ value: options.baseDelayMs, name: "baseDelayMs", context: "BackoffScheduler" });
    this.maxDelayMs = ensureFinitePositive({ value: options.maxDelayMs, name: "maxDelayMs", context: "BackoffScheduler" });
    if (this.baseDelayMs > this.maxDelayMs) throw new RangeError(`BackoffScheduler baseDelayMs (${this.baseDelayMs}) must be <= maxDelayMs (${this.maxDelayMs})`);
    this.multiplier = options.multiplier !== undefined ? options.multiplier : DEFAULT_MULTIPLIER;
    if (!Number.isFinite(this.multiplier) || this.multiplier < 1) throw new RangeError(`BackoffScheduler multiplier must be >= 1, got ${this.multiplier}`);
    this.jitter = options.jitter !== undefined ? options.jitter : DEFAULT_JITTER;
    if (!Number.isFinite(this.jitter) || this.jitter < 0 || this.jitter > 1) throw new RangeError(`BackoffScheduler jitter must be in [0, 1], got ${this.jitter}`);
    this.random = options.random !== undefined ? options.random : Math.random;
  }
  recordSuccess(): void { this.consecutiveFailures = 0; }
  recordFailure(): number { this.consecutiveFailures += 1; return this.computeDelayMs(this.consecutiveFailures, true); }
  peekNextDelayMs(): number { return this.computeDelayMs(this.consecutiveFailures + 1, false); }
  get failures(): number { return this.consecutiveFailures; }
  restoreFailures(count: number): void { this.consecutiveFailures = count <= 0 ? 0 : Math.floor(count); }
  private computeDelayMs(failureCount: number, applyJitter: boolean): number {
    if (failureCount <= 0) return 0;
    const raw = Math.min(this.baseDelayMs * Math.pow(this.multiplier, failureCount - 1), this.maxDelayMs);
    const adjusted = applyJitter ? this.applyJitter(raw) : raw;
    return Math.min(this.maxDelayMs, Math.max(1, Math.floor(adjusted)));
  }
  private applyJitter(delayMs: number): number {
    if (this.jitter === 0) return delayMs;
    const random = this.random();
    const safeRandom = Number.isFinite(random) ? Math.max(0, Math.min(random, 1)) : 0;
    return delayMs * (1 - this.jitter + safeRandom * 2 * this.jitter);
  }
}
