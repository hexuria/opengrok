import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorLogTag } from "../../../shared/errors.js";
import { getSandProfilePath, readSandProfileFile, writeSandProfileFile, type SandAgentProfile } from "../../agents/agent-profile.js";
import { getSandSettingsPath, writeSandSettingsFile } from "../../agents/settings-file.js";
import { AUTOMATION_UI_LIMIT } from "../../automations/automation.js";
import { getSandAgentsRootDir } from "../../storage/agent-paths.js";
import { deleteSandAgentDbWriteGeneration, getSandAgentDbWriteGeneration } from "../../storage/store-db.js";
import { limitSurfacedWorkflows, type WorkflowSpec } from "../../../shared/workflow-model.js";
import { SandAgentDb, type AwaitingUserResponse, type TranscriptEntry } from "./agent-db.js";
import { recoverAgentWithMissingDb, setAgentAvatarBytes } from "./session-mutations.js";
import { getAgentAvatar, getAgentAvatarPng, getAgentProfileText, updateAgentProfile } from "./session-profile-files.js";
import { listAgents, summarizeAgentById } from "./session-roster.js";
import { buildSummary, loadAgentDbExtras, type DbExtras } from "./session-summaries.js";
import { SandConnectorSecretStore } from "./connector-secret-store.js";
import { ensureConversationCapacityForTurn } from "./conversation-size-limits.js";
import { expirePendingAutoReviewApprovalEntries, expirePendingLocalToolPermissionAskEntries } from "./pending-card-sweeps.js";
import { ACTIVE_AGENT_FILENAME, getAgentDbPath, getConnectorSecretsRoot, statIfExists } from "./session-paths.js";
import { automationStoreForDbPath, channelStoreForDbPath, NO_SESSION_MEMORY, workflowStoreForDbPath } from "./session-store-factories.js";
import { publishTranscriptMutation } from "../../transcript-mutation-events.js";
import { reportSessionDiagnostic } from "./session-diagnostics.js";

export interface OpenAgentSession {
  id: string;
  dbPath: string;
  db: SandAgentDb;
  agentStore: { getFullConversation?(ctx: unknown): Promise<unknown>; dispose(): Promise<void> };
}
export interface SessionMemoryProvider {
  agentHasContent(agentDir: string): boolean;
  createAgentStore?(agentDir: string): unknown;
}
export interface MaterializationPort {
  closeWorkerPool?(): Promise<void>;
  listAgentRecordIds?(): Promise<string[]>;
  countOwnedAgents?(): Promise<number>;
  mintAgent?(mint: (agentId: string) => Promise<OpenAgentSession>): Promise<OpenAgentSession>;
  createSession?(profile: Partial<SandAgentProfile>, origin: "user" | "dev", purpose?: string): Promise<OpenAgentSession>;
  createFallbackSession?(open: (agentId: string) => Promise<OpenAgentSession>): Promise<OpenAgentSession>;
  openSession?(agentId: string): Promise<OpenAgentSession>;
  requireWorkerPool?(): { collectConversationGarbage(args: Record<string, unknown>): Promise<unknown> };
  isAgentCapReached?(): Promise<boolean>;
}
export interface ConversationStatePort {
  getTranscriptEntries(session: OpenAgentSession): Promise<TranscriptEntry[]>;
  getSessionOutline(session: OpenAgentSession): Promise<unknown>;
  getAgentOutline(agentId: string): Promise<unknown>;
  getAgentTranscriptEntries(agentId: string): Promise<TranscriptEntry[]>;
  readAgentTranscriptEntries(agentId: string): TranscriptEntry[];
  readAgentTranscriptPage(agentId: string, query: { beforeSeq?: number; sinceMs?: number; untilMs: number; limit: number }): ReturnType<SandAgentDb["getTranscriptPage"]>;
  readAgentTranscriptWindow(agentId: string, query: { beforeSeq?: number; limit: number }): ReturnType<SandAgentDb["getTranscriptWindow"]>;
  readAgentTranscriptTail(agentId: string, query: { beforeSeq?: number; limit: number }): ReturnType<SandAgentDb["getTranscriptTail"]>;
  readAgentThread(agentId: string, rootId: string): ReturnType<SandAgentDb["getThread"]>;
}
export interface AgentSessionStoreOptions {
  materialization?: MaterializationPort;
  createMaterialization?(store: SandAgentSessionStore): MaterializationPort;
  conversationState?: ConversationStatePort;
  createConversationState?(store: SandAgentSessionStore): ConversationStatePort;
  onAgentRemoved?(agentId: string): void;
}

export function resolveProfileName(trimmedName: string, current?: { name?: string } | null): string { if (trimmedName) return trimmedName; if (current?.name?.trim()) return current.name; return "Grok"; }

export class SandAgentSessionStore {
  private memory: SessionMemoryProvider = NO_SESSION_MEMORY;
  private isAgentBeingDeleted: (id: string) => boolean = () => false;
  private resolveUserTimeZone: () => string | undefined;
  private readonly extrasCache = new Map<string, { key: string; extras: DbExtras }>();
  readonly connectorSecrets: SandConnectorSecretStore;
  readonly materialization: MaterializationPort | undefined;
  readonly conversationState: ConversationStatePort | undefined;

  constructor(readonly rootDir = getSandAgentsRootDir(), resolveUserTimeZone: () => string | undefined = () => undefined, readonly options: AgentSessionStoreOptions = {}) {
    this.resolveUserTimeZone = resolveUserTimeZone;
    this.connectorSecrets = new SandConnectorSecretStore(getConnectorSecretsRoot(rootDir));
    this.materialization = options.materialization ?? options.createMaterialization?.(this);
    this.conversationState = options.conversationState ?? options.createConversationState?.(this);
  }
  getRootDir(): string { return this.rootDir; }
  setMemory(memory: SessionMemoryProvider): void { this.memory = memory; }
  createMemoryStore(agentDir: string): unknown { return this.memory.createAgentStore?.(agentDir) ?? NO_SESSION_MEMORY.createAgentStore(); }
  setBeingDeletedPredicate(predicate: (id: string) => boolean): void { this.isAgentBeingDeleted = predicate; }
  setUserTimeZoneResolver(resolve: () => string | undefined): void { this.resolveUserTimeZone = resolve; }
  getUserTimeZone(): string | undefined { return this.resolveUserTimeZone(); }
  async closeWorkerPool(): Promise<void> { await this.materialization?.closeWorkerPool?.(); }
  async listAgentRecordIds(): Promise<string[]> { return this.materialization?.listAgentRecordIds?.() ?? this.listAgentIds(); }
  async countOwnedAgents(): Promise<number> { return this.materialization?.countOwnedAgents?.() ?? (await this.listAgentIds()).length; }

  getAgentDir(agentId: string): string { return join(this.rootDir, agentId); }
  agentExists(agentId: string): boolean { return existsSync(getAgentDbPath(this.rootDir, agentId)); }
  agentDirExists(agentId: string): boolean { return existsSync(this.getAgentDir(agentId)); }
  writeAgentProfileFile(agentId: string, profile: Partial<SandAgentProfile> & { name: string; description: string }): void {
    const path = getSandProfilePath(this.getAgentDir(agentId)), current = readSandProfileFile(path), name = resolveProfileName(profile.name.trim(), current);
    writeSandProfileFile(path, { name, description: profile.description.trim(), title: profile.title?.trim() ?? current?.title ?? "", avatarShape: profile.avatarShape?.trim() ?? current?.avatarShape ?? "", avatarColor: profile.avatarColor?.trim() ?? current?.avatarColor ?? "" });
  }
  async withAgentDb<T>(agentId: string, fn: (db: SandAgentDb, dbPath: string) => T | Promise<T>): Promise<T> { const dbPath = getAgentDbPath(this.rootDir, agentId), db = new SandAgentDb(dbPath); try { return await fn(db, dbPath); } finally { db.close(); } }

  private async createLocalSession(profile: Partial<SandAgentProfile>, origin: "user" | "dev", purpose?: string): Promise<OpenAgentSession> {
    let id = randomUUID(); while (this.agentDirExists(id)) id = randomUUID();
    mkdirSync(this.getAgentDir(id), { recursive: true });
    this.writeAgentProfileFile(id, { name: profile.name ?? "Grok", description: profile.description ?? "", ...(profile.title == null ? {} : { title: profile.title }), ...(profile.avatarShape == null ? {} : { avatarShape: profile.avatarShape }), ...(profile.avatarColor == null ? {} : { avatarColor: profile.avatarColor }) });
    const dbPath = getAgentDbPath(this.rootDir, id), db = new SandAgentDb(dbPath); db.set("agentId", id); db.setAgentOrigin(origin); if (purpose != null) db.setAgentPurpose(purpose); db.setIntroductionPending(true);
    return { id, dbPath, db, agentStore: { dispose: async () => {} } };
  }
  async createSession(profile: Partial<SandAgentProfile>, origin: "user" | "dev" = "user", purpose?: string): Promise<OpenAgentSession> { return this.materialization?.createSession != null ? this.materialization.createSession(profile, origin, purpose) : this.createLocalSession(profile, origin, purpose); }
  async mintAgent(mint: (agentId: string) => Promise<OpenAgentSession>): Promise<OpenAgentSession> { if (this.materialization?.mintAgent != null) return this.materialization.mintAgent(mint); let id = randomUUID(); while (this.agentDirExists(id)) id = randomUUID(); return mint(id); }
  async createFallbackSession(open: (agentId: string) => Promise<OpenAgentSession>): Promise<OpenAgentSession> { if (this.materialization?.createFallbackSession != null) return this.materialization.createFallbackSession(open); const [agentId] = await this.listAgentIds(); if (agentId == null) throw new Error("No fallback session is available"); return open(agentId); }
  async openSession(agentId: string): Promise<OpenAgentSession> { if (this.materialization?.openSession != null) return this.materialization.openSession(agentId); if (!this.agentExists(agentId)) throw new Error(`Agent missing: ${agentId}`); const dbPath = getAgentDbPath(this.rootDir, agentId); return { id: agentId, dbPath, db: new SandAgentDb(dbPath), agentStore: { dispose: async () => {} } }; }
  async deleteSession(agentId: string): Promise<void> { const dbPath = getAgentDbPath(this.rootDir, agentId); this.extrasCache.delete(agentId); deleteSandAgentDbWriteGeneration(dbPath); await rm(this.getAgentDir(agentId), { recursive: true, force: true }); publishTranscriptMutation({ kind: "agent-removed", agentId }); this.options.onAgentRemoved?.(agentId); }

  activeAgentPointerPath(): string { return join(this.rootDir, ACTIVE_AGENT_FILENAME); }
  readActiveAgentId(): string | null { try { const parsed = JSON.parse(readFileSync(this.activeAgentPointerPath(), "utf8")) as { activeAgentId?: unknown }; const id = parsed.activeAgentId; return typeof id === "string" && id.length > 0 ? id : null; } catch { return null; } }
  writeActiveAgentId(agentId: string): void { try { mkdirSync(this.rootDir, { recursive: true }); const path = this.activeAgentPointerPath(), temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify({ activeAgentId: agentId })); renameSync(temp, path); } catch {} }

  async updateAgentProfile(agentId: string, profile: Partial<SandAgentProfile> & { name: string; description: string }): Promise<Record<string, unknown> | null> { return updateAgentProfile(this.profileFilesHost(), agentId, profile); }
  getAgentProfileText(agentId: string): SandAgentProfile | null { return getAgentProfileText(this, agentId); }
  getAgentAvatar(agentId: string) { return getAgentAvatar(this, agentId); }
  getAgentAvatarPng(agentId: string) { return getAgentAvatarPng(this, agentId); }
  async setAgentAvatarBytes(db: SandAgentDb, dbPath: string, agentId: string, pngBytes: Uint8Array | null, activeAgentId?: string) { return setAgentAvatarBytes({ memory: this.memory }, db, dbPath, agentId, pngBytes, activeAgentId); }
  async setAgentAvatarBytesById(agentId: string, pngBytes: Uint8Array | null) { return this.withAgentDb(agentId, (db, dbPath) => this.setAgentAvatarBytes(db, dbPath, agentId, pngBytes, undefined)); }
  async summarizeOpenSession(session: OpenAgentSession): Promise<Record<string, unknown> | null> {
    const dbStats = await statIfExists(session.dbPath);
    if (this.isAgentBeingDeleted(session.id)) return null;
    return await buildSummary({
      extras: loadAgentDbExtras(session.db, session.dbPath, session.id, dbStats),
      dbPath: session.dbPath,
      dirName: session.id,
      ...(dbStats === undefined ? {} : { dbStats }),
      activeAgentId: session.id,
      includeBlank: true,
      agentHasMemory: candidate => this.memory.agentHasContent(candidate),
    });
  }
  async summarizeSession(session: OpenAgentSession, activeAgentId?: string): Promise<Record<string, unknown> | null> {
    const dbStats = await statIfExists(session.dbPath);
    if (this.isAgentBeingDeleted(session.id)) return null;
    const extras = dbStats == null
      ? loadAgentDbExtras(session.db, session.dbPath, session.id, dbStats)
      : await this.loadCachedExtras({
          dirName: session.id,
          dbPath: session.dbPath,
          dbStats,
          readExtras: () => loadAgentDbExtras(session.db, session.dbPath, session.id, dbStats),
        });
    if (this.isAgentBeingDeleted(session.id)) return null;
    return await buildSummary({
      extras,
      dbPath: session.dbPath,
      dirName: session.id,
      ...(dbStats === undefined ? {} : { dbStats }),
      ...(activeAgentId === undefined ? {} : { activeAgentId }),
      includeBlank: true,
      agentHasMemory: candidate => this.memory.agentHasContent(candidate),
    });
  }
  private async loadCachedExtras(args: { dirName: string; dbPath: string; dbStats: { size: number; mtimeMs: number }; readExtras?: () => DbExtras | null }): Promise<DbExtras | null> {
    const walStats = await statIfExists(`${args.dbPath}-wal`);
    const generation = getSandAgentDbWriteGeneration(args.dbPath);
    const key = `${generation}:${args.dbStats.size}:${args.dbStats.mtimeMs}:${walStats?.size ?? -1}:${walStats?.mtimeMs ?? -1}`;
    const cached = this.extrasCache.get(args.dirName);
    if (cached?.key === key && existsSync(getSandProfilePath(join(this.rootDir, args.dirName)))) return cached.extras;
    if (this.isAgentBeingDeleted(args.dirName)) return null;
    const extras = args.readExtras?.() ?? this.readExtrasFromDisk(args.dbPath, args.dirName, args.dbStats);
    if (extras != null) this.extrasCache.set(args.dirName, { key, extras });
    return extras;
  }
  private readExtrasFromDisk(dbPath: string, dirName: string, dbStats: { size: number; mtimeMs: number }): DbExtras | null {
    let db: SandAgentDb;
    try { db = new SandAgentDb(dbPath, { recoverOnCorruption: false }); }
    catch (error) {
      reportSessionDiagnostic({ family: "store_db", kind: "unreadable", agentId: dirName, errorClass: errorLogTag(error) });
      return null;
    }
    try { return loadAgentDbExtras(db, dbPath, dirName, dbStats); }
    finally { db.close(); }
  }
  private reseedMinimalStoreDbIfMissing(dbPath: string): void { const db = new SandAgentDb(dbPath); db.close(); }
  private rosterHost() { return { rootDir: this.rootDir, isAgentBeingDeleted: (id: string) => this.isAgentBeingDeleted(id), memory: this.memory, loadCachedExtras: (args: { dirName: string; dbPath: string; dbStats: { size: number; mtimeMs: number } }) => this.loadCachedExtras(args), recoverAgentWithMissingDb: (args: { dbPath: string; dirName: string; activeAgentId?: string }) => recoverAgentWithMissingDb({ memory: this.memory, isAgentBeingDeleted: (id: string) => this.isAgentBeingDeleted(id), reseedMinimalStoreDbIfMissing: (path: string) => this.reseedMinimalStoreDbIfMissing(path) }, args), pruneExtrasCache: (ids: Set<string>) => { for (const id of this.extrasCache.keys()) if (!ids.has(id)) this.extrasCache.delete(id); } }; }
  async summarizeAgentById(agentId: string, activeAgentId?: string): Promise<Record<string, unknown> | null> { return summarizeAgentById(this.rosterHost(), agentId, activeAgentId); }
  async listAgents(activeAgentId?: string): Promise<Record<string, unknown>[]> { return listAgents(this.rosterHost(), activeAgentId); }
  async listAgentIds(): Promise<string[]> { try { return (await readdir(this.rootDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }

  async getTranscriptEntries(session: OpenAgentSession): Promise<TranscriptEntry[]> { return this.conversationState?.getTranscriptEntries(session) ?? session.db.getTranscriptEntries(); }
  async getSessionOutline(session: OpenAgentSession): Promise<unknown> { if (this.conversationState == null) throw new Error("Session conversation-state provider is required"); return this.conversationState.getSessionOutline(session); }
  async getAgentOutline(agentId: string): Promise<unknown> { if (this.conversationState == null) throw new Error("Session conversation-state provider is required"); return this.conversationState.getAgentOutline(agentId); }
  async getAgentTranscriptEntries(agentId: string): Promise<TranscriptEntry[]> { return this.conversationState?.getAgentTranscriptEntries(agentId) ?? this.withAgentDb(agentId, (db) => db.getTranscriptEntries()); }
  readAgentTranscriptEntries(agentId: string): TranscriptEntry[] { return this.conversationState?.readAgentTranscriptEntries(agentId) ?? []; }
  readAgentTranscriptPage(agentId: string, query: { beforeSeq?: number; sinceMs?: number; untilMs: number; limit: number }) { return this.conversationState?.readAgentTranscriptPage(agentId, query) ?? { entries: [] }; }
  readAgentTranscriptWindow(agentId: string, query: { beforeSeq?: number; limit: number }) { return this.conversationState?.readAgentTranscriptWindow(agentId, query) ?? { entries: [], threadCounts: {} }; }
  readAgentTranscriptTail(agentId: string, query: { beforeSeq?: number; limit: number }) { return this.conversationState?.readAgentTranscriptTail(agentId, query) ?? { entries: [] }; }
  readAgentThread(agentId: string, rootId: string) { return this.conversationState?.readAgentThread(agentId, rootId) ?? { entries: [] }; }

  async markSessionViewed(session: OpenAgentSession, at = Date.now(), options: { preserveManualUnread?: boolean } = {}): Promise<void> { session.db.markViewed(at, options); }
  markSessionViewedNow(session: OpenAgentSession, at = Date.now(), options: { preserveManualUnread?: boolean } = {}): void { session.db.markViewed(at, options); }
  markSessionActivity(session: OpenAgentSession, at = Date.now()): void { session.db.markActivity(at); }
  async markAgentViewed(agentId: string, at = Date.now(), options: { preserveManualUnread?: boolean } = {}): Promise<void> { try { await this.withAgentDb(agentId, (db) => db.markViewed(at, options)); } catch {} }
  async setSessionUnread(agentId: string, unread: boolean, at = Date.now()): Promise<void> { await this.withAgentDb(agentId, (db) => unread ? db.markUnread(at) : db.markRead(at)); }
  setSessionNotifyOnUpdates(agentId: string, enabled: boolean): void { writeSandSettingsFile(getSandSettingsPath(this.getAgentDir(agentId)), { notifyOnAgentUpdates: enabled }); }
  setSessionHiddenFromSidebar(agentId: string, hidden: boolean): void { writeSandSettingsFile(getSandSettingsPath(this.getAgentDir(agentId)), { hiddenFromSidebar: hidden }); }
  async setAwaitingUserResponse(agentId: string, state: AwaitingUserResponse | null): Promise<void> { await this.withAgentDb(agentId, (db) => { db.setAwaitingUserResponse(state); }); }
  async setAwaitingUserResponseForTab(agentId: string, tabId: string, state: AwaitingUserResponse | null, options?: { ifSinceBefore?: number }): Promise<boolean> { return this.withAgentDb(agentId, (db) => db.setAwaitingUserResponseForTab(tabId, state, options)); }
  async expirePendingAutoReviewApprovals(agentId: string, onlyRequestId?: string): Promise<string[]> { return this.withAgentDb(agentId, (db) => expirePendingAutoReviewApprovalEntries(db as never, onlyRequestId)); }
  async expirePendingLocalToolPermissionAsks(args: { agentId: string; onlyRequestId?: string; ifPendingBeforeMs?: number }): Promise<string[]> { return this.withAgentDb(args.agentId, (db) => expirePendingLocalToolPermissionAskEntries(db as never, { ...(args.onlyRequestId == null ? {} : { onlyRequestId: args.onlyRequestId }), ...(args.ifPendingBeforeMs == null ? {} : { ifPendingBeforeMs: args.ifPendingBeforeMs }) })); }
  async clearAgentMemoryPromptSnapshot(agentId: string): Promise<void> { await this.withAgentDb(agentId, (db) => db.clearMemoryPromptSnapshot()); }
  async ensureConversationCapacityForTurn(session: OpenAgentSession): Promise<void> { if (this.materialization?.requireWorkerPool == null) return; await ensureConversationCapacityForTurn({ requireWorkerPool: () => this.materialization?.requireWorkerPool?.() as never }, session.dbPath, session.db); }

  automationStoreFor(agentId: string) { return automationStoreForDbPath(getAgentDbPath(this.rootDir, agentId), this.resolveUserTimeZone); }
  listAgentAutomations(agentId: string) { return this.automationStoreFor(agentId).list().slice(0, AUTOMATION_UI_LIMIT); }
  setAgentAutomationEnabled(agentId: string, automationId: string, enabled: boolean) { const store = this.automationStoreFor(agentId); store.setEnabled(automationId, enabled); return store.list().slice(0, AUTOMATION_UI_LIMIT); }
  createAgentAutomation(agentId: string, spec: Parameters<ReturnType<SandAgentSessionStore["automationStoreFor"]>["upsert"]>[0]) { const store = this.automationStoreFor(agentId); store.upsert(spec); return store.list().slice(0, AUTOMATION_UI_LIMIT); }
  updateAgentAutomation(agentId: string, automationId: string, spec: Parameters<ReturnType<SandAgentSessionStore["automationStoreFor"]>["update"]>[1]) { const store = this.automationStoreFor(agentId); store.update(automationId, spec); return store.list().slice(0, AUTOMATION_UI_LIMIT); }
  removeAgentAutomation(agentId: string, automationId: string) { const store = this.automationStoreFor(agentId); store.remove(automationId); return store.list().slice(0, AUTOMATION_UI_LIMIT); }
  workflowStoreFor(agentId: string) { return workflowStoreForDbPath(getAgentDbPath(this.rootDir, agentId), this.resolveUserTimeZone); }
  async listAgentWorkflows(agentId: string) { return limitSurfacedWorkflows(this.workflowStoreFor(agentId).listAll()); }
  async getAgentWorkflow(agentId: string, workflowId: string) { return this.workflowStoreFor(agentId).get(workflowId); }
  createAgentWorkflow(agentId: string, spec: WorkflowSpec) { const store = this.workflowStoreFor(agentId); store.create(spec); return limitSurfacedWorkflows(store.listAll()); }
  updateAgentWorkflow(agentId: string, workflowId: string, spec: WorkflowSpec) { const store = this.workflowStoreFor(agentId); store.update(workflowId, spec); return limitSurfacedWorkflows(store.listAll()); }
  async setAgentWorkflowEnabled(agentId: string, workflowId: string, enabled: boolean) { const store = this.workflowStoreFor(agentId); store.setEnabledForAgent(workflowId, enabled); return limitSurfacedWorkflows(store.listAll()); }
  removeAgentWorkflow(agentId: string, workflowId: string) { const store = this.workflowStoreFor(agentId); store.remove(workflowId); return limitSurfacedWorkflows(store.listAll()); }
  async importAgentWorkflowMarkdown(agentId: string, markdown: string, fallbackName?: string) { const store = this.workflowStoreFor(agentId), imported = store.importMarkdown(markdown, fallbackName); return { workflows: limitSurfacedWorkflows(store.listAll()), result: imported == null ? { imported: [], skipped: [{ source: "pasted skill", reason: "empty or invalid" }] } : { imported: [imported], skipped: [] } }; }
  async importAgentWorkflowSource(agentId: string, source: string, fallbackName?: string) { const store = this.workflowStoreFor(agentId), imported = store.importLiveSource(source, fallbackName); return { workflows: limitSurfacedWorkflows(store.listAll()), result: imported == null ? { imported: [], skipped: [{ source, reason: "could not link" }] } : { imported: [imported], skipped: [] } }; }
  async portAgentLocalSkills(agentId: string) { const store = this.workflowStoreFor(agentId), result = store.portLocalSkills(homedir(), process.cwd()); return { workflows: limitSurfacedWorkflows(store.listAll()), result }; }

  openChannelStore(agentId: string) { return channelStoreForDbPath(getAgentDbPath(this.rootDir, agentId)); }
  listAgentChannels(agentId: string) { return this.openChannelStore(agentId).listConnections().filter((connection) => this.connectorSecrets.getSecret(agentId, connection.platform, "token") != null); }
  listChannelConfigs(agentId: string): Array<{ platform: string; token: string; label: string }> { const store = this.openChannelStore(agentId), configs = []; for (const platform of store.listPlatforms()) { const token = this.connectorSecrets.getSecret(agentId, platform, "token"); if (token != null) configs.push({ platform, token, label: store.readLabel(platform) ?? platform }); } return configs; }
  storeConnectorCredential(agentId: string, platform: string, field: string, value: string): boolean { if (!this.connectorSecrets.setSecret(agentId, platform, field, value)) return false; this.openChannelStore(agentId).writeMetadata(platform, ""); return true; }
  disconnectChannel(agentId: string, platform: string): boolean { this.connectorSecrets.removeAgentPlatform(agentId, platform); return this.openChannelStore(agentId).remove(platform); }
  async listAllAutomationsFrom(options: { definitionsOnly: boolean }) { const result = []; for (const agentId of await this.listAgentIds()) { try { const store = this.automationStoreFor(agentId), automations = options.definitionsOnly ? store.listDefinitions() : store.list(); for (const automation of automations) result.push({ agentId, automation }); } catch {} } return result; }
  async listAllAutomations() { return this.listAllAutomationsFrom({ definitionsOnly: false }); }
  async listAllAutomationDefinitions() { return this.listAllAutomationsFrom({ definitionsOnly: true }); }
  async isAgentCapReached(): Promise<boolean> { return await this.materialization?.isAgentCapReached?.() ?? false; }
  async statOpenDb(args: { dbPath: string; agentId: string }) { try { return await stat(args.dbPath); } catch { return undefined; } }
  private profileFilesHost() { return { memory: this.memory, withAgentDb: <T>(agentId: string, fn: (db: SandAgentDb, dbPath: string) => T | Promise<T>) => this.withAgentDb(agentId, fn), statOpenDb: (args: { dbPath: string; agentId: string }) => this.statOpenDb(args), writeAgentProfileFile: (agentId: string, profile: Partial<SandAgentProfile> & { name: string; description: string }) => this.writeAgentProfileFile(agentId, profile) }; }
}
