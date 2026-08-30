import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AGENT_STORE_CONFLICT_EVENTS_FILE_NAME,
  AGENT_STORE_CONFLICT_PENDING_FILE_NAME,
  AGENT_STORE_SYNC_DIR_NAME,
  ensureSecureDirectoryChain,
} from "./paths.js";

const CONFLICT_JOURNAL_ROTATE_BYTES = 4 * 1024 * 1024;
const MAX_DEDUP_ENTRIES = 65536;
const EVENT_SCHEMA_VERSION = 1;
const PRIVATE_FILE_MODE = 0o600;
const PENDING_FILE_MODE = 0o600;
const O_NOFOLLOW_FLAG = fs.constants.O_NOFOLLOW;

export type ConflictEventKind =
  | "write_conflict"
  | "create_conflict"
  | "truncate_conflict_failed"
  | "conflict_fallback_failed"
  | "gap";

export type PendingConflictEventKind = Exclude<ConflictEventKind, "gap">;

export interface ConflictJournalEmit {
  readonly kind: PendingConflictEventKind;
  readonly storeId: string;
  readonly originalRelPath: string;
  readonly conflictRelPath?: string | undefined;
  readonly originalAbsPath: string;
  readonly conflictAbsPath?: string | undefined;
  readonly preservedBytes?: number | undefined;
  readonly source?: "local_sync" | undefined;
  readonly remoteOnly?: boolean | undefined;
}

export interface ConflictJournalEvent {
  readonly v: number;
  readonly event_id: string;
  readonly journal_epoch: string;
  readonly seq: number;
  readonly ts_ms: number;
  readonly kind: ConflictEventKind;
  readonly store_id?: string | undefined;
  readonly original_rel_path?: string | undefined;
  readonly conflict_rel_path?: string | undefined;
  readonly original_abs_path?: string | undefined;
  readonly conflict_abs_path?: string | undefined;
  readonly preserved_bytes?: number | undefined;
  readonly source?: "local_sync" | undefined;
  readonly remote_only?: boolean | undefined;
}

export interface ConflictJournalWarningOptions {
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}

function sanitizeConflictJournalWarnError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return typeof error === "string" ? "<redacted>" : error;
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const redacted = new Error(code !== undefined ? `${error.name}: ${code}` : error.name);
  redacted.name = error.name;
  if (code !== undefined) {
    Object.defineProperty(redacted, "code", { value: code, enumerable: true, configurable: true, writable: true });
  }
  return redacted;
}

function wrapConflictJournalWarn(warn: (message: string, error: unknown) => void): (message: string, error: unknown) => void {
  return (message, error) => {
    warn(message, sanitizeConflictJournalWarnError(error));
  };
}

function nowMs(): number {
  return Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

const KNOWN_KINDS = new Set<ConflictEventKind>([
  "write_conflict",
  "create_conflict",
  "truncate_conflict_failed",
  "conflict_fallback_failed",
  "gap",
]);

function parseConflictEvent(raw: unknown): ConflictJournalEvent | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const eventId = asString(raw.event_id);
  const journalEpoch = asString(raw.journal_epoch);
  const kindRaw = asString(raw.kind);
  const seq = asNumber(raw.seq);
  const tsMs = asNumber(raw.ts_ms);
  const version = asNumber(raw.v);
  if (eventId === undefined || journalEpoch === undefined || kindRaw === undefined || seq === undefined || tsMs === undefined || version === undefined || !KNOWN_KINDS.has(kindRaw as ConflictEventKind)) {
    return undefined;
  }
  const kind = kindRaw as ConflictEventKind;
  const sourceRaw = asString(raw.source);
  const source = sourceRaw === "local_sync" ? "local_sync" : undefined;
  const remoteOnly = asBoolean(raw.remote_only);
  return {
    v: version,
    event_id: eventId,
    journal_epoch: journalEpoch,
    seq,
    ts_ms: tsMs,
    kind,
    store_id: asString(raw.store_id),
    original_rel_path: asString(raw.original_rel_path),
    conflict_rel_path: asString(raw.conflict_rel_path),
    original_abs_path: asString(raw.original_abs_path),
    conflict_abs_path: asString(raw.conflict_abs_path),
    preserved_bytes: asNumber(raw.preserved_bytes),
    ...(source === undefined ? {} : { source }),
    ...(remoteOnly === true ? { remote_only: true } : {}),
  };
}

function parseConflictJournalLines(body: string): ConflictJournalEvent[] {
  const out: ConflictJournalEvent[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    const event = parseConflictEvent(parsed);
    if (event !== undefined) {
      out.push(event);
    }
  }
  return out;
}

function eventToJsonLine(event: ConflictJournalEvent): string {
  const row: Record<string, unknown> = {
    v: event.v,
    event_id: event.event_id,
    journal_epoch: event.journal_epoch,
    seq: event.seq,
    ts_ms: event.ts_ms,
    kind: event.kind,
  };
  if (event.store_id !== undefined) row.store_id = event.store_id;
  if (event.original_rel_path !== undefined) row.original_rel_path = event.original_rel_path;
  if (event.conflict_rel_path !== undefined) row.conflict_rel_path = event.conflict_rel_path;
  if (event.original_abs_path !== undefined) row.original_abs_path = event.original_abs_path;
  if (event.conflict_abs_path !== undefined) row.conflict_abs_path = event.conflict_abs_path;
  if (event.preserved_bytes !== undefined) row.preserved_bytes = event.preserved_bytes;
  if (event.source !== undefined) row.source = event.source;
  if (event.remote_only === true) row.remote_only = true;
  return `${JSON.stringify(row)}\n`;
}

function dedupKeyFor(emit: ConflictJournalEmit): string | undefined {
  if (emit.conflictRelPath !== undefined) return `${emit.storeId}\0${emit.conflictRelPath}`;
  if (emit.kind === "truncate_conflict_failed") return `${emit.storeId}\0\0truncate:${emit.originalRelPath}`;
  if (emit.kind === "conflict_fallback_failed") return `${emit.storeId}\0\0fallback:${emit.originalRelPath}`;
  return undefined;
}

function dedupKeyForEvent(event: ConflictJournalEvent): string | undefined {
  if (event.store_id === undefined) return undefined;
  if (event.conflict_rel_path !== undefined) return `${event.store_id}\0${event.conflict_rel_path}`;
  if (event.original_rel_path === undefined) return undefined;
  if (event.kind === "truncate_conflict_failed") return `${event.store_id}\0\0truncate:${event.original_rel_path}`;
  if (event.kind === "conflict_fallback_failed") return `${event.store_id}\0\0fallback:${event.original_rel_path}`;
  return undefined;
}

function pendingConflictEmitKey(emit: ConflictJournalEmit): string {
  return [emit.storeId, emit.kind, emit.originalRelPath, emit.conflictRelPath ?? ""].join("\0");
}

const PENDING_EMIT_KINDS = new Set<PendingConflictEventKind>([
  "write_conflict",
  "create_conflict",
  "truncate_conflict_failed",
  "conflict_fallback_failed",
]);

function parsePendingConflictEmit(raw: unknown): ConflictJournalEmit | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = asString(raw.kind);
  const storeId = asString(raw.storeId);
  const originalRelPath = asString(raw.originalRelPath);
  const originalAbsPath = asString(raw.originalAbsPath);
  if (kind === undefined || storeId === undefined || originalRelPath === undefined || originalAbsPath === undefined || !PENDING_EMIT_KINDS.has(kind as PendingConflictEventKind)) {
    return undefined;
  }
  const sourceRaw = asString(raw.source);
  const remoteOnly = asBoolean(raw.remoteOnly);
  return {
    kind: kind as PendingConflictEventKind,
    storeId,
    originalRelPath,
    conflictRelPath: asString(raw.conflictRelPath),
    originalAbsPath,
    conflictAbsPath: asString(raw.conflictAbsPath),
    preservedBytes: asNumber(raw.preservedBytes),
    ...(sourceRaw === "local_sync" ? { source: "local_sync" } : {}),
    ...(remoteOnly === true ? { remoteOnly: true } : {}),
  };
}

function pendingEmitToJsonLine(emit: ConflictJournalEmit): string {
  const row: Record<string, unknown> = {
    kind: emit.kind,
    storeId: emit.storeId,
    originalRelPath: emit.originalRelPath,
    originalAbsPath: emit.originalAbsPath,
  };
  if (emit.conflictRelPath !== undefined) row.conflictRelPath = emit.conflictRelPath;
  if (emit.conflictAbsPath !== undefined) row.conflictAbsPath = emit.conflictAbsPath;
  if (emit.preservedBytes !== undefined) row.preservedBytes = emit.preservedBytes;
  if (emit.source !== undefined) row.source = emit.source;
  if (emit.remoteOnly === true) row.remoteOnly = true;
  return `${JSON.stringify(row)}\n`;
}

interface OpenOptions {
  readonly baseFlags: number;
  readonly mode: number;
  readonly nofollowFlag?: number | undefined;
}

function openNoFollowSync(targetPath: string, options: OpenOptions): number {
  const { baseFlags, mode, nofollowFlag } = options;
  if (typeof nofollowFlag === "number") return fs.openSync(targetPath, baseFlags | nofollowFlag, mode);
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(targetPath);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  if (existing?.isSymbolicLink() === true) {
    const refusal = new Error(`refusing to open symlinked journal path: ${targetPath}`);
    Object.defineProperty(refusal, "code", { value: "ELOOP", enumerable: true, configurable: true, writable: true });
    throw refusal;
  }
  return fs.openSync(targetPath, baseFlags, mode);
}

function readFileNoFollowSync(targetPath: string): string {
  const fd = openNoFollowSync(targetPath, { baseFlags: fs.constants.O_RDONLY, mode: PRIVATE_FILE_MODE, nofollowFlag: O_NOFOLLOW_FLAG });
  try {
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export class ConflictJournal {
  readonly path: string;
  private readonly epoch: string;
  private readonly warn: (message: string, error: unknown) => void;
  private nextSeq = 1;
  private appendFailures = 0;
  private rotations = 0;
  private readonly emittedConflicts = new Set<string>();

  constructor(journalPath: string, options?: ConflictJournalWarningOptions) {
    this.path = journalPath;
    this.epoch = randomUUID();
    this.warn = wrapConflictJournalWarn(options?.warn ?? (() => {}));
    this.hydrateDedupFromDisk();
  }

  private hydrateDedupFromDisk(): void {
    const keys = this.readDedupKeysFromDisk();
    if (keys === undefined) return;
    this.replaceDedupKeys(keys);
  }

  private readDedupKeysFromDisk(): string[] | undefined {
    let body: string;
    try {
      body = readFileNoFollowSync(this.path);
    } catch (error) {
      if (!isEnoent(error)) {
        this.warn("conflict journal dedup hydrate failed", error);
        return undefined;
      }
      return [];
    }
    const keys: string[] = [];
    for (const event of parseConflictJournalLines(body)) {
      const key = dedupKeyForEvent(event);
      if (key !== undefined) keys.push(key);
    }
    return keys;
  }

  private replaceDedupKeys(keys: readonly string[]): void {
    this.emittedConflicts.clear();
    for (const key of keys) {
      if (this.emittedConflicts.size >= MAX_DEDUP_ENTRIES) this.emittedConflicts.clear();
      this.emittedConflicts.add(key);
    }
  }

  refreshDedupFromDisk(): boolean {
    const keys = this.readDedupKeysFromDisk();
    if (keys === undefined) return false;
    this.replaceDedupKeys(keys);
    return true;
  }

  appendFailureCount(): number { return this.appendFailures; }
  rotationCount(): number { return this.rotations; }

  wouldDedup(emit: ConflictJournalEmit): boolean {
    const key = dedupKeyFor(emit);
    return key !== undefined && this.emittedConflicts.has(key);
  }

  emit(emit: ConflictJournalEmit): boolean {
    const key = dedupKeyFor(emit);
    if (key !== undefined && this.emittedConflicts.has(key)) return true;
    try {
      this.appendEmit(emit, key);
      return true;
    } catch (error) {
      this.appendFailures += 1;
      this.warn(`conflict journal append failed; sync round still succeeded (failures=${this.appendFailures})`, error);
      return false;
    }
  }

  private appendEmit(emit: ConflictJournalEmit, key: string | undefined): void {
    if (key !== undefined && this.emittedConflicts.has(key)) return;
    const parent = path.dirname(this.path);
    if (parent.length > 0) ensureSecureDirectoryChain(parent);
    this.maybeRotateLocked();
    const seq = this.nextSeq;
    const event: ConflictJournalEvent = {
      v: EVENT_SCHEMA_VERSION,
      event_id: randomUUID(),
      journal_epoch: this.epoch,
      seq,
      ts_ms: nowMs(),
      kind: emit.kind,
      store_id: emit.storeId,
      original_rel_path: emit.originalRelPath,
      conflict_rel_path: emit.conflictRelPath,
      original_abs_path: emit.originalAbsPath,
      conflict_abs_path: emit.conflictAbsPath,
      preserved_bytes: emit.preservedBytes,
      ...(emit.source === undefined ? {} : { source: emit.source }),
      ...(emit.remoteOnly === true ? { remote_only: true } : {}),
    };
    this.writeJsonlLine(event);
    this.nextSeq = seq + 1;
    if (key !== undefined) {
      if (this.emittedConflicts.size >= MAX_DEDUP_ENTRIES) this.emittedConflicts.clear();
      this.emittedConflicts.add(key);
    }
  }

  private writeJsonlLine(event: ConflictJournalEvent): void {
    const fd = openNoFollowSync(this.path, { baseFlags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, mode: PRIVATE_FILE_MODE, nofollowFlag: O_NOFOLLOW_FLAG });
    try {
      try { fs.fchmodSync(fd, PRIVATE_FILE_MODE); } catch {}
      fs.writeSync(fd, eventToJsonLine(event));
      try { fs.fsyncSync(fd); } catch {}
    } finally {
      fs.closeSync(fd);
    }
  }

  private maybeRotateLocked(): void {
    let size: number;
    try {
      size = fs.statSync(this.path).size;
    } catch (error) {
      if (isEnoent(error)) return;
      this.warn("conflict journal metadata failed; skipping rotate", error);
      return;
    }
    if (size < CONFLICT_JOURNAL_ROTATE_BYTES) return;
    try {
      this.forceGapRewriteLocked();
    } catch (error) {
      this.warn("conflict journal rotate rewrite failed; appending onto oversized journal", error);
    }
  }

  private forceGapRewriteLocked(): void {
    const seq = this.nextSeq;
    const gap: ConflictJournalEvent = {
      v: EVENT_SCHEMA_VERSION,
      event_id: randomUUID(),
      journal_epoch: this.epoch,
      seq,
      ts_ms: nowMs(),
      kind: "gap",
    };
    const tmp = `${this.path}.rotate-tmp`;
    try {
      fs.unlinkSync(tmp);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    const fd = openNoFollowSync(tmp, { baseFlags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode: PRIVATE_FILE_MODE, nofollowFlag: O_NOFOLLOW_FLAG });
    try {
      try { fs.fchmodSync(fd, PRIVATE_FILE_MODE); } catch {}
      fs.writeSync(fd, eventToJsonLine(gap));
      try { fs.fsyncSync(fd); } catch {}
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.path);
    this.nextSeq = seq + 1;
    this.emittedConflicts.clear();
    this.rotations += 1;
  }
}

export function conflictJournalPathForFilesDir(filesDir: string): string {
  return path.join(path.dirname(path.resolve(filesDir)), AGENT_STORE_SYNC_DIR_NAME, AGENT_STORE_CONFLICT_EVENTS_FILE_NAME);
}

export function conflictPendingJournalPathForFilesDir(filesDir: string): string {
  return path.join(path.dirname(path.resolve(filesDir)), AGENT_STORE_SYNC_DIR_NAME, AGENT_STORE_CONFLICT_PENDING_FILE_NAME);
}

interface PendingDiskState {
  readonly pending: ConflictJournalEmit[];
  readonly keys: Set<string>;
}

export class PendingConflictJournal {
  readonly path: string;
  private readonly warn: (message: string, error: unknown) => void;
  private pending: ConflictJournalEmit[] = [];
  private keys = new Set<string>();
  private persistFailures = 0;
  private dirty = false;
  private loadFailed = false;

  constructor(pendingPath: string, options?: ConflictJournalWarningOptions) {
    this.path = pendingPath;
    this.warn = wrapConflictJournalWarn(options?.warn ?? (() => {}));
    const loaded = this.tryReadDisk();
    if (loaded !== undefined) {
      this.pending = loaded.pending;
      this.keys = loaded.keys;
    } else {
      this.loadFailed = true;
    }
  }

  size(): number { return this.pending.length; }
  isEmpty(): boolean { return this.pending.length === 0; }
  list(): ConflictJournalEmit[] { return [...this.pending]; }
  persistFailureCount(): number { return this.persistFailures; }

  reload(): void {
    const loaded = this.tryReadDisk();
    if (loaded === undefined) return;
    this.loadFailed = false;
    if (!this.dirty) {
      this.pending = loaded.pending;
      this.keys = loaded.keys;
      return;
    }
    const mergedByKey = new Map<string, ConflictJournalEmit>();
    for (const emit of loaded.pending) mergedByKey.set(pendingConflictEmitKey(emit), emit);
    for (const emit of this.pending) mergedByKey.set(pendingConflictEmitKey(emit), emit);
    const merged = [...mergedByKey.values()];
    this.pending = merged;
    this.keys = new Set(mergedByKey.keys());
    this.dirty = !this.persistPending(merged);
  }

  enqueue(emit: ConflictJournalEmit): void {
    const key = pendingConflictEmitKey(emit);
    if (this.keys.has(key)) {
      if (this.dirty || this.loadFailed) this.dirty = !this.persistPending(this.pending);
      return;
    }
    this.keys.add(key);
    this.pending.push(emit);
    this.dirty = !this.persistPending(this.pending);
  }

  replaceAll(emits: readonly ConflictJournalEmit[]): void {
    const next: ConflictJournalEmit[] = [];
    const nextKeys = new Set<string>();
    for (const emit of emits) {
      const key = pendingConflictEmitKey(emit);
      if (nextKeys.has(key)) continue;
      nextKeys.add(key);
      next.push(emit);
    }
    const recoveringLoad = this.loadFailed;
    if (this.persistPending(next)) {
      if (!recoveringLoad) {
        this.pending = next;
        this.keys = nextKeys;
      }
      this.dirty = false;
    }
  }

  private tryReadDisk(): PendingDiskState | undefined {
    let body: string;
    try {
      body = readFileNoFollowSync(this.path);
    } catch (error) {
      if (isEnoent(error)) return { pending: [], keys: new Set() };
      this.warn("conflict pending journal load failed", error);
      return undefined;
    }
    const pending: ConflictJournalEmit[] = [];
    const keys = new Set<string>();
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(trimmed) as unknown; } catch { continue; }
      const emit = parsePendingConflictEmit(parsed);
      if (emit === undefined) continue;
      const key = pendingConflictEmitKey(emit);
      if (keys.has(key)) continue;
      keys.add(key);
      pending.push(emit);
    }
    return { pending, keys };
  }

  private persistPending(pending: readonly ConflictJournalEmit[]): boolean {
    if (this.loadFailed) {
      const loaded = this.tryReadDisk();
      if (loaded === undefined) {
        this.persistFailures += 1;
        this.warn(`conflict pending journal persist skipped; sidecar still unreadable (failures=${this.persistFailures})`, undefined);
        return false;
      }
      this.loadFailed = false;
      const mergedByKey = new Map<string, ConflictJournalEmit>();
      for (const emit of loaded.pending) mergedByKey.set(pendingConflictEmitKey(emit), emit);
      for (const emit of pending) mergedByKey.set(pendingConflictEmitKey(emit), emit);
      const merged = [...mergedByKey.values()];
      this.pending = merged;
      this.keys = new Set(mergedByKey.keys());
      return this.persistPending(merged);
    }
    try {
      if (pending.length === 0) {
        this.removeFile();
        return true;
      }
      const parent = path.dirname(this.path);
      if (parent.length > 0) ensureSecureDirectoryChain(parent);
      this.atomicRewrite(pending.map(pendingEmitToJsonLine).join(""));
      return true;
    } catch (error) {
      this.persistFailures += 1;
      this.warn(`conflict pending journal persist failed (failures=${this.persistFailures})`, error);
      return false;
    }
  }

  private atomicRewrite(body: string): void {
    const tmp = `${this.path}.pending-tmp`;
    try {
      fs.unlinkSync(tmp);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    const fd = openNoFollowSync(tmp, { baseFlags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode: PENDING_FILE_MODE, nofollowFlag: O_NOFOLLOW_FLAG });
    try {
      try { fs.fchmodSync(fd, PENDING_FILE_MODE); } catch {}
      fs.writeSync(fd, body);
      try { fs.fsyncSync(fd); } catch {}
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.path);
  }

  private removeFile(): void {
    try {
      fs.unlinkSync(this.path);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
