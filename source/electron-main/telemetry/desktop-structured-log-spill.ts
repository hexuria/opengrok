import { createHash } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import { parseJwtPayload } from "../../shared/node/cursor-token.js";
import { writeFileAtomic } from "../../shared/node/atomic-write.js";

export const DESKTOP_STRUCTURED_LOG_SPILL_MAX_BYTES = 1024 * 1024;
export const DESKTOP_STRUCTURED_LOG_SPILL_MAX_AGE_MS = 18 * 60 * 60 * 1_000;
export const DESKTOP_STRUCTURED_LOG_SPILL_MAX_ENTRIES = 1_000;
export const DESKTOP_STRUCTURED_LOG_SPILL_FILE_NAME = "desktop-structured-log-spill.v1.json";
export const TELEMETRY_DROP_REASONS = ["ship_failed", "overflow_evicted", "replay_expired", "backend_dropped", "account_rotated"] as const;
export type TelemetryDropReason = typeof TELEMETRY_DROP_REASONS[number];
export type StructuredLogLevel = "debug" | "info" | "warn" | "error";
export interface StructuredLogRecord { readonly level: StructuredLogLevel; readonly message: string; readonly metadata: Readonly<Record<string, string>>; readonly timestamp: number }
export type DropCounters = Record<TelemetryDropReason, { observed: number; acknowledgedThrough: number }>;
export interface StructuredLogCheckpoint { readonly counterId: string; readonly counters: DropCounters; readonly records: readonly StructuredLogRecord[] }
export interface DesktopStructuredLogSpillState { readonly accountSlot: string; readonly checkpoint: StructuredLogCheckpoint }
export type SpillFailure = { readonly operation: "load" | "replace" | "clear"; readonly errorClass: string };
export type SpillResult = { readonly kind: "empty" } | { readonly kind: "stored"; readonly state: DesktopStructuredLogSpillState } | { readonly kind: "loaded"; readonly state: DesktopStructuredLogSpillState } | { readonly kind: "failed"; readonly failure: SpillFailure; readonly preservesFile?: boolean };
export interface DesktopStructuredLogSpill { load(accountSlot: string): Promise<SpillResult>; replace(state: DesktopStructuredLogSpillState): Promise<SpillResult>; clear(): Promise<SpillResult> }

export const DESKTOP_STRUCTURED_LOG_SPILL_EVENTS = [
  "sand.access_blocked", "sand.agent_load", "sand.agents_unreachable", "sand.attachment.edge_failed", "sand.box_dns_diagnostic", "sand.box_reachability", "sand.box_migration_watch", "sand.box_rebuild_escalation", "sand.box_rebuild_pending_stall", "sand.box_rebuild_stage", "sand.box_recreate_visible", "sand.box_secrets.push", "sand.box_setup_visible", "sand.connector_auth", "sand.desktop.coordinator_lifecycle", "sand.desktop.edge_failed", "sand.desktop.event_loop", "sand.desktop.startup", "sand.desktop.process_crash", "sand.desktop.renderer_lifecycle", "sand.desktop.coordinator_handoff", "sand.desktop.local_exec_lifecycle", "sand.desktop.session", "sand.desktop.unclean_exit", "sand.image.edge_failed", "sand.mcp.desktop_edge_failed", "sand.reaction.ack", "sand.recovery_action", "sand.render_stream", "sand.render_ttfr", "sand.replica.resync", "sand.resync.completed", "sand.send_ack", "sand.send", "sand.send_journal.restore", "sand.telemetry.sink_edge_failed", "sand.transport.stream_down", "sand.update.apply", "sand.update.check", "sand.update.outcome", "sand.update.prompt", "sand.vnc_liveness",
] as const;
const spillEventSet = new Set<string>(DESKTOP_STRUCTURED_LOG_SPILL_EVENTS);

const safeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const errorCode = (error: unknown): string | undefined => typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
const errorClass = (error: unknown): string => error instanceof Error ? error.name || "Error" : typeof error;
const addCount = (left: number, right: number): number => Math.min(Number.MAX_SAFE_INTEGER, left + right);
export function emptyDesktopStructuredLogDropCounters(): DropCounters { return { ship_failed: { observed: 0, acknowledgedThrough: 0 }, overflow_evicted: { observed: 0, acknowledgedThrough: 0 }, replay_expired: { observed: 0, acknowledgedThrough: 0 }, backend_dropped: { observed: 0, acknowledgedThrough: 0 }, account_rotated: { observed: 0, acknowledgedThrough: 0 } }; }
function cloneCounters(counters: DropCounters): DropCounters { return Object.fromEntries(TELEMETRY_DROP_REASONS.map((reason) => [reason, { ...counters[reason] }])) as DropCounters; }
function pendingDrops(counters: DropCounters): boolean { return TELEMETRY_DROP_REASONS.some((reason) => counters[reason].observed > counters[reason].acknowledgedThrough); }

function parseState(value: unknown): DesktopStructuredLogSpillState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const root = value as Record<string, unknown>; if (root.version !== 1 || typeof root.accountSlot !== "string" || root.accountSlot.length < 1 || root.accountSlot.length > 128 || typeof root.checkpoint !== "object" || root.checkpoint === null) return undefined;
  const checkpoint = root.checkpoint as Record<string, unknown>; if (typeof checkpoint.counterId !== "string" || checkpoint.counterId.length < 1 || checkpoint.counterId.length > 128 || typeof checkpoint.counters !== "object" || checkpoint.counters === null || !Array.isArray(checkpoint.records) || checkpoint.records.length > DESKTOP_STRUCTURED_LOG_SPILL_MAX_ENTRIES) return undefined;
  const counters = emptyDesktopStructuredLogDropCounters();
  for (const reason of TELEMETRY_DROP_REASONS) { const raw = (checkpoint.counters as Record<string, unknown>)[reason]; if (typeof raw !== "object" || raw === null) return undefined; const pair = raw as Record<string, unknown>; if (!safeInteger(pair.observed) || !safeInteger(pair.acknowledgedThrough) || pair.acknowledgedThrough > pair.observed) return undefined; counters[reason] = { observed: pair.observed, acknowledgedThrough: pair.acknowledgedThrough }; }
  const records: StructuredLogRecord[] = [];
  for (const raw of checkpoint.records) { if (typeof raw !== "object" || raw === null) return undefined; const record = raw as Record<string, unknown>; if (!(["debug", "info", "warn", "error"] as unknown[]).includes(record.level) || typeof record.message !== "string" || record.message.length < 1 || record.message.length > 128 || typeof record.metadata !== "object" || record.metadata === null || Array.isArray(record.metadata) || !safeInteger(record.timestamp)) return undefined; const metadata: Record<string, string> = {}; for (const [key, entry] of Object.entries(record.metadata)) { if (typeof entry !== "string") return undefined; metadata[key] = entry; } records.push({ level: record.level as StructuredLogLevel, message: record.message, metadata, timestamp: record.timestamp }); }
  return { accountSlot: root.accountSlot, checkpoint: { counterId: checkpoint.counterId, counters, records } };
}

function prefix(state: DesktopStructuredLogSpillState, counters: DropCounters): string { return `{"version":1,"accountSlot":${JSON.stringify(state.accountSlot)},"checkpoint":{"counterId":${JSON.stringify(state.checkpoint.counterId)},"counters":${JSON.stringify(counters)},"records":[`; }
export function normalizeDesktopStructuredLogSpill(state: DesktopStructuredLogSpillState, nowMs: number): { state: DesktopStructuredLogSpillState; encoded: string } {
  const counters = cloneCounters(state.checkpoint.counters); const eligible: StructuredLogRecord[] = [];
  const drop = (reason: TelemetryDropReason, count: number): void => { counters[reason].observed = addCount(counters[reason].observed, count); };
  for (const entry of state.checkpoint.records) { if (!spillEventSet.has(entry.message)) continue; if (nowMs - entry.timestamp > DESKTOP_STRUCTURED_LOG_SPILL_MAX_AGE_MS) { drop("replay_expired", 1); continue; } eligible.push({ ...entry, metadata: { ...entry.metadata } }); }
  const countStart = Math.max(0, eligible.length - DESKTOP_STRUCTURED_LOG_SPILL_MAX_ENTRIES); drop("overflow_evicted", countStart); const candidates = eligible.slice(countStart); const encodedRecords = candidates.map((entry) => JSON.stringify(entry)); let recordBytes = encodedRecords.reduce((total, entry) => total + Buffer.byteLength(entry), 0); let byteStart = 0;
  while (byteStart < encodedRecords.length) { const prefixBytes = Buffer.byteLength(prefix(state, counters)); const commas = Math.max(0, encodedRecords.length - byteStart - 1); if (prefixBytes + recordBytes + commas + Buffer.byteLength("]}}\n") <= DESKTOP_STRUCTURED_LOG_SPILL_MAX_BYTES) break; recordBytes -= Buffer.byteLength(encodedRecords[byteStart] ?? ""); byteStart += 1; drop("overflow_evicted", 1); }
  const normalized: DesktopStructuredLogSpillState = { accountSlot: state.accountSlot, checkpoint: { counterId: state.checkpoint.counterId, counters, records: candidates.slice(byteStart) } };
  return { state: normalized, encoded: prefix(normalized, counters) + encodedRecords.slice(byteStart).join(",") + "]}}\n" };
}

export type CursorAuthStatus = { readonly kind: "logging-in" | "logged-out" } | { readonly kind: "logged-in"; readonly authId?: string; readonly email?: string };
export function desktopStructuredLogAccountSlot(status: CursorAuthStatus): string | undefined { if (status.kind === "logging-in") return undefined; if (status.kind !== "logged-in") return "logged-out"; const slot = status.authId ?? status.email; return slot === undefined || slot.length === 0 ? "logged-out" : createHash("sha256").update(slot).digest("hex"); }
export function desktopStructuredLogAccountSlotForToken(accessToken: string): string | undefined { const authId = parseJwtPayload(accessToken)?.sub; return authId === undefined || authId.length === 0 ? undefined : desktopStructuredLogAccountSlot({ kind: "logged-in", authId }); }
export function fanOutCursorAuthAccountSlot(status: CursorAuthStatus, tracker?: { noteAccountSlot(slot: string | undefined): void }, telemetry?: { setAccountSlot(slot: string | undefined): Promise<unknown> | unknown }): void { const slot = desktopStructuredLogAccountSlot(status); tracker?.noteAccountSlot(slot); void telemetry?.setAccountSlot(slot); }

class FileDesktopStructuredLogSpill implements DesktopStructuredLogSpill {
  private chain = Promise.resolve();
  constructor(private readonly options: { readonly path: string; readonly now?: () => number; readonly onFailure?: (failure: SpillFailure) => void }) {}
  load(accountSlot: string): Promise<SpillResult> { return this.enqueue(() => this.loadNow(accountSlot)); }
  replace(state: DesktopStructuredLogSpillState): Promise<SpillResult> { return this.enqueue(() => this.replaceNow(state)); }
  clear(): Promise<SpillResult> { return this.enqueue(() => this.clearNow()); }
  private enqueue(operation: () => Promise<SpillResult>): Promise<SpillResult> { const result = this.chain.then(operation); this.chain = result.then(() => undefined, () => undefined); return result; }
  private failed(operation: SpillFailure["operation"], klass: string, preservesFile?: boolean): SpillResult { const failure = { operation, errorClass: klass }; this.options.onFailure?.(failure); return { kind: "failed", failure, ...(preservesFile === undefined ? {} : { preservesFile }) }; }
  private async loadNow(accountSlot: string): Promise<SpillResult> { let size: number; try { size = (await stat(this.options.path)).size; } catch (error) { return errorCode(error) === "ENOENT" ? { kind: "empty" } : this.failed("load", errorClass(error), true); } if (size > DESKTOP_STRUCTURED_LOG_SPILL_MAX_BYTES) { await this.discard(); return this.failed("load", "SpillFileOversize", false); } let raw: string; try { raw = await readFile(this.options.path, "utf8"); } catch (error) { return this.failed("load", errorClass(error), true); } let decoded: unknown; try { decoded = JSON.parse(raw); } catch (error) { await this.discard(); return this.failed("load", errorClass(error), false); } const intake = parseState(decoded); if (intake === undefined) { await this.discard(); return this.failed("load", "SpillFileInvalid", false); } if (intake.accountSlot !== accountSlot) return this.clearAfterLoad(); const normalized = normalizeDesktopStructuredLogSpill(intake, (this.options.now ?? Date.now)()); if (normalized.state.checkpoint.records.length === 0 && !pendingDrops(normalized.state.checkpoint.counters)) return this.clearAfterLoad(); if (normalized.encoded !== raw) await this.write(normalized); return { kind: "loaded", state: normalized.state }; }
  private async clearAfterLoad(): Promise<SpillResult> { const result = await this.clearNow(); return result.kind === "failed" ? { ...result, preservesFile: false } : result; }
  private async replaceNow(state: DesktopStructuredLogSpillState): Promise<SpillResult> { const normalized = normalizeDesktopStructuredLogSpill(state, (this.options.now ?? Date.now)()); return normalized.state.checkpoint.records.length === 0 && !pendingDrops(normalized.state.checkpoint.counters) ? this.clearNow() : this.write(normalized); }
  private async write(normalized: { state: DesktopStructuredLogSpillState; encoded: string }): Promise<SpillResult> { try { await writeFileAtomic(this.options.path, Buffer.from(normalized.encoded), { mode: 0o600 }); return { kind: "stored", state: normalized.state }; } catch (error) { return this.failed("replace", errorClass(error)); } }
  private async clearNow(): Promise<SpillResult> { try { await unlink(this.options.path); return { kind: "empty" }; } catch (error) { return errorCode(error) === "ENOENT" ? { kind: "empty" } : this.failed("clear", errorClass(error)); } }
  private async discard(): Promise<void> { try { await unlink(this.options.path); } catch (error) { if (errorCode(error) !== "ENOENT") this.options.onFailure?.({ operation: "clear", errorClass: errorClass(error) }); } }
}

export function createDesktopStructuredLogSpill(options: { readonly path: string; readonly now?: () => number; readonly onFailure?: (failure: SpillFailure) => void }): DesktopStructuredLogSpill { return new FileDesktopStructuredLogSpill(options); }
