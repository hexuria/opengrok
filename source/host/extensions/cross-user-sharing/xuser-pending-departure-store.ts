import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SAND_XUSER_PENDING_DEPARTURE_FILE_NAME = "host-xuser-pending-departures.json";
export type XuserDeparture = { readonly kind: "leave-room"; readonly ownerAuthId?: string; readonly roomId: string; readonly agentId: string } | { readonly kind: "remove-agent"; readonly ownerAuthId?: string; readonly agentId: string };
export interface XuserPendingDepartureStore { list(): XuserDeparture[]; record(value: XuserDeparture): void; clear(value: XuserDeparture): void }
export function departureKey(value: XuserDeparture): string { const owner = value.ownerAuthId ?? ""; return value.kind === "leave-room" ? `leave-room\0${owner}\0${value.roomId}` : `remove-agent\0${owner}\0${value.agentId}`; }
export function parseDepartureFile(raw: string | null): Map<string, XuserDeparture> { const map = new Map<string, XuserDeparture>(); if (raw == null) return map; let value: unknown; try { value = JSON.parse(raw); } catch { return map; } const pending = typeof value === "object" && value !== null ? (value as { pending?: unknown }).pending : undefined; if (!Array.isArray(pending)) return map; for (const item of pending) { if (typeof item !== "object" || item === null) continue; const entry = item as Record<string, unknown>; if (typeof entry.agentId !== "string" || !entry.agentId) continue; const owner = typeof entry.ownerAuthId === "string" && entry.ownerAuthId ? { ownerAuthId: entry.ownerAuthId } : {}; let departure: XuserDeparture | null = null; if (entry.kind === "leave-room" && typeof entry.roomId === "string" && entry.roomId) departure = { kind: "leave-room", ...owner, roomId: entry.roomId, agentId: entry.agentId }; else if (entry.kind === "remove-agent") departure = { kind: "remove-agent", ...owner, agentId: entry.agentId }; if (departure != null) map.set(departureKey(departure), departure); } return map; }
export class SandXuserPendingDepartureStore implements XuserPendingDepartureStore {
  readonly filePath: string; private cache: Map<string, XuserDeparture> | null = null;
  constructor(rootDir: string) { this.filePath = join(rootDir, SAND_XUSER_PENDING_DEPARTURE_FILE_NAME); }
  list(): XuserDeparture[] { return [...this.read().values()]; }
  record(value: XuserDeparture): void { const map = this.read(), key = departureKey(value); if (!map.has(key)) { map.set(key, value); this.persist(map); } }
  clear(value: XuserDeparture): void { const map = this.read(); if (map.delete(departureKey(value))) this.persist(map); }
  private read(): Map<string, XuserDeparture> { if (this.cache != null) return this.cache; let raw: string | null; try { raw = readFileSync(this.filePath, "utf8"); } catch { raw = null; } return this.cache = parseDepartureFile(raw); }
  private persist(map: Map<string, XuserDeparture>): void { this.cache = map; const part = `${this.filePath}.part`; try { mkdirSync(dirname(this.filePath), { recursive: true }); writeFileSync(part, JSON.stringify({ version: 2, pending: [...map.values()] })); renameSync(part, this.filePath); } catch {} }
}
export function createInMemoryXuserPendingDepartures(): XuserPendingDepartureStore { const map = new Map<string, XuserDeparture>(); return { list: () => [...map.values()], record: (value) => { map.set(departureKey(value), value); }, clear: (value) => { map.delete(departureKey(value)); } }; }
