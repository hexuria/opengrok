import { readManagedSkillsCache, writeManagedSkillsCache, type ManagedSkill } from "./managed-skills-cache.js";
import { fetchedManagedSkillToSandSkill, type FetchedManagedSkill } from "./sand-managed-skills.js";

export type ManagedSkillsRefreshTrigger = "startup" | "auth_change" | "on_demand";
export interface ManagedSkillsServiceOptions {
  getCacheDir(): string;
  fetch(): Promise<readonly FetchedManagedSkill[]>;
  report?(event: { extension: "managed_setup"; kind: "managed_skills"; errorClass: string }): void;
}
function errorClass(error: unknown): string { return error instanceof Error ? error.name || "Error" : typeof error; }

export class SandManagedSkillsService {
  private isDisposed = false;
  private refreshPromise: Promise<void> | null = null;
  private pendingTrigger: ManagedSkillsRefreshTrigger | null = null;
  constructor(readonly options: ManagedSkillsServiceOptions) {}
  start(): void { void this.refresh("startup"); }
  handleAuthChange(): void { void this.refresh("auth_change"); }
  async ensureSkill(id: string): Promise<boolean> { if (readManagedSkillsCache(this.options.getCacheDir())?.skills.some((skill) => skill.id === id)) return true; await this.refresh("on_demand"); return readManagedSkillsCache(this.options.getCacheDir())?.skills.some((skill) => skill.id === id) === true; }
  dispose(): void { this.isDisposed = true; }
  async refresh(trigger: ManagedSkillsRefreshTrigger): Promise<void> { if (this.isDisposed) return; if (this.refreshPromise != null) { this.pendingTrigger = trigger; return await this.refreshPromise; } this.refreshPromise = this.runRefreshes(trigger); try { await this.refreshPromise; } finally { this.refreshPromise = null; } }
  private async runRefreshes(trigger: ManagedSkillsRefreshTrigger): Promise<void> {
    let nextTrigger: ManagedSkillsRefreshTrigger | null = trigger;
    while (nextTrigger != null && !this.isDisposed) { nextTrigger = null; try { const fetched = await this.options.fetch(); if (this.isDisposed) return; const skills: ManagedSkill[] = []; for (const skill of fetched) { const normalized = fetchedManagedSkillToSandSkill(skill); if (normalized != null) skills.push(normalized); } writeManagedSkillsCache(this.options.getCacheDir(), skills); } catch (error) { this.options.report?.({ extension: "managed_setup", kind: "managed_skills", errorClass: errorClass(error) }); } finally { nextTrigger = this.pendingTrigger; this.pendingTrigger = null; } }
  }
}
