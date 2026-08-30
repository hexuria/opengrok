import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
export const NONCE_DIGEST_MISMATCH = "NONCE_DIGEST_MISMATCH";
export const SAND_SEND_ACCEPTANCE_FILE_NAME = "send-acceptance.json";
export const MAX_RECORDS = 256;
export const MAX_DEGRADED_WINDOWS = 8;
export class PromptAcceptanceRejectedError extends Error {}
export class PromptAcceptanceDigestMismatchError extends Error {
  readonly code = NONCE_DIGEST_MISMATCH;
  constructor(clientNonce: string) {
    super(
      `${NONCE_DIGEST_MISMATCH}: clientNonce ${clientNonce} was already accepted with a different input digest`,
    );
    this.name = "PromptAcceptanceDigestMismatchError";
  }
}
export interface SendInput {
  agentId?: string;
  prompt: string;
  richText?: string;
  replyToId?: string;
  isFork?: boolean;
  attachmentPaths?: readonly string[];
  attachmentNames?: readonly string[];
}
export function canonicalSendInput(input: SendInput): string {
  return JSON.stringify([
    input.agentId ?? null,
    input.prompt,
    input.richText ?? null,
    input.replyToId ?? null,
    input.isFork === true,
    [...(input.attachmentPaths ?? [])],
    [...(input.attachmentNames ?? [])],
  ]);
}
export function sendInputDigest(input: SendInput): string {
  return createHash("sha256")
    .update(canonicalSendInput(input), "utf8")
    .digest("hex");
}
export interface AcceptanceRecord {
  accountSlot: string;
  clientNonce: string;
  inputDigest: string;
  status: "accepted" | "rejected" | "pending";
  acceptedAtMs: number;
  agentId: string;
  echoEntryId: string | null;
  rejectionCode: string | null;
}
export interface AcceptanceGaps {
  evictionHorizonMs: number | null;
  degradedWindows: Array<{ fromMs: number; toMs: number }>;
  corruptResetAtMs: number | null;
}
export const EMPTY_GAPS: AcceptanceGaps = {
  evictionHorizonMs: null,
  degradedWindows: [],
  corruptResetAtMs: null,
};
export const STATUSES = ["accepted", "rejected", "pending"] as const;
export function withEvictionHorizon(
  gaps: AcceptanceGaps | null,
  acceptedAtMs: number,
): AcceptanceGaps {
  const base = gaps ?? EMPTY_GAPS;
  return {
    ...base,
    evictionHorizonMs: Math.max(
      base.evictionHorizonMs ?? acceptedAtMs,
      acceptedAtMs,
    ),
  };
}
export function withDegradedWindow(
  gaps: AcceptanceGaps | null,
  window: { fromMs: number; toMs: number },
): AcceptanceGaps {
  const base = gaps ?? EMPTY_GAPS;
  if (base.degradedWindows.length >= MAX_DEGRADED_WINDOWS) {
    const kept = base.degradedWindows.slice(0, -1),
      last = base.degradedWindows.at(-1) ?? window;
    return {
      ...base,
      degradedWindows: [
        ...kept,
        {
          fromMs: Math.min(last.fromMs, window.fromMs),
          toMs: Math.max(last.toMs, window.toMs),
        },
      ],
    };
  }
  return { ...base, degradedWindows: [...base.degradedWindows, window] };
}
export function withCorruptReset(
  gaps: AcceptanceGaps | null,
  atMs: number,
): AcceptanceGaps {
  const base = gaps ?? EMPTY_GAPS;
  return {
    ...base,
    corruptResetAtMs: Math.max(base.corruptResetAtMs ?? atMs, atMs),
  };
}
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
export function coerceAcceptanceRecord(
  entry: unknown,
): AcceptanceRecord | null {
  if (typeof entry !== "object" || entry == null) return null;
  const e = entry as Record<string, unknown>;
  if (
    typeof e.accountSlot !== "string" ||
    !e.accountSlot ||
    typeof e.clientNonce !== "string" ||
    !e.clientNonce ||
    typeof e.inputDigest !== "string" ||
    !e.inputDigest ||
    typeof e.agentId !== "string" ||
    !["accepted", "rejected", "pending"].includes(String(e.status)) ||
    !isFiniteNumber(e.acceptedAtMs)
  )
    return null;
  return {
    accountSlot: e.accountSlot,
    clientNonce: e.clientNonce,
    inputDigest: e.inputDigest,
    status: e.status as AcceptanceRecord["status"],
    acceptedAtMs: e.acceptedAtMs,
    agentId: e.agentId,
    echoEntryId: typeof e.echoEntryId === "string" ? e.echoEntryId : null,
    rejectionCode: typeof e.rejectionCode === "string" ? e.rejectionCode : null,
  };
}
export const coerceRecord = coerceAcceptanceRecord;
export function coerceGaps(
  value: unknown,
): AcceptanceGaps | "malformed" | null {
  if (value == null) return null;
  if (typeof value !== "object") return "malformed";
  const v = value as Record<string, unknown>,
    horizon = v.evictionHorizonMs ?? null,
    reset = v.corruptResetAtMs ?? null;
  if (
    (horizon !== null && !isFiniteNumber(horizon)) ||
    (reset !== null && !isFiniteNumber(reset)) ||
    !Array.isArray(v.degradedWindows)
  )
    return "malformed";
  const windows: Array<{ fromMs: number; toMs: number }> = [];
  for (const entry of v.degradedWindows) {
    if (typeof entry !== "object" || entry == null) return "malformed";
    const w = entry as Record<string, unknown>;
    if (!isFiniteNumber(w.fromMs) || !isFiniteNumber(w.toMs))
      return "malformed";
    windows.push({ fromMs: w.fromMs, toMs: w.toMs });
  }
  return {
    evictionHorizonMs: horizon as number | null,
    degradedWindows: windows,
    corruptResetAtMs: reset as number | null,
  };
}
export function parseSendAcceptanceFile(raw: string | null): {
  records: AcceptanceRecord[];
  gaps: AcceptanceGaps | null;
  damaged: boolean;
} {
  if (raw == null) return { records: [], gaps: null, damaged: false };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { records: [], gaps: null, damaged: true };
  }
  if (
    typeof value !== "object" ||
    value == null ||
    !Array.isArray((value as { records?: unknown }).records)
  )
    return { records: [], gaps: null, damaged: true };
  let damaged = false;
  const records = (value as { records: unknown[] }).records.flatMap((entry) => {
      const record = coerceAcceptanceRecord(entry);
      if (record == null) damaged = true;
      return record == null ? [] : [record];
    }),
    gaps = coerceGaps((value as { historyGaps?: unknown }).historyGaps);
  return gaps === "malformed"
    ? { records, gaps: null, damaged: true }
    : { records, gaps, damaged };
}
export function recordKey(accountSlot: string, clientNonce: string): string {
  return `${accountSlot}\0${clientNonce}`;
}
interface Loaded {
  records: Map<string, AcceptanceRecord>;
  gaps: AcceptanceGaps | null;
}
export class PromptAcceptanceLedger {
  readonly filePath: string | null;
  private loaded: Loaded | null = null;
  private readonly nowMs: () => number;
  private degradedSinceMs: number | null = null;
  private markerMayExist = false;
  constructor(rootDir: string | null, nowMs: () => number = Date.now) {
    this.nowMs = nowMs;
    this.filePath =
      rootDir == null ? null : join(rootDir, SAND_SEND_ACCEPTANCE_FILE_NAME);
  }
  dispose(): void {
    this.persist();
  }
  lookup(args: {
    accountSlot: string;
    clientNonce: string;
  }):
    | { outcome: "found"; record: AcceptanceRecord }
    | { outcome: "unknown-durability" | "not-found" } {
    const record = this.load().records.get(
      recordKey(args.accountSlot, args.clientNonce),
    );
    return record != null
      ? { outcome: "found", record }
      : this.load().gaps != null || this.degradedSinceMs != null
        ? { outcome: "unknown-durability" }
        : { outcome: "not-found" };
  }
  admitSend(args: {
    accountSlot: string;
    clientNonce: string;
    inputDigest: string;
  }): { kind: "dispatch" } | { kind: "duplicate"; record: AcceptanceRecord } {
    const found = this.lookup(args);
    if (found.outcome !== "found") return { kind: "dispatch" };
    if (found.record.inputDigest !== args.inputDigest)
      throw new PromptAcceptanceDigestMismatchError(args.clientNonce);
    if (found.record.status === "rejected")
      throw new PromptAcceptanceRejectedError(
        `send rejected: ${found.record.rejectionCode ?? "unknown"} (replaying the nonce's original outcome)`,
      );
    return { kind: "duplicate", record: found.record };
  }
  recordPending(
    input: Omit<AcceptanceRecord, "status" | "acceptedAtMs" | "rejectionCode">,
  ): AcceptanceRecord {
    const key = recordKey(input.accountSlot, input.clientNonce),
      existing = this.load().records.get(key);
    if (existing != null) {
      if (existing.inputDigest !== input.inputDigest)
        throw new PromptAcceptanceDigestMismatchError(input.clientNonce);
      return existing;
    }
    const record: AcceptanceRecord = {
      ...input,
      status: "pending",
      acceptedAtMs: this.nowMs(),
      rejectionCode: null,
    };
    this.load().records.set(key, record);
    this.evictPastCap();
    this.persist();
    return record;
  }
  markAccepted(args: { accountSlot: string; clientNonce: string }): void {
    const key = recordKey(args.accountSlot, args.clientNonce),
      existing = this.load().records.get(key);
    if (existing?.status === "pending") {
      this.load().records.set(key, { ...existing, status: "accepted" });
      this.persist();
    }
  }
  markRejected(args: {
    accountSlot: string;
    clientNonce: string;
    rejectionCode: string;
  }): void {
    const key = recordKey(args.accountSlot, args.clientNonce),
      existing = this.load().records.get(key);
    if (existing?.status === "pending") {
      this.load().records.set(key, {
        ...existing,
        status: "rejected",
        rejectionCode: args.rejectionCode,
      });
      this.persist();
    }
  }
  clear(args: { accountSlot: string; clientNonce: string }): void {
    if (
      this.load().records.delete(recordKey(args.accountSlot, args.clientNonce))
    )
      this.persist();
  }
  clearUnlessAccepted(args: {
    accountSlot: string;
    clientNonce: string;
  }): void {
    if (
      this.load().records.get(recordKey(args.accountSlot, args.clientNonce))
        ?.status !== "accepted"
    )
      this.clear(args);
  }
  evictPastCap(): void {
    const loaded = this.load();
    if (loaded.records.size <= MAX_RECORDS) return;
    let pending: string | null = null,
      completed: string | null = null;
    for (const [key, record] of loaded.records) {
      if (record.status === "pending") pending ??= key;
      else {
        completed ??= key;
        break;
      }
    }
    const key = completed ?? pending;
    if (key == null) return;
    const record = loaded.records.get(key);
    loaded.records.delete(key);
    if (record != null)
      loaded.gaps = withEvictionHorizon(loaded.gaps, record.acceptedAtMs);
  }
  markerPath(): string | null {
    return this.filePath == null ? null : `${this.filePath}.degraded`;
  }
  private load(): Loaded {
    if (this.loaded != null) return this.loaded;
    let raw: string | null = null;
    if (this.filePath != null)
      try {
        raw = readFileSync(this.filePath, "utf8");
      } catch {}
    const parsed = parseSendAcceptanceFile(raw);
    let gaps = parsed.gaps;
    if (parsed.damaged && this.filePath != null) {
      try {
        copyFileSync(this.filePath, `${this.filePath}.corrupt-${this.nowMs()}`);
      } catch {}
      gaps = withCorruptReset(gaps, this.nowMs());
    }
    const marker = this.readDegradedMarker();
    if (marker != null) {
      gaps = withDegradedWindow(gaps, { fromMs: marker, toMs: this.nowMs() });
      this.markerMayExist = true;
    }
    this.loaded = {
      records: new Map(
        parsed.records.map((record) => [
          recordKey(record.accountSlot, record.clientNonce),
          record,
        ]),
      ),
      gaps,
    };
    if (parsed.damaged || marker != null) this.persist();
    return this.loaded;
  }
  private readDegradedMarker(): number | null {
    const path = this.markerPath();
    if (path == null) return null;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as {
        sinceMs?: unknown;
      };
      return isFiniteNumber(value.sinceMs) ? value.sinceMs : 0;
    } catch {
      return null;
    }
  }
  private persist(): void {
    if (this.filePath == null || this.loaded == null) return;
    const now = this.nowMs(),
      gaps =
        this.degradedSinceMs == null
          ? this.loaded.gaps
          : withDegradedWindow(this.loaded.gaps, {
              fromMs: this.degradedSinceMs,
              toMs: now,
            }),
      part = `${this.filePath}.part`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(
        part,
        JSON.stringify({
          version: 1,
          records: [...this.loaded.records.values()],
          ...(gaps == null ? {} : { historyGaps: gaps }),
        }),
      );
      renameSync(part, this.filePath);
    } catch {
      this.degradedSinceMs ??= now;
      const marker = this.markerPath();
      if (!this.markerMayExist && marker != null)
        try {
          writeFileSync(
            marker,
            JSON.stringify({ version: 1, sinceMs: this.degradedSinceMs }),
          );
          this.markerMayExist = true;
        } catch {}
      return;
    }
    this.loaded.gaps = gaps;
    this.degradedSinceMs = null;
    const marker = this.markerPath();
    if (this.markerMayExist && marker != null)
      try {
        rmSync(marker, { force: true });
        this.markerMayExist = false;
      } catch {}
  }
}
