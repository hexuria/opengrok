import { randomUUID } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { getSandProfilePath, writeSandProfileFile, type SandAgentProfile } from "../../agents/agent-profile.js";
import { getSandSettingsPath, writeSandSettingsFile } from "../../agents/settings-file.js";
import { SandAgentDb } from "./agent-db.js";
import { getAgentDbPath } from "./session-paths.js";
import { automationStoreForDbPath, channelStoreForDbPath, workflowStoreForDbPath } from "./session-store-factories.js";
import type { AgentWorkerPool } from "../../agent-isolation/agent-worker-pool.js";

export const MAX_AGENTS_PER_USER = 50;
export const DEFAULT_AGENT_AUTOMATIONS: readonly unknown[] = [];
export class SandAgentMissingError extends Error { constructor(agentId: string) { super(`Sand agent ${agentId} does not exist`); this.name = "SandAgentMissingError"; } }
export class SandAgentLimitError extends Error { constructor() { super(`Agent limit of ${MAX_AGENTS_PER_USER} reached`); this.name = "SandAgentLimitError"; } }

export interface WorkerPool { closeAll(): Promise<void> }
export interface MaterializedSession {
  id: string;
  dbPath: string;
  db: SandAgentDb;
  agentStore: { resetFromDb?(ctx: unknown): Promise<void>; getFullConversation(ctx: unknown): Promise<unknown>; dispose(): Promise<void> };
  memory: unknown;
  automations: ReturnType<typeof automationStoreForDbPath>;
  workflows: ReturnType<typeof workflowStoreForDbPath>;
  channels: ReturnType<typeof channelStoreForDbPath>;
}
export interface MaterializationHost {
  ctx: unknown;
  rootDir: string;
  createBlobWorkerPool(): AgentWorkerPool;
  createAgentStore(args: { pool: AgentWorkerPool; agentId: string; dbPath: string; db: SandAgentDb }): MaterializedSession["agentStore"];
  createMemoryStore(agentDir: string): unknown;
  resolveUserTimeZone(): string | undefined;
  agentExists(agentId: string): boolean;
  getAgentDir(agentId: string): string;
  readActiveAgentId(): string | null;
  isVisibleAgent?(agentId: string): Promise<boolean>;
  runMaintenance?(session: MaterializedSession): Promise<void>;
  report?(event: Record<string, unknown>): void;
}

export class SandSessionMaterialization {
  private workerPool: AgentWorkerPool | null = null;
  private mintChain = Promise.resolve();
  constructor(readonly host: MaterializationHost) {}

  requireWorkerPool(): AgentWorkerPool { this.workerPool ??= this.host.createBlobWorkerPool(); return this.workerPool; }
  async closeWorkerPool(): Promise<void> { const pool = this.workerPool; if (pool == null) return; this.workerPool = null; await pool.closeAll(); }
  async listAgentRecordIds(): Promise<string[]> { try { return (await readdir(this.host.rootDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
  async countOwnedAgents(): Promise<number> { return (await this.listAgentRecordIds()).length; }
  enqueueMint<T>(run: () => Promise<T>): Promise<T> { const next = this.mintChain.then(run, run); this.mintChain = next.then(() => {}, () => {}); return next; }

  async mintAgent<T>(mint: (agentId: string) => Promise<T>): Promise<T> {
    return this.enqueueMint(async () => { if (await this.isAgentCapReached()) throw new SandAgentLimitError(); return this.runMint(randomUUID(), mint); });
  }
  private async runMint<T>(agentId: string, mint: (agentId: string) => Promise<T>): Promise<T> {
    try { return await mint(agentId); }
    catch (error) { try { await rm(this.host.getAgentDir(agentId), { recursive: true, force: true }); } catch (cleanupError) { this.host.report?.({ family: "materialize", kind: "mint_cleanup_failed", agentId, errorClass: cleanupError instanceof Error ? cleanupError.name : typeof cleanupError }); } throw error; }
  }
  async createSession(profile?: Partial<SandAgentProfile>, origin: "user" | "dev" = "user", purpose?: string): Promise<MaterializedSession> { return this.mintAgent((agentId) => this.materializeSession(agentId, profile, origin, purpose)); }
  async createFallbackSession(open: (agentId: string) => Promise<MaterializedSession>): Promise<MaterializedSession> {
    return this.enqueueMint(async () => {
      const ids = await this.listAgentRecordIds();
      for (const agentId of ids) {
        try { return await open(agentId); }
        catch (error) {
          this.host.report?.({ family: "materialize", kind: "fallback_adopt_failed", agentId, errorClass: error instanceof Error ? error.name : typeof error });
        }
      }
      if (ids.length > 0) throw new Error("Existing local agents could not be opened.");
      if (await this.isAgentCapReached()) throw new SandAgentLimitError();
      return this.runMint(randomUUID(), (agentId) => this.materializeSession(agentId, undefined, "user"));
    });
  }
  private compose(agentId: string, dbPath: string, db: SandAgentDb): MaterializedSession {
    return { id: agentId, dbPath, db, agentStore: this.host.createAgentStore({ pool: this.requireWorkerPool(), agentId, dbPath, db }), memory: this.host.createMemoryStore(dirname(dbPath)), automations: automationStoreForDbPath(dbPath, this.host.resolveUserTimeZone), workflows: workflowStoreForDbPath(dbPath, this.host.resolveUserTimeZone), channels: channelStoreForDbPath(dbPath) };
  }
  async materializeSession(agentId: string, profile?: Partial<SandAgentProfile>, origin: "user" | "dev" = "user", purpose?: string): Promise<MaterializedSession> {
    const dbPath = getAgentDbPath(this.host.rootDir, agentId), db = new SandAgentDb(dbPath);
    try {
      db.set("agentId", agentId); db.setAgentOrigin(origin); if (purpose != null) db.setAgentPurpose(purpose);
      writeSandProfileFile(getSandProfilePath(dirname(dbPath)), { name: profile?.name?.trim() || "Grok", description: profile?.description?.trim() ?? "", title: profile?.title?.trim() ?? "", avatarShape: profile?.avatarShape?.trim() ?? "", avatarColor: profile?.avatarColor?.trim() ?? "" });
      writeSandSettingsFile(getSandSettingsPath(dirname(dbPath)), { notifyOnAgentUpdates: true });
      const session = this.compose(agentId, dbPath, db);
      for (const spec of DEFAULT_AGENT_AUTOMATIONS) session.automations.upsert(spec as never);
      return session;
    } catch (error) { db.close(); throw error; }
  }
  async openSession(agentId: string): Promise<MaterializedSession> {
    if (!this.host.agentExists(agentId)) throw new SandAgentMissingError(agentId);
    const dbPath = getAgentDbPath(this.host.rootDir, agentId), db = new SandAgentDb(dbPath);
    try {
      const profilePath = getSandProfilePath(dirname(dbPath));
      try { await stat(profilePath); } catch { writeSandProfileFile(profilePath, { name: db.get("name") || "Grok", description: db.getSandProfile().description, title: "", avatarShape: "", avatarColor: "" }); }
      const session = this.compose(agentId, dbPath, db);
      await session.agentStore.resetFromDb?.(this.host.ctx);
      await this.host.runMaintenance?.(session);
      return session;
    } catch (error) { db.close(); throw error; }
  }
  async isAgentCapReached(): Promise<boolean> { if (await this.countOwnedAgents() < MAX_AGENTS_PER_USER) return false; await this.reclaimPrunedPlaceholders(); return await this.countOwnedAgents() >= MAX_AGENTS_PER_USER; }
  async isPrunedPlaceholder(agentId: string): Promise<boolean> { try { await stat(getAgentDbPath(this.host.rootDir, agentId)); } catch { return false; } if (agentId === this.host.readActiveAgentId()) return false; return this.host.isVisibleAgent != null ? !(await this.host.isVisibleAgent(agentId)) : false; }
  async reclaimPrunedPlaceholders(): Promise<void> { for (const agentId of await this.listAgentRecordIds()) { if (!await this.isPrunedPlaceholder(agentId)) continue; try { await rm(this.host.getAgentDir(agentId), { recursive: true, force: true }); } catch (error) { this.host.report?.({ family: "materialize", kind: "placeholder_reclaim_failed", agentId, errorClass: error instanceof Error ? error.name : typeof error }); } } }
}
