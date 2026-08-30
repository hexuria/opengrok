import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SAND_XUSER_ROOM_TOMBSTONE_FILE_NAME = "host-xuser-room-tombstones.json";
export interface XuserRoomTombstone { readonly roomId: string; readonly ownerAuthId?: string; readonly tornDownAtMs: number }
export interface XuserRoomTombstoneStore { list(): XuserRoomTombstone[]; record(value: XuserRoomTombstone): void; clear(value: Pick<XuserRoomTombstone, "roomId" | "ownerAuthId">): void }

export function tombstoneKey(tombstone: Pick<XuserRoomTombstone, "roomId" | "ownerAuthId">): string { return `${tombstone.ownerAuthId ?? ""}\0${tombstone.roomId}`; }
export function parseTombstoneFile(raw: string | null): Map<string, XuserRoomTombstone> {
  const map = new Map<string, XuserRoomTombstone>();
  if (raw == null) return map;
  let value: unknown; try { value = JSON.parse(raw); } catch { return map; }
  if (typeof value !== "object" || value === null || !Array.isArray((value as { tombstones?: unknown }).tombstones)) return map;
  for (const item of (value as { tombstones: unknown[] }).tombstones) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.roomId !== "string" || entry.roomId.length === 0) continue;
    const tombstone: XuserRoomTombstone = { roomId: entry.roomId, ...(typeof entry.ownerAuthId === "string" && entry.ownerAuthId.length > 0 ? { ownerAuthId: entry.ownerAuthId } : {}), tornDownAtMs: typeof entry.tornDownAtMs === "number" && Number.isFinite(entry.tornDownAtMs) ? entry.tornDownAtMs : 0 };
    map.set(tombstoneKey(tombstone), tombstone);
  }
  return map;
}
export class SandXuserRoomTombstoneStore implements XuserRoomTombstoneStore {
  readonly filePath: string; private cache: Map<string, XuserRoomTombstone> | null = null;
  constructor(rootDir: string) { this.filePath = join(rootDir, SAND_XUSER_ROOM_TOMBSTONE_FILE_NAME); }
  list(): XuserRoomTombstone[] { return [...this.read().values()]; }
  record(value: XuserRoomTombstone): void { const map = this.read(), key = tombstoneKey(value); if (map.has(key)) return; map.set(key, value); this.persist(map); }
  clear(value: Pick<XuserRoomTombstone, "roomId" | "ownerAuthId">): void { const map = this.read(); if (map.delete(tombstoneKey(value))) this.persist(map); }
  private read(): Map<string, XuserRoomTombstone> { if (this.cache != null) return this.cache; let raw: string | null; try { raw = readFileSync(this.filePath, "utf8"); } catch { raw = null; } return this.cache = parseTombstoneFile(raw); }
  private persist(map: Map<string, XuserRoomTombstone>): void { this.cache = map; const part = `${this.filePath}.part`; try { mkdirSync(dirname(this.filePath), { recursive: true }); writeFileSync(part, JSON.stringify({ version: 1, tombstones: [...map.values()] })); renameSync(part, this.filePath); } catch {} }
}
export function createInMemoryXuserRoomTombstones(): XuserRoomTombstoneStore { const map = new Map<string, XuserRoomTombstone>(); return { list: () => [...map.values()], record: (value) => { map.set(tombstoneKey(value), value); }, clear: (value) => { map.delete(tombstoneKey(value)); } }; }
