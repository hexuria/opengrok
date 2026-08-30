import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SAND_XUSER_TURN_DEDUPE_FILE_NAME } from "../../durable-file-policy.js";

export const XUSER_TURN_DEDUPE_TTL_MS = 3 * 24 * 60 * 60 * 1_000;
export interface XuserTurnDedupe { markSeenIfNew(nonce: string): boolean }
export function parseDedupeFile(raw: string | null): Map<string, number> { const map = new Map<string, number>(); if (raw == null) return map; let value: unknown; try { value = JSON.parse(raw); } catch { return map; } const seen = typeof value === "object" && value !== null ? (value as { seen?: unknown }).seen : undefined; if (!Array.isArray(seen)) return map; for (const item of seen) { if (typeof item !== "object" || item === null) continue; const entry = item as Record<string, unknown>; if (typeof entry.nonce === "string" && entry.nonce.length > 0 && typeof entry.expiresAtMs === "number" && Number.isFinite(entry.expiresAtMs)) map.set(entry.nonce, entry.expiresAtMs); } return map; }
export class SandXuserTurnDedupeStore implements XuserTurnDedupe {
  readonly filePath: string; private cache: Map<string, number> | null = null;
  constructor(rootDir: string, readonly ttlMs = XUSER_TURN_DEDUPE_TTL_MS, readonly nowMs: () => number = Date.now) { this.filePath = join(rootDir, SAND_XUSER_TURN_DEDUPE_FILE_NAME); }
  markSeenIfNew(nonce: string): boolean { if (nonce.length === 0) return false; const map = this.read(), now = this.nowMs(); let mutated = this.pruneExpired(map, now); if (map.has(nonce)) { if (mutated) this.persist(map); return false; } map.set(nonce, now + this.ttlMs); mutated = true; if (mutated) this.persist(map); return true; }
  pruneExpired(map: Map<string, number>, now: number): boolean { let mutated = false; for (const [nonce, expires] of map) if (expires <= now) { map.delete(nonce); mutated = true; } return mutated; }
  private read(): Map<string, number> { if (this.cache != null) return this.cache; let raw: string | null; try { raw = readFileSync(this.filePath, "utf8"); } catch { raw = null; } return this.cache = parseDedupeFile(raw); }
  private persist(map: Map<string, number>): void { this.cache = map; const part = `${this.filePath}.part`; try { mkdirSync(dirname(this.filePath), { recursive: true }); writeFileSync(part, JSON.stringify({ version: 1, seen: [...map].map(([nonce, expiresAtMs]) => ({ nonce, expiresAtMs })) })); renameSync(part, this.filePath); } catch {} }
}
export function createInMemoryXuserTurnDedupe(ttlMs = XUSER_TURN_DEDUPE_TTL_MS, nowMs: () => number = Date.now): XuserTurnDedupe { const map = new Map<string, number>(); return { markSeenIfNew(nonce) { if (!nonce) return false; const now = nowMs(); for (const [seen, expires] of map) if (expires <= now) map.delete(seen); if (map.has(nonce)) return false; map.set(nonce, now + ttlMs); return true; } }; }
