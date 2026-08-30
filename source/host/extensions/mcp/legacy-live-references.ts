export interface PluginSkillCatalogEntry { sourceUrl?: string | null }
export interface PluginCatalogEntry { pluginId: string; skills: readonly PluginSkillCatalogEntry[] }
export interface MaterializedPluginSkill { pluginId: string; filePath: string }

export function isLiveReferencePointerBody(body: string): boolean { return body.includes("is a live reference to the skill at"); }
export function normalizePluginSkillSourceUrl(raw: string): string {
  let parsed: URL; try { parsed = new URL(raw); } catch { return raw; }
  const segments = parsed.pathname.split("/").filter(Boolean); const [owner, repo, marker, ref, ...path] = segments;
  if (owner == null || repo == null || marker !== "blob" || ref == null || path.length === 0) return raw;
  return `${parsed.hostname.toLowerCase()}/${owner}/${repo}/${path.join("/")}`;
}
export function skillPathTail(path: string): string | null { const normalized = path.replaceAll("\\", "/"); const index = normalized.lastIndexOf("/skills/"); return index === -1 ? null : normalized.slice(index + 1); }
export function collectMaterializedSkillSourceUrls(catalog: readonly PluginCatalogEntry[], records: readonly MaterializedPluginSkill[]): string[] {
  const materialized = new Set(records.flatMap((record) => { const tail = skillPathTail(record.filePath); return tail == null ? [] : [`${record.pluginId}\0${tail}`]; }));
  return catalog.flatMap((plugin) => plugin.skills.flatMap((skill) => { if (skill.sourceUrl == null) return []; const tail = skillPathTail(skill.sourceUrl); return tail != null && materialized.has(`${plugin.pluginId}\0${tail}`) ? [skill.sourceUrl] : []; }));
}

export interface LiveReferenceLibrary { list(): readonly Pick<GlobalWorkflowRecord, "id" | "sourceRef" | "body">[]; remove(id: string): boolean }
export function removeWorkflowLiveReferences(sandRootDir: string, sourceUrls: readonly string[], library: LiveReferenceLibrary = new GlobalWorkflowLibrary(getGlobalWorkflowsDir(sandRootDir))): number {
  if (sourceUrls.length === 0) return 0;
  const refs = new Set(sourceUrls.map(normalizePluginSkillSourceUrl)); let removed = 0;
  for (const record of library.list()) if (record.sourceRef != null && refs.has(normalizePluginSkillSourceUrl(record.sourceRef)) && isLiveReferencePointerBody(record.body) && library.remove(record.id)) removed += 1;
  return removed;
}
export interface LegacyReferenceSweepDeps {
  sandRootDir: string;
  auth: { getAccessToken(args: { backendUrl: string }): Promise<string>; getMachineId(): Promise<string> };
  backendUrl: string;
  fetchMarketplace?(getAccessToken: () => Promise<string | null>, getMachineId: () => Promise<string>): Promise<{ plugins: readonly PluginCatalogEntry[] }>;
  log(message: string): void;
  removeReferences?: (sandRootDir: string, sourceUrls: readonly string[]) => number;
}
export async function sweepLegacyPluginSkillReferences(deps: LegacyReferenceSweepDeps): Promise<number> {
  const records = readPluginSkillsCache(getPluginSkillsDir(deps.sandRootDir))?.skills ?? [];
  if (records.length === 0) return 0;
  try {
    const fetchMarketplace = deps.fetchMarketplace ?? fetchMarketplaceMcpPlugins;
    const { plugins } = await fetchMarketplace(async () => { const token = await deps.auth.getAccessToken({ backendUrl: deps.backendUrl }); return token.length > 0 ? token : null; }, deps.auth.getMachineId);
    const removed = (deps.removeReferences ?? removeWorkflowLiveReferences)(deps.sandRootDir, collectMaterializedSkillSourceUrls(plugins, records));
    if (removed > 0) deps.log(`[sand:plugin-skills] retired ${removed} legacy live-reference record(s)`);
    return removed;
  } catch (error) { deps.log(`[sand:plugin-skills] legacy live-reference sweep failed: ${error instanceof Error ? error.message : String(error)}`); return 0; }
}
import { GlobalWorkflowLibrary, getGlobalWorkflowsDir, type GlobalWorkflowRecord } from "../../workflows/workflow-library.js";
import { getPluginSkillsDir, readPluginSkillsCache } from "./plugin-skills-cache.js";
import { fetchMarketplaceMcpPlugins } from "../../../shared/node/mcp/mcp-marketplace.js";
