import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../../shared/node/atomic-write.js";
import { findSystemErrno } from "../../../shared/system-errno.js";
import { errorLogTag } from "../../../shared/errors.js";
import {
  SAND_BOX_BOOT_FAILURE_REASONS,
  SAND_BOX_BOOT_FAILURE_STAGES,
  SAND_BOX_BOOT_STAGES,
  SAND_COOKIE_PERSIST_OUTCOMES,
  SAND_COOKIE_PERSIST_PHASES,
  SAND_EGRESS_TUNNEL_OUTCOMES,
  SAND_EXEC_DAEMON_RESTART_CAUSES,
  SAND_HOST_BOOT_FETCH_OUTCOMES,
  SAND_HOST_BOOT_FETCH_REASONS,
  SAND_PROCESS_CRASH_BINARIES,
  SAND_PROCESS_CRASH_SIGNALS,
  SAND_SUPERVISOR_RESTART_CAUSES,
} from "../../ports/telemetry.js";

export const DEFAULT_LOG_DIR = "/tmp",
  BOX_LOG_SHIP_INTERVAL_MS = 2_000,
  BOX_LOG_SHIP_PROGRESS_INTERVAL_MS = 5 * 60_000,
  DEFAULT_MAX_BYTES_PER_READ = 256 * 1024,
  DEFAULT_MAX_LINES_PER_POLL = 1_000,
  DEFAULT_MAX_LAG_BYTES = 16 * 1024 * 1024,
  DEFAULT_MAX_LINE_BYTES = 64 * 1024,
  OFFSETS_FILE_NAME = "sand-log-shipper.offsets.json",
  LOG_SUFFIX = ".log",
  BOX_TELEMETRY_SOURCE = "sand-box-telemetry",
  NEWLINE = 10;
export const DEFAULT_SUBDIR_PATTERN = /^sand-window-/;
export const DEFAULT_EXCLUDED_SOURCE_PREFIXES = [
  "sand-notify-injector",
] as const;
type Settlement = "delivered" | "dropped";
type LogRecord = { kind: "log"; source: string; line: string };
const offsetsSchema = z.record(z.string(), z.number().nonnegative());

const boxInfrastructureEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("boot_stage"),
    stage: z.enum(SAND_BOX_BOOT_STAGES),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("boot_failure"),
    stage: z.enum(SAND_BOX_BOOT_FAILURE_STAGES),
    reason: z.enum(SAND_BOX_BOOT_FAILURE_REASONS),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("egress_tunnel"),
    outcome: z.enum(SAND_EGRESS_TUNNEL_OUTCOMES),
    attempt: z.number().int().positive(),
    exitStatus: z.number().int().optional(),
    runtimeS: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("host_boot_fetch"),
    outcome: z.enum(SAND_HOST_BOOT_FETCH_OUTCOMES),
    reason: z.enum(SAND_HOST_BOOT_FETCH_REASONS),
    durationMs: z.number().int().nonnegative(),
    swapMs: z.number().int().nonnegative().optional(),
    fromVersion: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/)
      .optional(),
    toVersion: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/)
      .optional(),
  }),
  z.object({
    kind: z.literal("exec_daemon_restart"),
    restartAttempt: z.number().int().positive(),
    runtimeS: z.number().int().nonnegative(),
    cause: z.enum(SAND_EXEC_DAEMON_RESTART_CAUSES),
    exitStatus: z.number().int(),
  }),
  z.object({
    kind: z.literal("supervisor_restart"),
    restartAttempt: z.number().int().positive(),
    runtimeS: z.number().int().nonnegative(),
    cause: z.enum(SAND_SUPERVISOR_RESTART_CAUSES),
    exitStatus: z.number().int(),
  }),
  z.object({
    kind: z.literal("cookie_persist"),
    phase: z.enum(SAND_COOKIE_PERSIST_PHASES),
    outcome: z.enum(SAND_COOKIE_PERSIST_OUTCOMES),
    seedCookies: z.number().int().nonnegative(),
    injected: z.number().int().nonnegative().optional(),
    missingAfter: z.number().int().nonnegative().optional(),
    attempts: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("process_crash"),
    binary: z.enum(SAND_PROCESS_CRASH_BINARIES),
    signal: z.enum(SAND_PROCESS_CRASH_SIGNALS),
    count: z.number().int().positive().max(10_000),
  }),
]);

export type InfrastructureEvent = z.infer<typeof boxInfrastructureEventSchema>;
export type BoxTelemetryRecord =
  LogRecord | { kind: "infrastructure"; event: InfrastructureEvent };
type BoxShipReport =
  | {
      kind: "progress";
      bytesWritten: number;
      bytesDelivered: number;
      pendingWindowCount: number;
      oldestPendingWindowAgeMs: number;
    }
  | {
      kind: "save_failed" | "save_recovered";
      errorClass: string;
      failureCount: number;
    };
interface Clock {
  monotonicNow(): number;
}
interface Polling {
  start(listener: () => Promise<void>): { dispose(): void };
}
interface LogFile {
  path: string;
  source: string;
  size?: number;
}
interface DeliveryWindow {
  candidateEndOffset: number;
  unsettledRecordCount: number;
  didDropRecord: boolean;
  invalidated: boolean;
}
interface SaveFailure {
  errorClass: string;
  failureCount: number;
  reportState:
    | { kind: "in_flight" | "delivered" }
    | { kind: "waiting_for_retry"; retryAtMs: number };
}
export function parseBoxInfrastructureEvent(
  value: unknown,
): InfrastructureEvent | undefined {
  const parsed = boxInfrastructureEventSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export class BoxLogShipper {
  readonly offsets = new Map<string, number>();
  readonly pendingDeliveryWindows = new Map<string, DeliveryWindow>();
  readonly pendingWindowStartedAtMs = new Map<string, number>();
  readonly statFailedPaths = new Set<string>();
  private readonly reportBatch: (
    records: BoxTelemetryRecord[],
    settle: (settlement: Settlement) => void,
  ) => void;
  private readonly reportBoxLogShip: (
    report: BoxShipReport,
    settle?: (settlement: Settlement) => void,
  ) => void;
  private readonly skip: Set<string>;
  private readonly excludeSourcePrefixes: readonly string[];
  private readonly logDir: string;
  private readonly subdirPattern: RegExp;
  private readonly polling: Polling;
  private readonly clock: Clock;
  private readonly maxBytesPerReadPerFile: number;
  private readonly maxLinesPerPoll: number;
  private readonly maxLagBytes: number;
  private readonly maxLineBytes: number;
  private readonly offsetsPath: string;
  private readonly writeOffsets: (
    path: string,
    data: Uint8Array,
  ) => Promise<void>;
  private pollingHandle: { dispose(): void } | undefined;
  private activePoll: Promise<void> | undefined;
  private hasLoadedOffsets = false;
  private isDisposed = false;
  private isOffsetsDirty = false;
  private offsetsRevision = 0;
  private lastProgressReportAtMs: number | undefined;
  private offsetSaveFailure: SaveFailure | undefined;
  constructor(deps: {
    reportBatch: BoxLogShipper["reportBatch"];
    reportBoxLogShip: BoxLogShipper["reportBoxLogShip"];
    polling: Polling;
    clock: Clock;
    logDir?: string;
    skipPaths?: readonly string[];
    excludeSourcePrefixes?: readonly string[];
    subdirPattern?: RegExp;
    maxBytesPerReadPerFile?: number;
    maxLinesPerPoll?: number;
    maxLagBytes?: number;
    maxLineBytes?: number;
    offsetsPath?: string;
    writeOffsets?: (path: string, data: Uint8Array) => Promise<void>;
  }) {
    this.reportBatch = deps.reportBatch;
    this.reportBoxLogShip = deps.reportBoxLogShip;
    this.logDir = deps.logDir ?? DEFAULT_LOG_DIR;
    this.skip = new Set(deps.skipPaths ?? []);
    this.excludeSourcePrefixes =
      deps.excludeSourcePrefixes ?? DEFAULT_EXCLUDED_SOURCE_PREFIXES;
    this.subdirPattern = deps.subdirPattern ?? DEFAULT_SUBDIR_PATTERN;
    this.polling = deps.polling;
    this.clock = deps.clock;
    this.maxBytesPerReadPerFile =
      deps.maxBytesPerReadPerFile ?? DEFAULT_MAX_BYTES_PER_READ;
    this.maxLinesPerPoll = deps.maxLinesPerPoll ?? DEFAULT_MAX_LINES_PER_POLL;
    this.maxLagBytes = deps.maxLagBytes ?? DEFAULT_MAX_LAG_BYTES;
    this.maxLineBytes = deps.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.offsetsPath = deps.offsetsPath ?? join(this.logDir, OFFSETS_FILE_NAME);
    this.writeOffsets = deps.writeOffsets ?? writeFileAtomic;
  }
  async start(): Promise<void> {
    await this.loadOffsets();
    this.hasLoadedOffsets = true;
    let first = true,
      resolveFirst = () => {};
    const firstPoll = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    this.pollingHandle = this.polling.start(async () => {
      try {
        await this.poll();
      } catch (error) {
        console.error("[sand-log-shipper] poll failed:", error);
      } finally {
        if (first) {
          first = false;
          resolveFirst();
        }
      }
    });
    await firstPoll;
  }
  async dispose(): Promise<void> {
    await this.stopPolling();
    await this.saveOffsets();
  }
  async checkpointOffsets(): Promise<void> {
    await this.saveOffsets(true);
  }
  async stopPolling(): Promise<void> {
    this.isDisposed = true;
    this.pollingHandle?.dispose();
    this.pollingHandle = undefined;
    await this.activePoll;
  }
  async poll(): Promise<void> {
    if (this.activePoll !== undefined || this.isDisposed) return;
    const active = this.pollOnce();
    this.activePoll = active;
    try {
      await active;
    } finally {
      if (this.activePoll === active) this.activePoll = undefined;
    }
  }
  async pollOnce(): Promise<void> {
    const listing = await this.listLogFiles(),
      snapshot = await this.snapshotLogFileSizes(listing);
    this.reconcileTruncatedOffsets(snapshot.files);
    let budget = this.maxLinesPerPoll;
    for (const file of snapshot.files) {
      if (budget <= 0) break;
      try {
        budget -= await this.pumpFile(file, budget);
      } catch {}
    }
    if (this.isOffsetsDirty) await this.saveOffsets();
    if (snapshot.complete) this.maybeReportProgress(snapshot.files);
    this.maybeRetryOffsetSaveFailure();
  }
  async listLogFiles(): Promise<{ files: LogFile[]; complete: boolean }> {
    const files: LogFile[] = [];
    let complete = true;
    let entries;
    try {
      entries = await readdir(this.logDir, { withFileTypes: true });
    } catch {
      return { files, complete: false };
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(LOG_SUFFIX)) {
        const path = join(this.logDir, entry.name),
          source = toSourceName(entry.name);
        if (!this.skip.has(path) && !this.isExcludedSource(source))
          files.push({ path, source });
      } else if (entry.isDirectory() && this.subdirPattern.test(entry.name)) {
        const subdir = join(this.logDir, entry.name);
        let subEntries;
        try {
          subEntries = await readdir(subdir, { withFileTypes: true });
        } catch {
          complete = false;
          continue;
        }
        for (const sub of subEntries) {
          if (!sub.isFile() || !sub.name.endsWith(LOG_SUFFIX)) continue;
          const path = join(subdir, sub.name),
            leaf = toSourceName(sub.name);
          if (!this.skip.has(path) && !this.isExcludedSource(leaf))
            files.push({ path, source: `${entry.name}/${leaf}` });
        }
      }
    }
    return { files, complete };
  }
  async snapshotLogFileSizes(listing: {
    files: LogFile[];
    complete: boolean;
  }): Promise<{ files: Required<LogFile>[]; complete: boolean }> {
    const files: Required<LogFile>[] = [];
    let complete = listing.complete;
    for (const file of listing.files) {
      try {
        const fileStat = await stat(file.path);
        this.statFailedPaths.delete(file.path);
        if (fileStat.isFile()) files.push({ ...file, size: fileStat.size });
      } catch (error) {
        complete = false;
        if (
          findSystemErrno(error) !== "ENOENT" &&
          !this.statFailedPaths.has(file.path)
        ) {
          this.statFailedPaths.add(file.path);
          console.error(
            `[sand-log-shipper] stat failed for ${file.source} (${errorLogTag(error)})`,
          );
        }
      }
    }
    return { files, complete };
  }
  isExcludedSource(leaf: string): boolean {
    return this.excludeSourcePrefixes.some((prefix) => leaf.startsWith(prefix));
  }
  reconcileTruncatedOffsets(files: Required<LogFile>[]): void {
    for (const file of files) {
      const offset = this.offsets.get(file.path);
      if (offset !== undefined && file.size < offset) {
        const pending = this.pendingDeliveryWindows.get(file.path);
        if (pending === undefined)
          this.pendingWindowStartedAtMs.delete(file.path);
        else pending.invalidated = true;
        this.setOffset(file.path, 0);
      }
    }
  }
  async pumpFile(file: Required<LogFile>, budget: number): Promise<number> {
    const { path, source, size } = file;
    if (this.pendingDeliveryWindows.has(path)) return 0;
    let from = this.offsets.get(path) ?? 0;
    if (size <= from) {
      this.pendingWindowStartedAtMs.delete(path);
      return 0;
    }
    let processed = 0,
      candidateEndOffset = from;
    const records: BoxTelemetryRecord[] = [];
    if (size - from > this.maxLagBytes) {
      const jumped = size - this.maxBytesPerReadPerFile;
      records.push({
        kind: "log",
        source,
        line: `[sand-log-shipper] skipped ${jumped - from} bytes (too far behind)`,
      });
      processed += 1;
      from = jumped;
      candidateEndOffset = jumped;
    }
    const length = Math.min(size - from, this.maxBytesPerReadPerFile),
      buffer = Buffer.alloc(length),
      handle = await open(path, "r");
    let bytesRead = 0;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, length, from));
    } finally {
      await handle.close();
    }
    if (bytesRead <= 0) {
      this.reportDeliveryWindow(path, candidateEndOffset, records);
      return processed;
    }
    const chunk = buffer.subarray(0, bytesRead),
      lastNewline = chunk.lastIndexOf(NEWLINE);
    if (lastNewline === -1) {
      if (from + bytesRead < size) {
        const record = this.toTelemetryRecord({
          source,
          line: chunk.subarray(0, this.maxLineBytes).toString("utf8"),
        });
        if (record !== undefined) records.push(record);
        candidateEndOffset = from + bytesRead;
        processed += 1;
      }
      this.reportDeliveryWindow(path, candidateEndOffset, records);
      return processed;
    }
    let cursor = 0;
    while (processed < budget) {
      const newline = chunk.indexOf(NEWLINE, cursor);
      if (newline === -1 || newline > lastNewline) break;
      let line = chunk.subarray(cursor, newline).toString("utf8");
      cursor = newline + 1;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) {
        const record = this.toTelemetryRecord({ source, line });
        if (record !== undefined) records.push(record);
        processed += 1;
      }
    }
    candidateEndOffset = from + cursor;
    this.reportDeliveryWindow(path, candidateEndOffset, records);
    return processed;
  }
  toTelemetryRecord(entry: {
    source: string;
    line: string;
  }): BoxTelemetryRecord | undefined {
    if (entry.source !== BOX_TELEMETRY_SOURCE) return { kind: "log", ...entry };
    let value: unknown;
    try {
      value = JSON.parse(entry.line);
    } catch {
      return undefined;
    }
    const event = parseBoxInfrastructureEvent(value);
    return event === undefined ? undefined : { kind: "infrastructure", event };
  }
  reportDeliveryWindow(
    path: string,
    candidateEndOffset: number,
    records: BoxTelemetryRecord[],
  ): void {
    if (records.length === 0) {
      this.setOffset(path, candidateEndOffset);
      return;
    }
    const window: DeliveryWindow = {
      candidateEndOffset,
      unsettledRecordCount: records.length,
      didDropRecord: false,
      invalidated: false,
    };
    if (!this.pendingWindowStartedAtMs.has(path))
      this.pendingWindowStartedAtMs.set(path, this.clock.monotonicNow());
    this.pendingDeliveryWindows.set(path, window);
    this.reportBatch(records, (settlement) =>
      this.settleDeliveryWindow(path, window, settlement),
    );
  }
  settleDeliveryWindow(
    path: string,
    window: DeliveryWindow,
    settlement: Settlement,
  ): void {
    window.unsettledRecordCount -= 1;
    if (settlement === "dropped") window.didDropRecord = true;
    if (window.unsettledRecordCount > 0) return;
    this.pendingDeliveryWindows.delete(path);
    if (!window.didDropRecord && !window.invalidated)
      this.setOffset(path, window.candidateEndOffset);
  }
  setOffset(path: string, offset: number): void {
    const previous = this.offsets.get(path);
    if (previous === offset) return;
    this.offsets.set(path, offset);
    if (offset > (previous ?? 0)) this.pendingWindowStartedAtMs.delete(path);
    this.isOffsetsDirty = true;
    this.offsetsRevision += 1;
  }
  async loadOffsets(): Promise<void> {
    const raw = await readFile(this.offsetsPath, "utf8").catch(
      (error: unknown) => {
        if (findSystemErrno(error) !== "ENOENT")
          console.error(
            `[sand-log-shipper] offsets read failed (${errorLogTag(error)})`,
          );
        return null;
      },
    );
    if (raw === null) return;
    let parsed;
    try {
      parsed = offsetsSchema.safeParse(JSON.parse(raw));
    } catch {
      return;
    }
    if (!parsed.success) return;
    for (const [path, offset] of Object.entries(parsed.data))
      this.offsets.set(path, offset);
  }
  async saveOffsets(force = false): Promise<void> {
    if (!this.hasLoadedOffsets || (!force && !this.isOffsetsDirty)) return;
    const revision = this.offsetsRevision,
      record: Record<string, number> = {};
    for (const [path, offset] of this.offsets) record[path] = offset;
    try {
      await this.writeOffsets(
        this.offsetsPath,
        Buffer.from(JSON.stringify(record)),
      );
      if (this.offsetsRevision === revision) {
        this.isOffsetsDirty = false;
        this.noteOffsetSaveSucceeded();
      }
    } catch (error) {
      this.isOffsetsDirty = true;
      this.noteOffsetSaveFailed(error);
    }
  }
  maybeReportProgress(files: Required<LogFile>[]): void {
    const now = this.clock.monotonicNow();
    if (
      this.lastProgressReportAtMs !== undefined &&
      now - this.lastProgressReportAtMs < BOX_LOG_SHIP_PROGRESS_INTERVAL_MS
    )
      return;
    let bytesWritten = 0,
      bytesDelivered = 0;
    for (const file of files) {
      bytesWritten = saturatingAdd(bytesWritten, file.size);
      bytesDelivered = saturatingAdd(
        bytesDelivered,
        Math.min(file.size, this.offsets.get(file.path) ?? 0),
      );
    }
    let oldestPendingWindowAgeMs = 0;
    for (const startedAtMs of this.pendingWindowStartedAtMs.values())
      oldestPendingWindowAgeMs = Math.max(
        oldestPendingWindowAgeMs,
        toNonnegativeSafeInteger(now - startedAtMs),
      );
    this.lastProgressReportAtMs = now;
    this.reportBoxLogShip({
      kind: "progress",
      bytesWritten,
      bytesDelivered,
      pendingWindowCount: toNonnegativeSafeInteger(
        this.pendingWindowStartedAtMs.size,
      ),
      oldestPendingWindowAgeMs,
    });
  }
  maybeRetryOffsetSaveFailure(): void {
    const failure = this.offsetSaveFailure;
    if (
      failure?.reportState.kind === "waiting_for_retry" &&
      this.clock.monotonicNow() >= failure.reportState.retryAtMs
    )
      this.reportOffsetSaveFailure(failure);
  }
  noteOffsetSaveFailed(error: unknown): void {
    const errorClass = classifyOffsetSaveError(error),
      failure = this.offsetSaveFailure;
    if (failure !== undefined) {
      failure.errorClass = errorClass;
      failure.failureCount = saturatingAdd(failure.failureCount, 1);
      return;
    }
    const next: SaveFailure = {
      errorClass,
      failureCount: 1,
      reportState: { kind: "in_flight" },
    };
    this.offsetSaveFailure = next;
    this.reportOffsetSaveFailure(next);
  }
  reportOffsetSaveFailure(failure: SaveFailure): void {
    failure.reportState = { kind: "in_flight" };
    this.reportBoxLogShip(
      {
        kind: "save_failed",
        errorClass: failure.errorClass,
        failureCount: failure.failureCount,
      },
      (settlement) => {
        if (
          this.offsetSaveFailure !== failure ||
          failure.reportState.kind !== "in_flight"
        )
          return;
        failure.reportState =
          settlement === "delivered"
            ? { kind: "delivered" }
            : {
                kind: "waiting_for_retry",
                retryAtMs:
                  this.clock.monotonicNow() + BOX_LOG_SHIP_PROGRESS_INTERVAL_MS,
              };
      },
    );
  }
  noteOffsetSaveSucceeded(): void {
    const failure = this.offsetSaveFailure;
    if (failure === undefined) return;
    this.offsetSaveFailure = undefined;
    this.reportBoxLogShip({
      kind: "save_recovered",
      errorClass: failure.errorClass,
      failureCount: failure.failureCount,
    });
  }
}
export function isBoxLogShippingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.SAND_HOST_IN_BOX !== "1") return false;
  const disabled = env.SAND_BOX_LOG_SHIP_DISABLED?.trim().toLowerCase();
  return !(disabled === "1" || disabled === "true" || disabled === "yes");
}
export function toSourceName(fileName: string): string {
  return fileName.endsWith(LOG_SUFFIX)
    ? fileName.slice(0, -LOG_SUFFIX.length)
    : fileName;
}
export function classifyOffsetSaveError(error: unknown): string {
  switch (findSystemErrno(error)) {
    case "ENOSPC":
    case "EDQUOT":
      return "no_space";
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    case "EROFS":
      return "read_only";
    case "ENOENT":
      return "missing_parent";
    case undefined:
      return "unknown";
    default:
      return "io";
  }
}
export function saturatingAdd(total: number, value: number): number {
  const bounded = toNonnegativeSafeInteger(value);
  return total >= Number.MAX_SAFE_INTEGER - bounded
    ? Number.MAX_SAFE_INTEGER
    : total + bounded;
}
export function toNonnegativeSafeInteger(value: number): number {
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)));
}
