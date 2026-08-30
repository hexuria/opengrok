import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { SAND_PENDING_WAKE_FILE_NAME } from "../../durable-file-policy.js";
import type { PendingWakeKind, PendingWakeMarker } from "./async-task-union.js";
export const PENDING_WAKE_KINDS = ["cloud-agent", "subagent", "shell"] as const;
export interface QuietWakeOrigin {
  automation?: { id: string; name: string };
}
export interface DurablePendingWakeMarker extends PendingWakeMarker {
  quietOrigin?: QuietWakeOrigin;
  interruptedByRecreate?: boolean;
}
export function coerceQuietOrigin(
  value: unknown,
): DurablePendingWakeMarker["quietOrigin"] | null {
  if (typeof value !== "object" || value == null) return null;
  const automation = (value as { automation?: unknown }).automation;
  if (typeof automation !== "object" || automation == null) return {};
  const a = automation as Record<string, unknown>;
  return typeof a.id === "string" &&
    a.id.length > 0 &&
    typeof a.name === "string"
    ? { automation: { id: a.id, name: a.name } }
    : {};
}
export function coerceMarker(entry: unknown): DurablePendingWakeMarker | null {
  if (typeof entry !== "object" || entry == null) return null;
  const e = entry as Record<string, unknown>;
  if (
    typeof e.agentId !== "string" ||
    !e.agentId ||
    typeof e.workId !== "string" ||
    !e.workId ||
    !PENDING_WAKE_KINDS.includes(e.kind as PendingWakeKind)
  )
    return null;
  const quietOrigin = coerceQuietOrigin(e.quietOrigin);
  return {
    agentId: e.agentId,
    kind: e.kind as PendingWakeKind,
    workId: e.workId,
    markedAtMs:
      typeof e.markedAtMs === "number" && Number.isFinite(e.markedAtMs)
        ? e.markedAtMs
        : 0,
    ...(quietOrigin != null ? { quietOrigin } : {}),
    ...(typeof e.title === "string" && e.title.length > 0
      ? { title: e.title }
      : {}),
    ...(typeof e.subagentType === "string" && e.subagentType.length > 0
      ? { subagentType: e.subagentType }
      : {}),
    ...(e.interruptedByRecreate === true
      ? { interruptedByRecreate: true }
      : {}),
  };
}
export function coercePendingWakeMarkers(
  value: unknown,
): DurablePendingWakeMarker[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const marker = coerceMarker(entry);
        return marker == null ? [] : [marker];
      })
    : [];
}
export function parsePendingWakeFile(
  raw: string | null,
): DurablePendingWakeMarker[] {
  if (raw == null) return [];
  try {
    const value = JSON.parse(raw) as { pending?: unknown };
    return typeof value === "object" && value != null
      ? coercePendingWakeMarkers(value.pending)
      : [];
  } catch {
    return [];
  }
}
export function markerKeyMatches(
  marker: DurablePendingWakeMarker,
  agentId: string,
  kind: PendingWakeKind,
  workId: string,
): boolean {
  return (
    marker.agentId === agentId &&
    marker.kind === kind &&
    marker.workId === workId
  );
}
export function upsertPendingWakeMarker(
  existing: readonly DurablePendingWakeMarker[],
  marker: DurablePendingWakeMarker,
): DurablePendingWakeMarker[] {
  return [
    ...existing.filter(
      (entry) =>
        !markerKeyMatches(entry, marker.agentId, marker.kind, marker.workId),
    ),
    marker,
  ];
}
export class SandPendingWakeStore {
  readonly filePath: string;
  constructor(rootDir: string) {
    this.filePath = join(rootDir, SAND_PENDING_WAKE_FILE_NAME);
  }
  markPending(marker: DurablePendingWakeMarker): boolean {
    try {
      this.write(upsertPendingWakeMarker(this.readPending(), marker));
      return true;
    } catch {
      return false;
    }
  }
  listPending(): DurablePendingWakeMarker[] {
    return this.readPending();
  }
  hasPending(agentId: string, kind: PendingWakeKind, workId: string): boolean {
    return this.readPending().some((entry) =>
      markerKeyMatches(entry, agentId, kind, workId),
    );
  }
  clearOne(agentId: string, kind: PendingWakeKind, workId: string): boolean {
    try {
      const existing = this.readPending(),
        remaining = existing.filter(
          (entry) => !markerKeyMatches(entry, agentId, kind, workId),
        );
      if (remaining.length === existing.length) return false;
      remaining.length === 0 ? this.deleteFile() : this.write(remaining);
      return true;
    } catch {
      return false;
    }
  }
  clearAgent(agentId: string): void {
    try {
      const existing = this.readPending(),
        remaining = existing.filter((entry) => entry.agentId !== agentId);
      if (remaining.length === existing.length) return;
      remaining.length === 0 ? this.deleteFile() : this.write(remaining);
    } catch {}
  }
  clearAll(): void {
    this.deleteFile();
  }
  pruneStale(maxAgeMs: number, nowMs = Date.now()): DurablePendingWakeMarker[] {
    try {
      const existing = this.readPending(),
        pruned = existing.filter(
          (entry) => nowMs - entry.markedAtMs > maxAgeMs,
        );
      if (pruned.length === 0) return [];
      const remaining = existing.filter(
        (entry) => nowMs - entry.markedAtMs <= maxAgeMs,
      );
      remaining.length === 0 ? this.deleteFile() : this.write(remaining);
      return pruned;
    } catch {
      return [];
    }
  }
  readPending(): DurablePendingWakeMarker[] {
    try {
      return parsePendingWakeFile(readFileSync(this.filePath, "utf8"));
    } catch {
      return [];
    }
  }
  write(pending: readonly DurablePendingWakeMarker[]): void {
    const part = `${this.filePath}.part`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
    } catch {}
    writeFileSync(part, JSON.stringify({ version: 1, pending }));
    renameSync(part, this.filePath);
  }
  deleteFile(): void {
    try {
      rmSync(this.filePath, { force: true });
    } catch {}
  }
}
