import { readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getPluginInstallCachePath } from "../../../packages/cursor-plugins/cursor-marketplace.js";
import { DefaultPluginCacheManager } from "../../../packages/cursor-plugins/cursor-marketplace.js";
import { createBackendMarketplaceClient, normalizeEffectiveUserPluginsResponse } from "../../../packages/cursor-plugins/backend-marketplace-client.js";
import { classifyCloneError } from "../../../packages/cursor-plugins/marketplace-cache.js";
import { buildOriginTokenGitConfig } from "../../../packages/cursor-plugins/origin-git-auth.js";
import { loadFromMarketplaceSource } from "../../../packages/cursor-plugins/loader.js";
import { DashboardService } from "../../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import { GetEffectiveUserPluginsRequest, GetMeRequest } from "../../../packages/proto/generated/aiserver/v1/dashboard_pb.js";
import { createSandCursorBackendClient, getSandInferenceBackendUrl } from "../../../shared/node/cursor-backend/cursor-inference.js";
import { clampWorkflowDescription, clampWorkflowName, slugifyWorkflowName } from "../../../shared/workflow-model.js";
import { getPluginSkillsDir, getPluginsRootDir, readPluginSkillsCache, writePluginSkillsCache, type PluginAuthBlock, type PluginSkillRecord, type PluginSkillsCache } from "./plugin-skills-cache.js";

export interface PluginIdentifier { source: string; sourceInfo: { name: string; pluginDbId?: string | undefined; version?: string | undefined } }
export interface InstalledPlugin { identifier: PluginIdentifier; displayName?: string | null | undefined; loadError?: unknown; installPath: string; skills: readonly { name?: string | null | undefined; description?: string | null | undefined; path: string }[] }
export interface PublisherFacts { publisherUserId: number | null; marketplaceTeamId: number | null }
export function skillRecordsIdentity(records: readonly PluginSkillRecord[]): string { return records.map((record) => `${record.id}@${record.pluginVersion}`).sort().join("\n"); }
export function toPluginSkillInfo(record: PluginSkillRecord): { pluginId: string; pluginName: string; name: string; description: string } { return { pluginId: record.pluginId, pluginName: record.pluginName, name: record.name, description: record.description }; }
export function skillNameFromPath(relativePath: string): string { const segments = relativePath.split("/").filter(Boolean), fileIndex = segments.length - 1; return segments[fileIndex - 1] ?? segments[fileIndex] ?? ""; }
export function pluginVersionOf(identifier: PluginIdentifier): string { return typeof identifier.sourceInfo.version === "string" ? identifier.sourceInfo.version : ""; }
function getPluginDbId(identifier: PluginIdentifier): string | undefined { return identifier.source === "cursor-first-party" || identifier.source === "cursor-third-party" ? identifier.sourceInfo.pluginDbId : undefined; }
export function pluginContentsToSkillRecords(plugins: readonly InstalledPlugin[], publisherFacts: ReadonlyMap<string, PublisherFacts> = new Map()): PluginSkillRecord[] {
  const records: PluginSkillRecord[] = [], usedIds = new Set<string>();
  for (const plugin of plugins) { if (plugin.loadError != null || plugin.installPath.length === 0) continue; const pluginId = getPluginDbId(plugin.identifier); if (!pluginId) continue; const pluginName = plugin.displayName != null && plugin.displayName.length > 0 ? plugin.displayName : plugin.identifier.sourceInfo.name; for (const skill of plugin.skills) { const name = clampWorkflowName(skill.name != null && skill.name.length > 0 ? skill.name : skillNameFromPath(skill.path)); if (!name) continue; const slug = slugifyWorkflowName(name); let id = `plugin-${pluginId}-${slug}`; for (let suffix = 2; usedIds.has(id); suffix++) id = `plugin-${pluginId}-${slug}-${suffix}`; usedIds.add(id); records.push({ id, pluginId, pluginName, name, description: clampWorkflowDescription(skill.description ?? ""), filePath: resolve(plugin.installPath, skill.path), pluginVersion: pluginVersionOf(plugin.identifier), installPath: plugin.installPath, skillRelativePath: skill.path, publisherUserId: publisherFacts.get(pluginId)?.publisherUserId ?? null, marketplaceTeamId: publisherFacts.get(pluginId)?.marketplaceTeamId ?? null }); } }
  return records;
}
export function publisherFactsFromListing(response: { plugins: readonly { plugin?: { id: string | bigint | number; publisher?: { ownerUserId?: number | null } | null; marketplace?: { teamId?: number | null } | null } | null }[] }): Map<string, PublisherFacts> { const facts = new Map<string, PublisherFacts>(); for (const effective of response.plugins) { const plugin = effective.plugin; if (plugin == null) continue; const owner = plugin.publisher?.ownerUserId, team = plugin.marketplace?.teamId; facts.set(plugin.id.toString(), { publisherUserId: owner != null && owner > 0 ? owner : null, marketplaceTeamId: team != null && team > 0 ? team : null }); } return facts; }

export const EFFECTIVE_PLUGINS_RPC_TIMEOUT_MS = 15_000;
export const CURRENT_USER_RPC_TIMEOUT_MS = 10_000;
export const PLUGIN_SKILLS_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export interface PluginLoadFailure { pluginDbId?: string | undefined; pluginId?: string | undefined; pluginName: string; marketplaceName?: string | undefined; errorMessage: string; errorKind?: string | undefined }
export function pluginAuthBlocksFromFailures(failures: readonly PluginLoadFailure[]): PluginAuthBlock[] { const blocks: PluginAuthBlock[] = [], seen = new Set<string>(); for (const failure of failures) { if (classifyCloneError(failure.errorMessage) !== "user_git_access") continue; const pluginId=failure.pluginDbId??failure.pluginId??"",key=pluginId||`name:${failure.pluginName}`;if(seen.has(key))continue;seen.add(key);blocks.push({pluginId,pluginName:failure.pluginName,...(failure.marketplaceName==null?{}:{marketplaceName:failure.marketplaceName})}) } return blocks; }
export interface ListedCacheKey { marketplaceSlug:string;pluginId:string }
export function pruneUninstalledPluginDirs(cacheRoot:string,listed:readonly ListedCacheKey[],indexedFilePaths:readonly string[]):void{const keep=new Set(listed.map((key)=>getPluginInstallCachePath(cacheRoot,key)));let slugs;try{slugs=readdirSync(cacheRoot,{withFileTypes:true})}catch{return}for(const slug of slugs){if(!slug.isDirectory())continue;const slugDir=join(cacheRoot,slug.name);let plugins;try{plugins=readdirSync(slugDir,{withFileTypes:true})}catch{continue}for(const plugin of plugins){if(!plugin.isDirectory())continue;const dir=join(slugDir,plugin.name);if(keep.has(dir)||indexedFilePaths.some((path)=>path.startsWith(`${dir}${sep}`)))continue;try{rmSync(dir,{recursive:true,force:true})}catch{}}}}
export interface LoadedPlugins { plugins: readonly InstalledPlugin[]; authBlocked: PluginAuthBlock[]; listedPluginIds: string[]; listedCacheKeys: ListedCacheKey[]; publisherFacts: ReadonlyMap<string,PublisherFacts>; currentUserId: number|null }
export interface MarketplaceListEntry { pluginId: string; pluginDbId?: string | null; marketplace?: { name?: string | null } | null }
export interface SharedInstalledPluginsLoaderDeps {
  sandRootDir: string;
  auth: {
    getAccessToken(args: { backendUrl: string }): Promise<string>;
    getMachineId(): Promise<string>;
    peekAccessToken(): string | null;
  };
  isSparsePluginClonesEnabled(): boolean;
  readonly dashboardForTesting?: {
    getEffectiveUserPlugins(request: GetEffectiveUserPluginsRequest, options: { timeoutMs: number }): Promise<{ plugins: readonly { plugin?: { id: string | number | bigint; publisher?: { ownerUserId?: number | null } | null; marketplace?: { teamId?: number | null } | null } | null }[] }>;
    getMe(request: GetMeRequest, options: { timeoutMs: number }): Promise<{ userId: number }>;
  };
  log(message: string): void;
}
export function createSharedInstalledPluginsLoader(deps: SharedInstalledPluginsLoaderDeps): () => Promise<LoadedPlugins> {
  const pluginsRoot = getPluginsRootDir(deps.sandRootDir);
  const dashboard = deps.dashboardForTesting ?? createSandCursorBackendClient(DashboardService, {
    getAccessToken: async () => await deps.auth.getAccessToken({ backendUrl: getSandInferenceBackendUrl() }),
    getMachineId: deps.auth.getMachineId
  }) as unknown as {
    getEffectiveUserPlugins(request: GetEffectiveUserPluginsRequest, options: { timeoutMs: number }): Promise<{ plugins: readonly { plugin?: { id: string | number | bigint; publisher?: { ownerUserId?: number | null } | null; marketplace?: { teamId?: number | null } | null } | null }[] }>;
    getMe(request: GetMeRequest, options: { timeoutMs: number }): Promise<{ userId: number }>;
  };
  let currentUserId: number | null = null;
  const resolveCurrentUserId = async (): Promise<number | null> => {
    if (currentUserId != null) return currentUserId;
    try { const response = await dashboard.getMe(new GetMeRequest(), { timeoutMs: CURRENT_USER_RPC_TIMEOUT_MS }); currentUserId = response.userId > 0 ? response.userId : null; }
    catch (error) { deps.log(`[sand:plugin-skills] could not resolve the signed-in user: ${error instanceof Error ? error.message : String(error)}`); }
    return currentUserId;
  };
  return async () => {
    const listedCacheKeys: ListedCacheKey[] = [], listedPluginIds = new Set<string>(); let publisherFacts = new Map<string, PublisherFacts>(), currentUserIdForPass: number | null = null;
    const client = createBackendMarketplaceClient(async () => { const response = await dashboard.getEffectiveUserPlugins(new GetEffectiveUserPluginsRequest(), { timeoutMs: EFFECTIVE_PLUGINS_RPC_TIMEOUT_MS }); publisherFacts = publisherFactsFromListing(response); currentUserIdForPass = await resolveCurrentUserId(); return normalizeEffectiveUserPluginsResponse(response); }, { marketplaceCacheRoot: join(pluginsRoot, "marketplaces"), listOptions: { enableInlinePlugins: true }, sparsePluginClones: deps.isSparsePluginClonesEnabled(), extraGitConfig: () => buildOriginTokenGitConfig(deps.auth.peekAccessToken() ?? undefined) });
    const result = await loadFromMarketplaceSource({ client, userId: "sand", cacheManager: new DefaultPluginCacheManager(undefined, { cacheRoot: join(pluginsRoot, "cache") }), pruneOldVersions: true, onPluginsListed: async (entries) => { for (const entry of entries) { if (entry.pluginDbId != null && entry.pluginDbId.length > 0) listedPluginIds.add(entry.pluginDbId); const slug = entry.marketplace?.name; if (slug != null && slug.length > 0) listedCacheKeys.push({ marketplaceSlug: slug, pluginId: entry.pluginId }); } } });
    for (const failure of result.failures) deps.log(`[sand:plugin-skills] plugin ${failure.pluginName} failed to load: ${failure.errorMessage}`);
    for (const plugin of result.plugins) { const pluginId = getPluginDbId(plugin.identifier); if (pluginId != null && pluginId.length > 0) listedPluginIds.add(pluginId); }
    return { plugins: result.plugins, authBlocked: pluginAuthBlocksFromFailures(result.failures), listedPluginIds: [...listedPluginIds], listedCacheKeys, publisherFacts, currentUserId: currentUserIdForPass };
  };
}
export interface PluginSkillsServiceOptions { sandRootDir:string;load():Promise<LoadedPlugins>;log?(message:string):void;reportSync?(event:Record<string,unknown>):void;now?:()=>number;prune?:(cacheRoot:string,listed:readonly ListedCacheKey[],paths:readonly string[])=>void }
export class SandPluginSkillsService {
  private disposed=false;private inFlight:Promise<PluginSkillRecord[]>|null=null;private pending:{trigger:string;promise:Promise<PluginSkillRecord[]>}|null=null;
  constructor(readonly options:PluginSkillsServiceOptions){}
  start():void{this.syncInBackground("startup")}handleAuthChange():void{this.syncInBackground("auth_change")}dispose():void{this.disposed=true}
  current():PluginSkillRecord[]{return this.currentIndex()?.skills??[]}currentIndex():PluginSkillsCache|null{return readPluginSkillsCache(getPluginSkillsDir(this.options.sandRootDir))}currentAuthBlocked():PluginAuthBlock[]{return this.currentIndex()?.authBlocked??[]}
  private syncInBackground(trigger:string):void{void this.sync(trigger).catch(()=>{})}
  async sync(trigger:string):Promise<PluginSkillRecord[]>{if(this.disposed)return this.current();if(this.inFlight==null)return this.startPass(trigger);if(this.pending==null){const running=this.inFlight,promise=(async()=>{try{await running}catch{}const next=this.pending?.trigger??trigger;this.pending=null;return this.disposed?this.current():this.startPass(next)})();this.pending={trigger,promise}}else this.pending.trigger=trigger;return this.pending.promise}
  private startPass(trigger:string):Promise<PluginSkillRecord[]>{const pass=this.runPass(trigger);this.inFlight=pass;const clear=()=>{if(this.inFlight===pass)this.inFlight=null};pass.then(clear,clear);return pass}
  private async runPass(trigger:string):Promise<PluginSkillRecord[]>{const started=(this.options.now??Date.now)();try{const loaded=await this.options.load();if(this.disposed)return this.current();const previous=this.currentIndex();let records=pluginContentsToSkillRecords(loaded.plugins,loaded.publisherFacts),listed=new Set(loaded.listedPluginIds),loadedIds=new Set(loaded.plugins.flatMap((plugin)=>plugin.loadError!=null||!plugin.installPath?[]:(id=>id==null?[]:[id])(getPluginDbId(plugin.identifier))));records=[...records,...(previous?.skills??[]).filter((record)=>listed.has(record.pluginId)&&!loadedIds.has(record.pluginId))];writePluginSkillsCache(getPluginSkillsDir(this.options.sandRootDir),{currentUserId:loaded.currentUserId??previous?.currentUserId??null,skills:records,authBlocked:loaded.authBlocked});(this.options.prune??pruneUninstalledPluginDirs)(join(getPluginsRootDir(this.options.sandRootDir),"cache"),loaded.listedCacheKeys,records.map((record)=>record.filePath));this.options.reportSync?.({trigger,outcome:"ok",changed:previous==null?records.length>0:skillRecordsIdentity(previous.skills)!==skillRecordsIdentity(records),skillCount:records.length,durationMs:(this.options.now??Date.now)()-started});return records}catch(error){this.options.log?.(`[sand:plugin-skills] sync (${trigger}) failed: ${error instanceof Error?error.message:String(error)}`);this.options.reportSync?.({trigger,outcome:"failed",errorClass:error instanceof Error?error.name:typeof error,durationMs:(this.options.now??Date.now)()-started});throw error}}
}
