import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CONVERSATION_BLOBS_FILENAME } from "./session-paths.js";
import { reportSessionDiagnostic } from "./session-diagnostics.js";

export const SOFT_LIMIT_DEFAULT_BYTES = 256 * 1024 * 1024;
export const HARD_LIMIT_DEFAULT_BYTES = 1024 * 1024 * 1024;
export const GC_PENDING_WRITE_RETENTION_MS = 60_000;
export const SOFT_GC_MIN_INTERVAL_MS = 30 * 60_000;

export interface ConversationSizeLimits { soft_limit_mb?: number; hard_limit_mb?: number }
export type ConversationGcVerdict = null | { outcome: "failed" } | { outcome: "skipped"; reason: string; unresolvedProtoRefs?: number } | { outcome: "collected"; deletedRows: number; deletedBytes: number; liveRows: number; liveBytes: number; vacuumed: boolean };
export type ConversationGcReport = Record<string, unknown> & { trigger: string; agentId: string; outcome: string };
interface ConversationDb { get(key: "latestRootBlobId"): Uint8Array }
interface ConversationGcHost { requireWorkerPool(): { collectConversationGarbage(args: { agentId: string; blobDbPath: string; retainedRootIdHex: string; pendingWriteRetentionMs: number; legacyBlobDbPath: string }): Promise<ConversationGcVerdict> } }

let pinnedSizeLimitsReader: (() => ConversationSizeLimits) | null = null;
let pinnedConversationGcEnabled = false;
let pinnedConversationGcReporter: ((report: ConversationGcReport) => void) | null = null;

function readByteLimitOverride(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined { const raw = env[name]?.trim(); if (!raw) return undefined; const parsed = Number(raw); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined; }
export function pinConversationSizeLimitsReader(reader: (() => ConversationSizeLimits) | null): void { pinnedSizeLimitsReader = reader; }
function configuredLimitBytes(field: keyof ConversationSizeLimits): number | undefined { const mb = pinnedSizeLimitsReader?.()[field]; return mb != null && Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : undefined; }
export function conversationSoftLimitBytes(env: NodeJS.ProcessEnv = process.env): number { return readByteLimitOverride("SAND_CONVERSATION_SOFT_LIMIT_BYTES", env) ?? configuredLimitBytes("soft_limit_mb") ?? SOFT_LIMIT_DEFAULT_BYTES; }
export function conversationHardLimitBytes(env: NodeJS.ProcessEnv = process.env): number { return readByteLimitOverride("SAND_CONVERSATION_HARD_LIMIT_BYTES", env) ?? configuredLimitBytes("hard_limit_mb") ?? HARD_LIMIT_DEFAULT_BYTES; }
export function pinConversationGc(enabled: boolean): void { pinnedConversationGcEnabled = enabled; }
export function pinConversationGcReporter(reporter: ((report: ConversationGcReport) => void) | null): void { pinnedConversationGcReporter = reporter; }
export function isConversationGcEnabled(env: NodeJS.ProcessEnv = process.env): boolean { const raw = env.SAND_CONVERSATION_GC?.trim().toLowerCase(); if (["1", "true", "on"].includes(raw ?? "")) return true; if (["0", "false", "off"].includes(raw ?? "")) return false; return pinnedConversationGcEnabled; }

export function reportConversationGcVerdict(trigger: string, dbPath: string, verdict: ConversationGcVerdict, stillOverCap = false): void {
  const agentId = basename(dirname(dbPath));
  if (verdict == null) { pinnedConversationGcReporter?.({ trigger, agentId, outcome: "skipped", skipReason: "no-root" }); return; }
  if (verdict.outcome === "failed") { pinnedConversationGcReporter?.({ trigger, agentId, outcome: "failed" }); return; }
  if (verdict.outcome === "skipped") { pinnedConversationGcReporter?.({ trigger, agentId, outcome: "skipped", skipReason: verdict.reason, ...(verdict.unresolvedProtoRefs === undefined ? {} : { unresolvedProtoRefs: verdict.unresolvedProtoRefs }) }); return; }
  pinnedConversationGcReporter?.({ trigger, agentId, outcome: "collected", deletedRows: verdict.deletedRows, deletedBytes: verdict.deletedBytes, liveRows: verdict.liveRows, liveBytes: verdict.liveBytes, vacuumed: verdict.vacuumed, stillOverCap });
}
export class SandConversationTooLargeError extends Error { readonly isConversationTooLarge = true; constructor(sizeBytes: number, limitBytes: number) { super(`This conversation's stored state is ${Math.round(sizeBytes / (1024 * 1024))} MB, over the ${Math.round(limitBytes / (1024 * 1024))} MB limit, and compaction could not shrink it. Start a new conversation with this agent to continue.`); this.name = "SandConversationTooLargeError"; } }
export async function measureConversationBlobBytes(blobDbPath: string): Promise<number> { let total = 0; for (const path of [blobDbPath, `${blobDbPath}-wal`]) total += await stat(path).then((stats) => stats.size, () => 0); return total; }
export function blobDbPathFor(dbPath: string): string { return join(dirname(dbPath), CONVERSATION_BLOBS_FILENAME); }
function toHex(bytes: Uint8Array): string { return Buffer.from(bytes).toString("hex"); }
export async function runConversationGc(host: ConversationGcHost, dbPath: string, db: ConversationDb): Promise<ConversationGcVerdict> { const root = db.get("latestRootBlobId"); if (root.length === 0) return null; return await host.requireWorkerPool().collectConversationGarbage({ agentId: basename(dirname(dbPath)), blobDbPath: blobDbPathFor(dbPath), retainedRootIdHex: toHex(root), pendingWriteRetentionMs: GC_PENDING_WRITE_RETENTION_MS, legacyBlobDbPath: dbPath }); }
const softGcStateByBlobDbPath = new Map<string, { inFlight: boolean; lastRunMs: number }>();
function errorClass(error: unknown): string { return error instanceof Error ? error.name : typeof error; }
export function scheduleConversationSizeMaintenance(host: ConversationGcHost, dbPath: string, db: ConversationDb): void {
  if (!isConversationGcEnabled()) return; const path = blobDbPathFor(dbPath), state = softGcStateByBlobDbPath.get(path) ?? { inFlight: false, lastRunMs: 0 }; softGcStateByBlobDbPath.set(path, state); if (state.inFlight || Date.now() - state.lastRunMs < SOFT_GC_MIN_INTERVAL_MS) return; state.inFlight = true;
  void (async () => { try { const size = await measureConversationBlobBytes(path); if (size < conversationSoftLimitBytes()) return; state.lastRunMs = Date.now(); reportConversationGcVerdict("soft_schedule", dbPath, await runConversationGc(host, dbPath, db)); } catch (error) { reportConversationGcVerdict("soft_schedule", dbPath, { outcome: "failed" }); reportSessionDiagnostic({ family: "maintenance", kind: "conversation_gc_failed", agentId: basename(dirname(dbPath)), errorClass: errorClass(error) }); } finally { state.inFlight = false; } })();
}
export async function ensureConversationCapacityForTurn(host: ConversationGcHost, dbPath: string, db: ConversationDb): Promise<void> {
  if (!isConversationGcEnabled()) return; const path = blobDbPathFor(dbPath), size = await measureConversationBlobBytes(path), hard = conversationHardLimitBytes(); if (size < hard) { if (size >= conversationSoftLimitBytes()) scheduleConversationSizeMaintenance(host, dbPath, db); return; }
  let result: ConversationGcVerdict; try { result = await runConversationGc(host, dbPath, db); } catch (error) { reportConversationGcVerdict("turn_gate", dbPath, { outcome: "failed" }); reportSessionDiagnostic({ family: "maintenance", kind: "conversation_gc_failed", agentId: basename(dirname(dbPath)), errorClass: errorClass(error) }); return; }
  if (result?.outcome !== "collected") { reportConversationGcVerdict("turn_gate", dbPath, result); return; } const after = await measureConversationBlobBytes(path), stillOverCap = after >= hard; reportConversationGcVerdict("turn_gate", dbPath, result, stillOverCap); if (stillOverCap) throw new SandConversationTooLargeError(after, hard);
}
