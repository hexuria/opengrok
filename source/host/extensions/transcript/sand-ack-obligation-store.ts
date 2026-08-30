import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SAND_ACK_OBLIGATIONS_FILE_NAME } from "../../durable-file-policy.js";
export interface AckObligation {
  agentId: string;
  createdAtMs: number;
  lastSendAtMs: number;
  lastInterruptAtMs?: number;
  coalescedCount: number;
  redriveAttempts: number;
}
export function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
export function coerceObligation(entry: unknown): AckObligation | null {
  if (typeof entry !== "object" || entry == null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.agentId !== "string" || !e.agentId) return null;
  const createdAtMs = finiteNumber(e.createdAtMs, 0);
  return {
    agentId: e.agentId,
    createdAtMs,
    lastSendAtMs: finiteNumber(e.lastSendAtMs, createdAtMs),
    ...(typeof e.lastInterruptAtMs === "number" &&
    Number.isFinite(e.lastInterruptAtMs)
      ? { lastInterruptAtMs: e.lastInterruptAtMs }
      : {}),
    coalescedCount: Math.max(1, finiteNumber(e.coalescedCount, 1)),
    redriveAttempts: Math.max(0, finiteNumber(e.redriveAttempts, 0)),
  };
}
export function parseAckObligationsFile(raw: string | null): AckObligation[] {
  if (raw == null) return [];
  try {
    const value = JSON.parse(raw) as { pending?: unknown };
    return typeof value === "object" &&
      value != null &&
      Array.isArray(value.pending)
      ? value.pending.flatMap((entry) => {
          const obligation = coerceObligation(entry);
          return obligation == null ? [] : [obligation];
        })
      : [];
  } catch {
    return [];
  }
}
export class SandAckObligationStore {
  readonly filePath: string;
  private cache: AckObligation[] | null = null;
  constructor(rootDir: string) {
    this.filePath = join(rootDir, SAND_ACK_OBLIGATIONS_FILE_NAME);
  }
  get(agentId: string): AckObligation | undefined {
    return this.readPending().find((entry) => entry.agentId === agentId);
  }
  list(): AckObligation[] {
    return this.readPending();
  }
  recordSend(
    agentId: string,
    send: { atMs: number },
  ): { obligation: AckObligation; created: boolean } {
    const existing = this.get(agentId),
      obligation =
        existing == null
          ? {
              agentId,
              createdAtMs: send.atMs,
              lastSendAtMs: send.atMs,
              coalescedCount: 1,
              redriveAttempts: 0,
            }
          : {
              ...existing,
              lastSendAtMs: send.atMs,
              coalescedCount: existing.coalescedCount + 1,
            };
    this.upsert(obligation);
    return { obligation, created: existing == null };
  }
  recordInterrupt(agentId: string, atMs: number): void {
    const existing = this.get(agentId);
    if (existing != null) this.upsert({ ...existing, lastInterruptAtMs: atMs });
  }
  recordRedriveAttempt(agentId: string): AckObligation | undefined {
    const existing = this.get(agentId);
    if (existing == null) return undefined;
    const next = { ...existing, redriveAttempts: existing.redriveAttempts + 1 };
    this.upsert(next);
    return next;
  }
  clear(agentId: string): void {
    try {
      const current = this.readPending(),
        remaining = current.filter((entry) => entry.agentId !== agentId);
      if (remaining.length !== current.length) this.write(remaining);
    } catch {}
  }
  upsert(obligation: AckObligation): void {
    try {
      this.write([
        ...this.readPending().filter(
          (entry) => entry.agentId !== obligation.agentId,
        ),
        obligation,
      ]);
    } catch {}
  }
  readPending(): AckObligation[] {
    if (this.cache != null) return this.cache;
    try {
      this.cache = parseAckObligationsFile(readFileSync(this.filePath, "utf8"));
    } catch {
      this.cache = [];
    }
    return this.cache;
  }
  write(pending: readonly AckObligation[]): void {
    const part = `${this.filePath}.part`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
    } catch {}
    writeFileSync(part, JSON.stringify({ version: 1, pending }));
    renameSync(part, this.filePath);
    this.cache = [...pending];
  }
}
