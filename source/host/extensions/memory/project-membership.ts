import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSafeFolderId } from "../../storage/folder-id.js";

export const MEMBERSHIP_FILENAME = "projects.json";
export function getAgentProjectsPath(agentDir: string): string { return join(agentDir, MEMBERSHIP_FILENAME); }

export function toSafeSlugSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((slug): slug is string => typeof slug === "string" && isSafeFolderId(slug)));
}

export class AgentProjectMembership {
  constructor(readonly agentDir: string) {}
  get path(): string { return getAgentProjectsPath(this.agentDir); }
  read(): Set<string> {
    try { const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { projects?: unknown }; return toSafeSlugSet(parsed.projects); }
    catch { return new Set(); }
  }
  write(slugs: ReadonlySet<string>): void {
    mkdirSync(this.agentDir, { recursive: true }); const body = `${JSON.stringify({ projects: [...slugs].sort() }, null, 2)}\n`; const tempPath = `${this.path}.tmp`;
    writeFileSync(tempPath, body, "utf8"); renameSync(tempPath, this.path);
  }
  join(slug: string): boolean { if (!isSafeFolderId(slug)) return false; const slugs = this.read(); if (slugs.has(slug)) return true; slugs.add(slug); this.write(slugs); return true; }
  leave(slug: string): boolean { if (!isSafeFolderId(slug)) return false; const slugs = this.read(); if (!slugs.has(slug)) return true; slugs.delete(slug); this.write(slugs); return true; }
  pruneMissing(projectExists: (slug: string) => boolean): void { const slugs = this.read(); let changed = false; for (const slug of slugs) if (!projectExists(slug)) { slugs.delete(slug); changed = true; } if (changed) this.write(slugs); }
}
