import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ConversationStateStructure } from "../../../packages/proto/generated/agent/v1/agent_pb.js";
import { getSandProfilePath, readSandProfileFile } from "../../agents/agent-profile.js";
import { rebuildTranscriptEntriesFromState, selectHiddenArtifactEntryIds, conversationStructureFullyResolves, type OutlineItem } from "./conversation-recovery.js";
import { ConversationRecoveryScanError, transcriptEntryMatchesRecovered } from "./session-recovery.js";
import { CONVERSATION_BLOBS_FILENAME } from "./session-paths.js";

export const LEGACY_BLOB_RETIREMENT_VERSION = 1;
export const STALE_ROOT_CLEANUP_VERSION = 1;
export const HIDDEN_ENTRY_REPAIR_VERSION = 1;
let legacyRetirement = false, staleRootGc = false;
export function pinLegacyStoreBlobRetirement(enabled: boolean): void { legacyRetirement = enabled; }
export function isLegacyStoreBlobRetirementEnabled(env: NodeJS.ProcessEnv = process.env): boolean { const raw = env.SAND_RETIRE_LEGACY_STORE_BLOBS?.trim().toLowerCase(); if (["1", "true", "on"].includes(raw ?? "")) return true; if (["0", "false", "off"].includes(raw ?? "")) return false; return legacyRetirement; }
export function pinStaleRootGc(enabled: boolean): void { staleRootGc = enabled; }

export interface MaintenanceDb {
  get(key: string): Uint8Array | string;
  set(key: string, value: unknown): boolean;
  compareAndSetLatestRootBlobId(args: { expectedRoot: Uint8Array; nextRoot: Uint8Array }): boolean;
  getTranscriptEntries(): Array<Record<string, unknown>>;
  appendTranscriptEntries(entries: readonly (Record<string, unknown> & { id: string; kind: string })[]): boolean | number;
  deleteTranscriptEntry(id: string): boolean;
  getStaleRootCleanupVersion(): number; setStaleRootCleanupVersion(version: number): boolean;
  getHiddenEntryRepairVersion(): number; setHiddenEntryRepairVersion(version: number): boolean;
  hasLegacyConversationBlobs(): boolean; getLegacyBlobRetirementVersion(): number; retireLegacyConversationBlobs(version: number): boolean;
}
export interface MaintenanceStore {
  getConversationStateStructure(): { turns: readonly Uint8Array[]; todos: readonly Uint8Array[]; summary?: Uint8Array };
  getBlobStore(): { getBlob(ctx: unknown, id: Uint8Array): Promise<Uint8Array | null> };
  getFullConversation(ctx: unknown): Promise<{ turns: readonly { items: readonly OutlineItem[] }[] }>;
  resetFromDb(ctx: unknown): Promise<void>;
}
export interface MaintenanceHost {
  rootDir: string; ctx: unknown;
  liveHandleCount?(path: string): number; writeGeneration?(path: string): number;
  resolveConversationState(structure: unknown, blobStore: unknown): Promise<{ turns: readonly { items: readonly OutlineItem[] }[] } | null>;
  deriveOutline?(state: unknown): readonly OutlineItem[];
  report?(event: Record<string, unknown>): void;
  requireWorkerPool(): {
    clearStaleCheckpointRoots(agentId: string, blobDbPath: string, rootHex: string, dbPath: string): Promise<number>;
    findLatestRootBlobId(args: { agentId: string; blobDbPath: string; legacyBlobDbPath: string }): Promise<Uint8Array | null>;
    verifyLegacyBlobRetirement(args: { agentId: string; blobDbPath: string; legacyBlobDbPath: string; retainedRootIdHex: string }): Promise<{ isRetirable: boolean; reason?: string; legacyRows?: number; legacyBytes?: number }>;
  };
}
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");
const generation = (host: MaintenanceHost, path: string): number => host.writeGeneration?.(path) ?? 0;
const handles = (host: MaintenanceHost, path: string): number => host.liveHandleCount?.(resolve(path)) ?? 1;
const diagnostic = (host: MaintenanceHost, kind: string, dbPath: string, error?: unknown): void => host.report?.({ family: "maintenance", kind, agentId: basename(dirname(dbPath)), ...(error == null ? {} : { errorClass: error instanceof Error ? error.name : String(error) }) });

export function backfillTranscript(_host: unknown, db: Pick<MaintenanceDb, "getTranscriptEntries" | "appendTranscriptEntries">, stateOrEntries: { turns: readonly { items: readonly OutlineItem[] }[] } | readonly Record<string, unknown>[]): number {
  const rebuilt = "turns" in stateOrEntries ? rebuildTranscriptEntriesFromState(stateOrEntries) : stateOrEntries, persisted = db.getTranscriptEntries();
  if (persisted.length >= rebuilt.length || !persisted.every((entry, index) => rebuilt[index] != null && transcriptEntryMatchesRecovered(entry, rebuilt[index] as Record<string, unknown>))) return 0;
  const tail = rebuilt.slice(persisted.length) as Array<Record<string, unknown> & { id: string; kind: string }>; const result = db.appendTranscriptEntries(tail); return typeof result === "number" ? result : result ? tail.length : 0;
}
export async function clearStaleCheckpointRootsOnce(host: MaintenanceHost, dbPath: string, db: MaintenanceDb, store: MaintenanceStore): Promise<boolean> {
  if (!staleRootGc || db.getStaleRootCleanupVersion() >= STALE_ROOT_CLEANUP_VERSION) return false;
  try { const root = db.get("latestRootBlobId"); if (!(root instanceof Uint8Array) || root.length === 0 || store.getConversationStateStructure().turns.length === 0 || handles(host, dbPath) > 1) return false; const before = generation(host, dbPath); await host.requireWorkerPool().clearStaleCheckpointRoots(basename(dirname(dbPath)), join(dirname(dbPath), "conversation-blobs.db"), hex(root), dbPath); if (generation(host, dbPath) !== before || hex(db.get("latestRootBlobId") as Uint8Array) !== hex(root) || handles(host, dbPath) > 1) return false; return db.setStaleRootCleanupVersion(STALE_ROOT_CLEANUP_VERSION); } catch (error) { diagnostic(host, "checkpoint_cleanup_failed", dbPath, error); return false; }
}
export async function findLatestDurableRootBlobId(host: MaintenanceHost, args: { dbPath: string; blobsPath: string }): Promise<Uint8Array | null> { try { return await host.requireWorkerPool().findLatestRootBlobId({ agentId: basename(dirname(args.dbPath)), blobDbPath: args.blobsPath, legacyBlobDbPath: args.dbPath }); } catch (error) { throw new ConversationRecoveryScanError(error instanceof Error ? error.name : String(error)); } }
export async function recoverConversationIfRootMissing(host: MaintenanceHost, dbPath: string, db: MaintenanceDb, store: MaintenanceStore): Promise<boolean> {
  const existing = db.get("latestRootBlobId"); if (!(existing instanceof Uint8Array) || existing.length > 0) return false;
  const blobsPath = join(dirname(dbPath), CONVERSATION_BLOBS_FILENAME), recoveryGeneration = generation(host, dbPath);
  try { if (!existsSync(blobsPath) && !db.hasLegacyConversationBlobs()) return false; const root = await findLatestDurableRootBlobId(host, { dbPath, blobsPath }); if (root == null) return false; const blob = await store.getBlobStore().getBlob(host.ctx, root); if (blob == null) return false; const structure = ConversationStateStructure.fromBinary(blob); const state = await host.resolveConversationState(structure, store.getBlobStore()); if (state == null || generation(host, dbPath) !== recoveryGeneration) return false; if (!db.compareAndSetLatestRootBlobId({ expectedRoot: existing, nextRoot: root })) { await store.resetFromDb(host.ctx); return false; } await store.resetFromDb(host.ctx); if (hex(db.get("latestRootBlobId") as Uint8Array) !== hex(root)) return false; const profileName = readSandProfileFile(getSandProfilePath(dirname(dbPath)))?.name.trim(); if (profileName != null && profileName.length > 0 && db.get("name") !== profileName) db.set("name", profileName); backfillTranscript(host, db, state); return true; } catch (error) { diagnostic(host, error instanceof ConversationRecoveryScanError ? "recovery_scan_failed" : "recovery_failed", dbPath, error); if (error instanceof ConversationRecoveryScanError) throw error; return false; }
}
export async function repairHiddenTranscriptEntriesOnce(host: MaintenanceHost, dbPath: string, db: MaintenanceDb, store: MaintenanceStore): Promise<number> {
  if (db.getHiddenEntryRepairVersion() >= HIDDEN_ENTRY_REPAIR_VERSION) return 0;
  try { const entries = db.getTranscriptEntries(); if (!entries.some((entry) => entry.kind === "message" && entry.role === "user" && typeof entry.id === "string" && entry.id.startsWith("recovered-"))) { db.setHiddenEntryRepairVersion(HIDDEN_ENTRY_REPAIR_VERSION); return 0; } const structure = store.getConversationStateStructure(), state = await store.getFullConversation(host.ctx); if (state.turns.length === 0 || state.turns.length < structure.turns.length || !await conversationStructureFullyResolves(host.ctx, structure, store.getBlobStore())) return 0; const outline = host.deriveOutline?.(state) ?? state.turns.flatMap((turn) => turn.items), ids = selectHiddenArtifactEntryIds(entries, outline); if (!ids.every((id) => db.deleteTranscriptEntry(id))) return 0; db.setHiddenEntryRepairVersion(HIDDEN_ENTRY_REPAIR_VERSION); return ids.length; } catch (error) { diagnostic(host, "hidden_repair_failed", dbPath, error); return 0; }
}
export async function retireLegacyStoreBlobsOnce(host: MaintenanceHost, dbPath: string, db: MaintenanceDb, store: MaintenanceStore): Promise<boolean> {
  if (!isLegacyStoreBlobRetirementEnabled() || db.getLegacyBlobRetirementVersion() >= LEGACY_BLOB_RETIREMENT_VERSION) return false;
  try { if (!db.hasLegacyConversationBlobs()) return db.retireLegacyConversationBlobs(LEGACY_BLOB_RETIREMENT_VERSION); const root = db.get("latestRootBlobId"); if (!(root instanceof Uint8Array) || root.length === 0 || store.getConversationStateStructure().turns.length === 0 || handles(host, dbPath) > 1) return false; const before = generation(host, dbPath), verdict = await host.requireWorkerPool().verifyLegacyBlobRetirement({ agentId: basename(dirname(dbPath)), blobDbPath: join(dirname(dbPath), "conversation-blobs.db"), legacyBlobDbPath: dbPath, retainedRootIdHex: hex(root) }); if (!verdict.isRetirable || generation(host, dbPath) !== before || hex(db.get("latestRootBlobId") as Uint8Array) !== hex(root) || handles(host, dbPath) > 1) return false; return db.retireLegacyConversationBlobs(LEGACY_BLOB_RETIREMENT_VERSION); } catch (error) { diagnostic(host, "blob_retirement_failed", dbPath, error); return false; }
}
export async function cleanupLegacyGroupMemberDirs(host: Pick<MaintenanceHost, "rootDir" | "report">, dirnameToRemove = "members"): Promise<void> { let entries; try { entries = await readdir(host.rootDir, { withFileTypes: true }); } catch { return; } for (const entry of entries) if (entry.isDirectory()) try { await rm(join(host.rootDir, entry.name, dirnameToRemove), { recursive: true, force: true }); } catch (error) { host.report?.({ family: "maintenance", kind: "member_cleanup_failed", agentId: entry.name, errorClass: error instanceof Error ? error.name : String(error) }); } }
export async function runSessionMaintenance(tasks: readonly (() => void | Promise<void>)[], report: (error: unknown, index: number) => void = () => {}): Promise<void> { for (const [index, task] of tasks.entries()) try { await task(); } catch (error) { report(error, index); } }
