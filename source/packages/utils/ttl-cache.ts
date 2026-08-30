export class TTLCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAtMs: number }>();
  private readonly ttlMs: () => number;
  constructor(options: { ttlMs: number | (() => number); now?: () => number }) {
    this.ttlMs = typeof options.ttlMs === "function" ? options.ttlMs : TTLCache.validated(options.ttlMs);
    this.now = options.now ?? Date.now;
  }
  private readonly now: () => number;
  private static validated(ttlMs: number): () => number {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error(`TTL cache requires a positive ttlMs, got ${ttlMs}`);
    return () => ttlMs;
  }
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= this.now()) { this.entries.delete(key); return undefined; }
    return entry.value;
  }
  has(key: K): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    if (entry.expiresAtMs <= this.now()) { this.entries.delete(key); return false; }
    return true;
  }
  set(key: K, value: V): void { this.entries.set(key, { value, expiresAtMs: this.now() + this.ttlMs() }); }
  delete(key: K): boolean { return this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
}
