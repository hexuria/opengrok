import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getMainTranscriptEntries } from "../../../shared/transcript.js";
import { branchReplyCounts, threadDescendants } from "../../../shared/transcript-threads.js";
import {
  EMPTY_SPEND_GUARD_STATE,
  EMPTY_UNREAD_STATE,
  EPISODE_PENDING_MAX,
  EPISODE_TURN_TEXT_CAP,
  REQUEST_ID_HISTORY_MAX,
  REQUEST_ID_PROMPT_MAX,
  parseAwaitingState,
  parseMemoryPromptSnapshot,
  parsePendingEpisodeTurns,
  parseProfile,
  parseRequestRecords,
  parseTranscriptEntry,
  parseUnreadState,
  resolveSpendGuardState,
  serializeSpendGuardState,
  type RequestRecord,
  type SpendGuardState
} from "./agent-db-serde.js";
import { prepareStatements, type PreparedStatement } from "./agent-db-schema.js";
import {
  openConfiguredDb,
  recoverCorruptStoreDb,
  type DbRecoveryOptions
} from "./agent-db-recovery.js";
import {
  readTranscriptPage,
  readTranscriptTail,
  readTranscriptWindow,
  type TranscriptPageStatements
} from "./agent-db-transcript-pages.js";
import {
  bumpDbWriteGeneration,
  liveDbHandleCount,
  registerLiveDbHandle,
  releaseLiveDbHandle,
} from "../../storage/store-db.js";
import { isSqliteBusyError, isSqliteCorruptError } from "../../storage/sqlite-busy.js";
import { publishTranscriptMutation } from "../../transcript-mutation-events.js";
import {
  AgentMetadataSerde,
  getDefaultAgentMetadata,
  type AgentMetadata,
  type AgentMetadataKey,
} from "../../../packages/agent-kv/agent-store.js";
import { fromHex, toHex } from "../../../packages/agent-kv/serde.js";

export type { AgentMetadata, AgentMetadataKey };
export type TranscriptEntry = Record<string, unknown> & { id: string; kind: string };
export interface AwaitingUserResponse { tabId: string; reason: string; since: number }
export interface SandProfile { description: string; avatarPath: string | null }
export interface AgentDbOptions extends DbRecoveryOptions {
  recoverOnCorruption?: boolean;
  onBusyError?(operation: string, error: Error): void;
}

const KV = {
  metadata: "metadata", profile: "sandProfile", unread: "unreadState",
  awaiting: "awaitingUserResponse", requestIds: "requestIds", latestRequestId: "latestRequestId",
  episode: "episodePending", memorySnapshot: "memoryPromptSnapshot",
  profileSnapshot: "agentProfilePromptSnapshot", origin: "origin",
  introduction: "introductionPending", spendGuard: "automationSpendGuardState",
  spendGuardLegacy: "automationSpendGuardNudgedAt", partners: "conversationPartners",
  hiddenRepair: "hiddenEntryRepairVersion", staleRootCleanup: "staleRootCleanupVersion",
  purpose: "purpose", legacyBlobRetirement: "legacyStoreBlobRetirementVersion",
  retiredEntryIds: "retired_entry_ids"
} as const;

const agentMetadataSerde = new AgentMetadataSerde();
export class SandAgentDb {
  private db: DatabaseSync;
  private statements: Record<string, PreparedStatement>;
  private closed = false;
  private recovered = false;
  private handleRegistered = false;
  private readonly listeners = new Map<AgentMetadataKey, Set<() => void>>();
  private readonly profileListeners = new Set<() => void>();
  private readonly awaitingListeners = new Set<() => void>();
  private retiredEntryIdCache: Set<string> | null = null;
  readonly agentDirName: string;
  readonly resolvedDbPath: string;

  constructor(readonly dbPath: string, readonly options: AgentDbOptions = {}) {
    this.agentDirName = basename(dirname(dbPath));
    this.resolvedDbPath = resolve(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    const hasOtherLiveHandles = liveDbHandleCount(this.resolvedDbPath) > 0;
    this.db = openConfiguredDb(dbPath, this.agentDirName, options, hasOtherLiveHandles);
    this.statements = prepareStatements(this.db);
    registerLiveDbHandle(this.resolvedDbPath);
    this.handleRegistered = true;
    try {
      this.seedDefaultMetadataIfMissing();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private notify(listeners: ReadonlySet<() => void>): void { queueMicrotask(() => { if (!this.closed) for (const listener of [...listeners]) listener(); }); }
  private assertOpen(): void { if (this.closed) throw new Error("SandAgentDb is closed"); }
  private runWrite(operation: string, write: () => void): boolean {
    if (this.closed) return false;
    try {
      write();
      bumpDbWriteGeneration(this.resolvedDbPath);
      return true;
    }
    catch (error) {
      if (isSqliteBusyError(error)) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        console.error(`[sand-agent-db] ${operation} dropped on locked db (${this.agentDirName}):`, normalized);
        this.options.onBusyError?.(operation, normalized);
        return false;
      }
      if ((this.options.recoverOnCorruption ?? true) && !this.recovered && isSqliteCorruptError(error)) {
        console.error(`[sand-agent-db] ${operation} hit corruption (${this.agentDirName}); recovering in place:`, error);
        if (this.recoverInPlace(error)) {
          try {
            write();
            bumpDbWriteGeneration(this.resolvedDbPath);
            return true;
          } catch (retryError) {
            if (isSqliteBusyError(retryError)) return false;
            throw retryError;
          }
        }
      }
      throw error;
    }
  }
  private recoverInPlace(cause: unknown): boolean {
    const otherLiveHandles = liveDbHandleCount(this.resolvedDbPath) - (this.handleRegistered ? 1 : 0);
    if (otherLiveHandles > 0) {
      console.error(`[sand-agent-db] deferring in-place recovery for ${this.agentDirName}: ${otherLiveHandles} other live handle(s) hold this store open`);
      return false;
    }
    try {
      this.db.close();
      this.db = recoverCorruptStoreDb(this.dbPath, this.agentDirName, this.options, cause);
      this.statements = prepareStatements(this.db);
      this.seedDefaultMetadataIfMissing();
      this.recovered = true;
      return true;
    } catch (error) {
      this.closed = true;
      if (this.handleRegistered) {
        this.handleRegistered = false;
        releaseLiveDbHandle(this.resolvedDbPath);
      }
      const code = typeof error === "object" && error != null && "code" in error
        ? error.code ?? "error"
        : "error";
      console.error(`[sand-agent-db] in-place recovery failed for ${this.agentDirName} (${String(code)})`);
      return false;
    }
  }
  close(options: { checkpoint?: boolean } = {}): void {
    if (this.handleRegistered) {
      this.handleRegistered = false;
      releaseLiveDbHandle(this.resolvedDbPath);
    }
    if (this.closed) return;
    this.closed = true;
    if (options.checkpoint) {
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (error) {
        console.error(`[sand-agent-db] checkpoint-on-close failed for ${this.agentDirName}:`, error);
      }
    }
    this.db.close();
  }

  readKv(key: string): string | null { if (this.closed) return null; const row = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as { value?: unknown } | undefined; return typeof row?.value === "string" ? row.value : null; }
  writeKv(key: string, value: string): boolean { return this.runWrite(`writeKv:${key}`, () => { this.db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }); }
  deleteKv(key: string): boolean { return this.runWrite(`deleteKv:${key}`, () => { this.db.prepare("DELETE FROM kv WHERE key=?").run(key); }); }
  private serializeMetadata(metadata: AgentMetadata): string { return toHex(agentMetadataSerde.serialize(metadata)); }
  private writeMetadata(metadata: AgentMetadata): boolean { return this.writeKv(KV.metadata, this.serializeMetadata(metadata)); }
  private seedDefaultMetadataIfMissing(): void { if (this.readKv(KV.metadata) == null) this.writeMetadata(getDefaultAgentMetadata(this.agentDirName)); }
  readMetadata(): AgentMetadata { const raw = this.readKv(KV.metadata); return raw == null ? getDefaultAgentMetadata(this.agentDirName) : agentMetadataSerde.deserialize(fromHex(raw)); }
  get<K extends AgentMetadataKey>(key: K): AgentMetadata[K] { return this.readMetadata()[key]; }
  set<K extends AgentMetadataKey>(key: K, value: AgentMetadata[K]): boolean {
    const metadata = this.readMetadata(), current = metadata[key];
    if (key === "latestRootBlobId" ? toHex(current as Uint8Array) === toHex(value as Uint8Array) : current === value) return true;
    const wrote = this.writeMetadata({ ...metadata, [key]: value });
    if (wrote) this.notify(this.listeners.get(key) ?? new Set());
    return wrote;
  }
  compareAndSetLatestRootBlobId(args: { expectedRoot?: Uint8Array; nextRoot?: Uint8Array; expected?: Uint8Array; next?: Uint8Array }): boolean {
    const expected = args.expectedRoot ?? args.expected ?? new Uint8Array(), next = args.nextRoot ?? args.next ?? new Uint8Array();
    const raw = this.readKv(KV.metadata); if (raw == null) return false;
    const metadata = agentMetadataSerde.deserialize(fromHex(raw)); if (toHex(metadata.latestRootBlobId) !== toHex(expected)) return false;
    let changed = false; this.runWrite("compareAndSetLatestRootBlobId", () => { const result = this.db.prepare("UPDATE kv SET value=? WHERE key=? AND value=?").run(this.serializeMetadata({ ...metadata, latestRootBlobId: next }), KV.metadata, raw); changed = Number(result.changes) === 1; });
    if (changed) this.notify(this.listeners.get("latestRootBlobId") ?? new Set()); return changed;
  }
  subscribe(key: AgentMetadataKey, listener: () => void): () => void { const set = this.listeners.get(key) ?? new Set(); set.add(listener); this.listeners.set(key, set); return () => set.delete(listener); }

  getSandProfile(): SandProfile { return parseProfile(this.readKv(KV.profile)); }
  setSandProfile(profile: SandProfile): boolean { const current = this.getSandProfile(); if (current.description === profile.description && current.avatarPath === profile.avatarPath) return true; const wrote = this.writeKv(KV.profile, JSON.stringify(profile)); if (wrote) this.notify(this.profileListeners); return wrote; }
  subscribeSandProfile(listener: () => void): () => void { this.profileListeners.add(listener); return () => this.profileListeners.delete(listener); }
  getUnreadState() { return parseUnreadState(this.readKv(KV.unread)); }
  private writeUnreadState(state: ReturnType<typeof parseUnreadState>): boolean { return this.writeKv(KV.unread, JSON.stringify(state)); }
  markActivity(at = Date.now()): void { const current = this.getUnreadState(); if (current.lastActivityAt < at) this.writeUnreadState({ ...current, lastActivityAt: at, unreadCount: current.unreadCount + 1 }); }
  markViewed(at = Date.now(), options: { preserveManualUnread?: boolean } = {}): void { const current = this.getUnreadState(); if (options.preserveManualUnread && current.isManuallyUnread) return; if (current.isManuallyUnread || current.lastViewedAt < at) this.writeUnreadState({ ...current, lastViewedAt: at, isManuallyUnread: false, unreadCount: 0 }); }
  markUnread(at = Date.now()): void { const current = this.getUnreadState(), lastActivityAt = current.lastActivityAt || at, newest = this.getNewestDividerAnchorTimestampMs(); const lastViewedAt = Math.min(current.lastViewedAt, lastActivityAt - 1, at - 1, newest > 0 ? newest - 1 : Infinity); this.writeUnreadState({ lastActivityAt, lastViewedAt, isManuallyUnread: true, unreadCount: Math.max(current.unreadCount, 1) }); }
  markRead(at = Date.now()): void { const current = this.getUnreadState(); this.writeUnreadState({ ...current, lastViewedAt: Math.max(current.lastActivityAt, at), isManuallyUnread: false, unreadCount: 0 }); }
  getAutomationSpendGuardState(): SpendGuardState { return resolveSpendGuardState({ state: this.readKv(KV.spendGuard), legacyNudgedAt: this.readKv(KV.spendGuardLegacy) }); }
  setAutomationSpendGuardState(state: SpendGuardState): void { const raw = serializeSpendGuardState(state); if (raw == null) this.deleteKv(KV.spendGuard); else this.writeKv(KV.spendGuard, raw); this.deleteKv(KV.spendGuardLegacy); }

  getAwaitingUserResponse(): AwaitingUserResponse | null { return parseAwaitingState(this.readKv(KV.awaiting)); }
  setAwaitingUserResponse(state: AwaitingUserResponse | null): boolean { const current = this.getAwaitingUserResponse(); if (JSON.stringify(current) === JSON.stringify(state)) return false; const wrote = state == null ? this.deleteKv(KV.awaiting) : this.writeKv(KV.awaiting, JSON.stringify(state)); if (wrote) this.notify(this.awaitingListeners); return wrote; }
  setAwaitingUserResponseForTab(tabId: string, state: AwaitingUserResponse | null, options?: { ifSinceBefore?: number }): boolean { const current = this.getAwaitingUserResponse(); if (current != null && current.tabId !== tabId) return false; if (state == null && (current == null || (options?.ifSinceBefore != null && current.since >= options.ifSinceBefore))) return false; if (state != null && state.tabId !== tabId) return false; return this.setAwaitingUserResponse(state); }
  subscribeAwaitingUserResponse(listener: () => void): () => void { this.awaitingListeners.add(listener); return () => this.awaitingListeners.delete(listener); }

  getRequestIds(): RequestRecord[] { const records = parseRequestRecords(this.readKv(KV.requestIds)); if (records.length) return records; const legacy = this.readKv(KV.latestRequestId)?.trim(); return legacy ? [{ id: legacy, at: 0 }] : []; }
  recordRequestId(id: string, at = Date.now(), prompt?: string, source?: string): void { const trimmed = id.trim(); if (!trimmed) return; const records = this.getRequestIds(); if (records.at(-1)?.id === trimmed) return; const label = prompt?.trim().slice(0, REQUEST_ID_PROMPT_MAX); const record: RequestRecord = { id: trimmed, at, ...(label ? { prompt: label } : {}), ...(source ? { source } : {}) }; this.writeKv(KV.requestIds, JSON.stringify([...records, record].slice(-REQUEST_ID_HISTORY_MAX))); }
  getAgentOrigin(): "dev" | "user" { return this.readKv(KV.origin) === "dev" ? "dev" : "user"; }
  setAgentOrigin(origin: "dev" | "user"): void { this.writeKv(KV.origin, origin); }
  getIntroductionPending(): boolean { return this.readKv(KV.introduction) === "1"; }
  setIntroductionPending(pending: boolean): void { if (pending) this.writeKv(KV.introduction, "1"); else this.deleteKv(KV.introduction); }
  private readVersion(key: string): number { const value = Number.parseInt(this.readKv(key) ?? "", 10); return Number.isFinite(value) && value > 0 ? value : 0; }
  getHiddenEntryRepairVersion(): number { return this.readVersion(KV.hiddenRepair); }
  setHiddenEntryRepairVersion(version: number): boolean { return this.writeKv(KV.hiddenRepair, String(version)); }
  getStaleRootCleanupVersion(): number { return this.readVersion(KV.staleRootCleanup); }
  setStaleRootCleanupVersion(version: number): boolean { return this.writeKv(KV.staleRootCleanup, String(version)); }
  getConversationPartnerIds(): string[] { try { const parsed: unknown = JSON.parse(this.readKv(KV.partners) ?? "[]"); return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []; } catch { return []; } }
  addConversationPartner(partnerId: string): void { const id = partnerId.trim(); if (!id || id === this.get("agentId")) return; const values = new Set(this.getConversationPartnerIds()); if (values.has(id)) return; values.add(id); this.writeKv(KV.partners, JSON.stringify([...values].sort())); }

  hasLegacyConversationBlobs(): boolean { if (this.closed) return false; return this.db.prepare("SELECT 1 present FROM blobs LIMIT 1").get() != null; }
  getTranscriptEntries(): TranscriptEntry[] { if (this.closed) return []; return (this.statements.listTranscriptEntries!.all() as Array<{ entry?: unknown }>).flatMap((row) => typeof row.entry === "string" ? (parseTranscriptEntry(row.entry) as TranscriptEntry | null) ?? [] : []); }
  getNewestDividerAnchorTimestampMs(): number { if (this.closed) return 0; const value = (this.statements.newestDividerAnchorTimestamp!.get() as { timestampMs?: unknown } | undefined)?.timestampMs; return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0; }
  private transcriptPageStatements(): TranscriptPageStatements {
    return {
      listTranscriptPage: this.statements.listTranscriptPage as TranscriptPageStatements["listTranscriptPage"],
      listTranscriptWindow: this.statements.listTranscriptWindow as TranscriptPageStatements["listTranscriptWindow"],
      listTranscriptTail: this.statements.listTranscriptTail as TranscriptPageStatements["listTranscriptTail"]
    };
  }
  getTranscriptPage(query: { beforeSeq?: number; sinceMs?: number; untilMs: number; limit: number }) { return this.closed ? { entries: [] } : readTranscriptPage(this.transcriptPageStatements(), query, this.agentDirName); }
  getTranscriptWindow(query: { beforeSeq?: number; limit: number }) { return this.closed ? { entries: [] } : readTranscriptWindow(this.transcriptPageStatements(), query, entries => this.threadCountsFor(entries as TranscriptEntry[]), this.agentDirName); }
  getTranscriptTail(query: { beforeSeq?: number; limit: number }) { return this.closed ? { entries: [] } : readTranscriptTail(this.transcriptPageStatements(), query, this.agentDirName); }
  getThread(rootId: string) { if (this.closed) return { entries: [] }; const root = this.getEntryById(rootId); const descendants = threadDescendants(rootId, this.getBranchedEntries()); return { entries: root == null ? descendants : [root, ...descendants] }; }
  getBranchedEntries(): TranscriptEntry[] { if (this.closed) return []; return (this.statements.listBranchedEntries!.all() as Array<{ entry?: unknown }>).flatMap((row) => typeof row.entry === "string" ? (parseTranscriptEntry(row.entry) as TranscriptEntry | null) ?? [] : []); }
  threadCountsFor(entries: readonly TranscriptEntry[]): Record<string, number> { const counts = branchReplyCounts(this.getBranchedEntries()); const result: Record<string, number> = {}; for (const entry of entries) { const count = counts.get(entry.id); if (count !== undefined) result[entry.id] = count; } return result; }
  getEntryById(id: string): TranscriptEntry | null { if (this.closed) return null; const row = this.statements.getTranscriptEntry!.get(id) as { entry?: unknown } | undefined; return typeof row?.entry === "string" ? parseTranscriptEntry(row.entry) as TranscriptEntry | null : null; }
  appendTranscriptEntry(entry: TranscriptEntry): boolean { let inserted = false; const committed = this.runWrite("appendTranscriptEntry", () => { inserted = Number((this.statements.insertTranscriptEntry!.run(entry.id, JSON.stringify(entry)) as { changes?: unknown }).changes) > 0; }); if (committed && inserted) publishTranscriptMutation({ kind: "entries-upserted", agentId: this.agentDirName, entries: [entry] }); return committed && inserted; }
  appendTranscriptEntries(entries: readonly TranscriptEntry[]): boolean { if (!entries.length) return true; const inserted: TranscriptEntry[] = []; const committed = this.runWrite("appendTranscriptEntries", () => { this.db.exec("BEGIN IMMEDIATE"); try { for (const entry of entries) if (Number((this.statements.insertTranscriptEntry!.run(entry.id, JSON.stringify(entry)) as { changes?: unknown }).changes) > 0) inserted.push(entry); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } }); if (committed && inserted.length) publishTranscriptMutation({ kind: "entries-upserted", agentId: this.agentDirName, entries: inserted }); return committed; }
  updateTranscriptEntry(id: string, update: (entry: TranscriptEntry) => TranscriptEntry): TranscriptEntry | null { const current = this.getEntryById(id); if (current == null) return null; const next = update(current); const committed = this.runWrite("updateTranscriptEntry", () => { this.statements.updateTranscriptEntry!.run(JSON.stringify(next), id); }); if (!committed) return null; publishTranscriptMutation({ kind: "entries-upserted", agentId: this.agentDirName, entries: [next] }); return next; }
  deleteTranscriptEntry(id: string): boolean { const committed = this.runWrite("deleteTranscriptEntry", () => { this.statements.deleteTranscriptEntry!.run(id); }); if (committed) publishTranscriptMutation({ kind: "entry-deleted", agentId: this.agentDirName, entryId: id }); return committed; }
  /** Entry ids are positional per turn, so deleted ids stay retired forever to keep minting from colliding with references to them. */
  getRetiredEntryIds(): ReadonlySet<string> { if (this.retiredEntryIdCache == null) { let parsed: unknown; try { parsed = JSON.parse(this.readKv(KV.retiredEntryIds) ?? "[]"); } catch { parsed = []; } this.retiredEntryIdCache = new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []); } return this.retiredEntryIdCache; }
  addRetiredEntryIds(ids: readonly string[]): void { const next = new Set(this.getRetiredEntryIds()), before = next.size; for (const id of ids) if (id.length > 0) next.add(id); if (next.size === before) return; if (this.writeKv(KV.retiredEntryIds, JSON.stringify([...next]))) this.retiredEntryIdCache = next; }

  getPendingEpisodeTurns() { return parsePendingEpisodeTurns(this.readKv(KV.episode)); }
  recordEpisodeTurn(turn: { ts: number; user: string; agent: string }): void { const capped = { ts: turn.ts, user: turn.user.slice(0, EPISODE_TURN_TEXT_CAP), agent: turn.agent.slice(0, EPISODE_TURN_TEXT_CAP) }; this.writeKv(KV.episode, JSON.stringify([...this.getPendingEpisodeTurns(), capped].slice(-EPISODE_PENDING_MAX))); }
  clearPendingEpisodeTurns(): void { this.deleteKv(KV.episode); }
  getMemoryPromptSnapshot() { return parseMemoryPromptSnapshot(this.readKv(KV.memorySnapshot)); }
  setMemoryPromptSnapshot(snapshot: unknown): void { this.writeKv(KV.memorySnapshot, JSON.stringify(snapshot)); }
  clearMemoryPromptSnapshot(): void { this.deleteKv(KV.memorySnapshot); }
  getAgentProfilePromptSnapshot(): unknown { try { return JSON.parse(this.readKv(KV.profileSnapshot) ?? "null") as unknown; } catch { return null; } }
  setAgentProfilePromptSnapshot(snapshot: unknown): void { this.writeKv(KV.profileSnapshot, JSON.stringify(snapshot)); }
  clearAgentProfilePromptSnapshot(): void { this.deleteKv(KV.profileSnapshot); }
  clearTransientState(): void { for (const key of [KV.unread, KV.spendGuardLegacy, KV.spendGuard, KV.awaiting, KV.latestRequestId, KV.requestIds, KV.episode, KV.memorySnapshot, KV.profileSnapshot]) this.deleteKv(key); }
  clearConversation(): boolean { if (this.closed) return false; const metadata = this.readMetadata(); const committed = this.runWrite("clearConversation", () => { this.db.exec("BEGIN IMMEDIATE"); try { this.statements.clearBlobs!.run(); this.statements.clearTranscriptEntries!.run(); for (const key of [KV.awaiting, KV.latestRequestId, KV.requestIds, KV.episode, KV.memorySnapshot, KV.profileSnapshot]) this.statements.deleteKv!.run(key); this.statements.setKv!.run(KV.metadata, this.serializeMetadata({ ...metadata, latestRootBlobId: new Uint8Array(), currentPlanUri: "" })); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } }); if (!committed) return false; publishTranscriptMutation({ kind: "conversation-cleared", agentId: this.agentDirName }); this.notify(this.awaitingListeners); this.notify(this.listeners.get("latestRootBlobId") ?? new Set()); return true; }
  getAgentPurpose(): string | null { const value = this.readKv(KV.purpose); return value && /^[a-z][a-z0-9_-]*$/.test(value) ? value : null; }
  setAgentPurpose(purpose: string): void { this.writeKv(KV.purpose, purpose); }
  clearAgentPurpose(): void { this.deleteKv(KV.purpose); }
  getLegacyBlobRetirementVersion(): number { return this.readVersion(KV.legacyBlobRetirement); }
  retireLegacyConversationBlobs(version: number): boolean { if (this.closed) return false; return this.runWrite("retireLegacyConversationBlobs", () => { this.db.exec("BEGIN IMMEDIATE"); try { this.db.exec("DELETE FROM blobs"); this.db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(KV.legacyBlobRetirement, String(version)); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } }); }
  getMainTranscriptEntries(): readonly TranscriptEntry[] { return getMainTranscriptEntries(this.getTranscriptEntries()) as readonly TranscriptEntry[]; }
}
