import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withTimeout } from "../utils/promise-extras.js";
import { sanitizeFilename } from "../utils/path-matchers.js";
import { resolveGitRemoteRef } from "./git-remote-ref-resolve.js";
import {
  isSparseCheckoutRepo,
  materializeSparseDirs,
  resolveSparseClonePlan,
  serverIgnoredFilter,
  setSparseCheckoutDirs,
  type MaterializeSpec,
} from "./git-sparse-clone.js";
import {
  execGitNonInteractive,
  resolveExtraGitConfig,
  type ExtraGitConfigProvider,
} from "./git-subprocess-env.js";
import { canonicalRepoHost, parseAndValidateScmUrl, parseGitUrl, toScmSshUrl } from "./git-url-parsing.js";
import {
  MARKETPLACE_MANIFEST_PATHS,
  isPathSafe,
  parseAndClassifyManifestEntries,
  parseMarketplaceManifest,
  resolvePluginSourcePath,
  type MarketplaceManifest,
} from "./manifest-parser.js";
import { noopPluginMetricsLogger, type PluginMetricsLogger } from "./types.js";
import { validateAndResolveSubpath } from "./validate-subpath.js";

const WINDOWS_RESERVED_PATH_NAMES = new Set(["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);
export const LS_REMOTE_TIMEOUT_MS = 30_000;
export const REMOTE_GIT_TIMEOUT_MS = 30 * 60_000;
export const LOCAL_GIT_TIMEOUT_MS = 10 * 60_000;
const RECURSIVE_RM_OPTIONS = { recursive: true, force: true, maxRetries: 3 } as const;
const USER_GIT_ACCESS_PATTERNS = ["terminal prompts disabled", "could not read username", "host key verification failed", "could not read from remote repository", "permission denied", "repository not found", "user cancelled dialog", "spawn git enoent", "authentication failed", "unable to get password from user"] as const;
const LOCAL_CACHE_PATTERNS = ["enotempty: directory not empty, rename", "/_staging/"] as const;
const STALE_PINNED_REF_PATTERNS = ["upload-pack: not our ref", "server does not allow request for unadvertised object"] as const;
const globalInFlight = new Map<string, Promise<unknown>>();

function sanitize(value: string): string {
  const sanitized = sanitizeFilename(value).replace(/[. ]+$/g, "");
  if (sanitized === "" || sanitized === "." || sanitized === "..") return "_";
  return WINDOWS_RESERVED_PATH_NAMES.has(sanitized.toLowerCase()) ? `_${sanitized}` : sanitized;
}

export type CloneErrorCategory = "user_git_access" | "local_cache_race" | "stale_pinned_ref" | "infrastructure";
export function classifyCloneError(error: unknown): CloneErrorCategory {
  const message = String(error).toLowerCase().replaceAll("\\", "/");
  if (USER_GIT_ACCESS_PATTERNS.some(pattern => message.includes(pattern))) return "user_git_access";
  if (LOCAL_CACHE_PATTERNS.every(pattern => message.includes(pattern))) return "local_cache_race";
  if (STALE_PINNED_REF_PATTERNS.some(pattern => message.includes(pattern))) return "stale_pinned_ref";
  return "infrastructure";
}

export function isKilledSubprocessError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { killed?: unknown; cause?: unknown };
  return candidate.killed === true || isKilledSubprocessError(candidate.cause);
}

function cloneErrorTag(error: unknown): CloneErrorCategory | "killed_by_budget" { return isKilledSubprocessError(error) ? "killed_by_budget" : classifyCloneError(error); }

export function getCanonicalMarketplacePathSegments(gitUrl: string): { host: string; pathSegments: string[] } {
  const scm = parseAndValidateScmUrl(gitUrl);
  if (!("error" in scm) && scm.provider === "gitlab") {
    let pathname: string;
    try { pathname = new URL(scm.url).pathname.replace(/^\//, ""); }
    catch { throw new Error(`Invalid git URL: ${gitUrl}`); }
    const pathSegments = pathname.split("/").filter(Boolean).map(segment => segment.toLowerCase());
    if (pathSegments.length < 2) throw new Error(`Invalid git URL: ${gitUrl}`);
    return { host: scm.host.toLowerCase(), pathSegments };
  }
  const parsed = parseGitUrl(gitUrl);
  if (parsed === null) throw new Error(`Invalid git URL: ${gitUrl}`);
  return { host: canonicalRepoHost(parsed.host.replace(/^www\./i, "")).toLowerCase(), pathSegments: [parsed.owner.toLowerCase(), parsed.repo.toLowerCase()] };
}

function manifestCacheKey(clonePath: string, options: { repoName?: string; fallbackId?: string }): string {
  return JSON.stringify({ clonePath, repoName: options.repoName ?? null, fallbackId: options.fallbackId ?? null });
}

async function readMarketplaceManifestFromDir(dir: string, options: { repoName?: string; fallbackId?: string } = {}): Promise<MarketplaceManifest | null> {
  for (const manifestRelPath of MARKETPLACE_MANIFEST_PATHS) {
    let content: string;
    try { content = await readFile(join(dir, manifestRelPath), "utf-8"); }
    catch { continue; }
    const result = parseMarketplaceManifest(content, options);
    if (result.success) return result.data;
  }
  return null;
}

export interface DiscoveredMarketplacePlugin {
  name: string;
  displayName?: string | undefined;
  description?: string | undefined;
  version?: string | undefined;
  sourceType: "local" | "github" | "url" | "git-subdir";
  gitPath?: string;
  gitUrl?: string;
  gitRef?: string | undefined;
  sha?: string | undefined;
  subdirPath?: string;
}

function discoverPluginsFromManifest(manifest: MarketplaceManifest): DiscoveredMarketplacePlugin[] {
  const plugins: DiscoveredMarketplacePlugin[] = [];
  for (const classified of parseAndClassifyManifestEntries(manifest.plugins, manifest.metadata?.pluginRoot)) {
    const { name, displayName, description, version } = classified.entry;
    const common = { name, displayName, description, version };
    switch (classified.kind) {
      case "local": if (isPathSafe(classified.localPath)) plugins.push({ ...common, sourceType: "local", gitPath: classified.localPath }); break;
      case "external-github": plugins.push({ ...common, sourceType: "github", gitUrl: classified.externalUrl, gitRef: classified.externalRef, sha: classified.externalSha }); break;
      case "external-url": plugins.push({ ...common, sourceType: "url", gitUrl: classified.externalUrl, gitRef: classified.externalRef, sha: classified.externalSha }); break;
      case "external-git-subdir": plugins.push({ ...common, sourceType: "git-subdir", gitUrl: classified.externalUrl, gitRef: classified.externalRef, sha: classified.externalSha, subdirPath: classified.subdirPath }); break;
      case "unresolvable": break;
    }
  }
  return plugins;
}

export interface MarketplaceCacheOptions {
  readonly extraGitConfig?: ExtraGitConfigProvider;
  readonly sparsePluginClones?: boolean;
}

interface CloneOutcome { strategy: "sparse" | "full"; filterIgnoredByServer: boolean }

export class MarketplaceCacheManager {
  static STALE_STAGING_THRESHOLD_MS = 5 * 60 * 1_000;
  static STAGING_HEARTBEAT_INTERVAL_MS = 60 * 1_000;
  readonly manifestCache = new Map<string, MarketplaceManifest | null>();

  constructor(readonly cacheRoot: string, readonly options?: MarketplaceCacheOptions) {}

  get sparsePluginClones(): boolean { return this.options?.sparsePluginClones ?? false; }
  private remoteTimeoutMs(): number | undefined { return this.sparsePluginClones ? REMOTE_GIT_TIMEOUT_MS : undefined; }
  private localTimeoutMs(): number | undefined { return this.sparsePluginClones ? LOCAL_GIT_TIMEOUT_MS : undefined; }
  private lsRemoteTimeoutMs(): number | undefined { return this.sparsePluginClones ? LS_REMOTE_TIMEOUT_MS : undefined; }

  private async cloneResolvedRef(cloneDir: string, gitUrl: string, resolvedRef: string, options?: { sshBatchMode?: boolean | undefined; materialize?: MaterializeSpec | undefined }): Promise<CloneOutcome> {
    const execOpts = {
      cwd: cloneDir,
      sshBatchMode: options?.sshBatchMode,
      extraGitConfig: { ...resolveExtraGitConfig(this.options?.extraGitConfig), "safe.directory": cloneDir },
    };
    const { sparse, sparseDirs } = await resolveSparseClonePlan(options?.materialize ?? "all", this.sparsePluginClones);
    await execGitNonInteractive(["init"], { ...execOpts, timeoutMs: this.localTimeoutMs() });
    if (sparse) await setSparseCheckoutDirs(cloneDir, sparseDirs, { sshBatchMode: options?.sshBatchMode, extraGitConfig: resolveExtraGitConfig(this.options?.extraGitConfig), timeoutMs: this.localTimeoutMs() });
    const { stderr: fetchStderr } = await execGitNonInteractive(["fetch", "--depth", "1", ...(sparse ? ["--filter=blob:none"] : []), gitUrl, resolvedRef], { ...execOpts, timeoutMs: this.remoteTimeoutMs() });
    await execGitNonInteractive(["checkout", "FETCH_HEAD"], { ...execOpts, timeoutMs: this.remoteTimeoutMs() });
    return { strategy: sparse ? "sparse" : "full", filterIgnoredByServer: sparse && serverIgnoredFilter(fetchStderr ?? "") };
  }

  private async createStagingDir(): Promise<string> { const stagingDir = join(this.cacheRoot, "_staging", randomUUID()); await mkdir(stagingDir, { recursive: true }); return stagingDir; }
  private async moveToCanonicalDir(stagingDir: string, cloneDir: string): Promise<string> { await mkdir(dirname(cloneDir), { recursive: true }); await rm(cloneDir, RECURSIVE_RM_OPTIONS); await rename(stagingDir, cloneDir); return cloneDir; }
  private async cleanStaleStagingDirs(): Promise<void> {
    const stagingRoot = join(this.cacheRoot, "_staging");
    try {
      const entries = await readdir(stagingRoot, { withFileTypes: true }), now = Date.now();
      await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
        try { const entryPath = join(stagingRoot, entry.name), stats = await stat(entryPath); if (now - stats.mtimeMs > MarketplaceCacheManager.STALE_STAGING_THRESHOLD_MS) await rm(entryPath, RECURSIVE_RM_OPTIONS); } catch {}
      }));
    } catch {}
  }

  getLegacyCloneDir(marketplaceId: string, ref: string): string { return join(this.cacheRoot, sanitize(marketplaceId), sanitize(ref)); }
  getCanonicalCloneDir(gitUrl: string, ref: string): string { const { host, pathSegments } = getCanonicalMarketplacePathSegments(gitUrl); return join(this.cacheRoot, sanitize(host), ...pathSegments.map(sanitize), sanitize(ref)); }
  getCanonicalRepoRootDir(gitUrl: string): string { const { host, pathSegments } = getCanonicalMarketplacePathSegments(gitUrl); return join(this.cacheRoot, sanitize(host), ...pathSegments.map(sanitize)); }

  private async pruneSiblingCloneDirs(gitUrl: string, keepRef: string, legacyCloneDir?: string): Promise<void> {
    const repoRootDir = this.getCanonicalRepoRootDir(gitUrl), keepDirName = sanitize(keepRef);
    try { const entries = await readdir(repoRootDir, { withFileTypes: true }); await Promise.all(entries.filter(entry => entry.isDirectory() && entry.name !== keepDirName).map(entry => rm(join(repoRootDir, entry.name), RECURSIVE_RM_OPTIONS))); } catch {}
    if (legacyCloneDir !== undefined) try { await rm(legacyCloneDir, RECURSIVE_RM_OPTIONS); } catch {}
  }

  async ensureCloned(marketplaceId: string, gitUrl: string, ref: string, pluginLogger: PluginMetricsLogger = noopPluginMetricsLogger, options?: { materialize?: MaterializeSpec | undefined }): Promise<string> {
    const inner = this.serializedOnRepo(this.getCanonicalRepoRootDir(gitUrl), () => this.ensureClonedImpl(marketplaceId, gitUrl, ref, pluginLogger, options?.materialize ?? "all"));
    return this.sparsePluginClones ? inner : withTimeout(inner, 30_000, `ensureCloned timed out after 30000ms for ${gitUrl} @ ${ref}`);
  }

  async ensureMaterialized(clonePath: string, spec: MaterializeSpec, pluginLogger: PluginMetricsLogger = noopPluginMetricsLogger): Promise<void> {
    const inner = this.serializedOnRepo(dirname(clonePath), async () => {
      const start = performance.now();
      try {
        await materializeSparseDirs(clonePath, spec, { extraGitConfig: resolveExtraGitConfig(this.options?.extraGitConfig), timeoutMs: this.remoteTimeoutMs() });
        pluginLogger.increment("marketplace_cache_manager.ensure_materialized.success", 1);
        pluginLogger.distribution("marketplace_cache_manager.ensure_materialized.duration", performance.now() - start);
      } catch (error) {
        pluginLogger.log("error", "Failed to materialize plugin directories in sparse marketplace clone", { clonePath, spec: spec === "all" ? "all" : spec.join(","), error: String(error), errorCategory: cloneErrorTag(error) });
        pluginLogger.increment("marketplace_cache_manager.ensure_materialized.error", 1, { error_category: cloneErrorTag(error) });
        pluginLogger.distribution("marketplace_cache_manager.ensure_materialized.duration", performance.now() - start, { outcome: "error" });
        throw error;
      }
    });
    return this.sparsePluginClones ? inner : withTimeout(inner, 30_000, `ensureMaterialized timed out after 30000ms for ${clonePath}`);
  }

  private async serializedOnRepo<Value>(repoRootDir: string, work: () => Promise<Value>): Promise<Value> {
    const serializationKey = `${this.cacheRoot}:${repoRootDir}`, predecessor = globalInFlight.get(serializationKey);
    const myWork = (predecessor ?? Promise.resolve()).catch(() => {}).then(work);
    globalInFlight.set(serializationKey, myWork);
    try { return await myWork; }
    finally { if (globalInFlight.get(serializationKey) === myWork) globalInFlight.delete(serializationKey); }
  }

  private async ensureClonedImpl(marketplaceId: string, gitUrl: string, ref: string, pluginLogger: PluginMetricsLogger, materialize: MaterializeSpec): Promise<string> {
    pluginLogger.log("info", `MarketplaceCacheManager: Ensuring cloned ${marketplaceId} at ${gitUrl}@${ref}`, { marketplaceId, gitUrl, ref });
    const originalRef = ref.trim();
    let sshCloneUrl = !gitUrl.startsWith("git@") && !gitUrl.startsWith("ssh://") ? toScmSshUrl(gitUrl) : null;
    let resolvedRef: string;
    if (sshCloneUrl !== null) {
      try { resolvedRef = (await resolveGitRemoteRef(sshCloneUrl, originalRef, { sshBatchMode: true, extraGitConfig: resolveExtraGitConfig(this.options?.extraGitConfig), timeoutMs: this.lsRemoteTimeoutMs() })).fullSha; }
      catch (error) {
        if (this.sparsePluginClones && isKilledSubprocessError(error)) throw error;
        pluginLogger.log("error", "Failed to resolve remote ref using SSH URL, falling back to HTTPS", { gitUrl, ref, error: String(error), errorCategory: classifyCloneError(error) });
        sshCloneUrl = null;
        resolvedRef = (await resolveGitRemoteRef(gitUrl, originalRef, { extraGitConfig: resolveExtraGitConfig(this.options?.extraGitConfig), timeoutMs: this.lsRemoteTimeoutMs() })).fullSha;
      }
    } else resolvedRef = (await resolveGitRemoteRef(gitUrl, originalRef, { extraGitConfig: resolveExtraGitConfig(this.options?.extraGitConfig), timeoutMs: this.lsRemoteTimeoutMs() })).fullSha;
    const cloneDir = this.getCanonicalCloneDir(gitUrl, resolvedRef), legacyCloneDir = this.getLegacyCloneDir(marketplaceId, originalRef);
    pluginLogger.log("info", `MarketplaceCacheManager: Resolved clone directory for ${marketplaceId} at ${gitUrl}@${ref} to ${cloneDir}`, { marketplaceId, resolvedRef, originalRef });
    const start = performance.now();
    const emitMetric = (suffix: string, tags?: Record<string, string>): void => { pluginLogger.increment(`marketplace_cache_manager.ensure_cloned.${suffix}`, 1, tags); pluginLogger.distribution(`marketplace_cache_manager.ensure_cloned.${suffix}.duration`, performance.now() - start, tags); };
    if (await this.isCloneComplete(cloneDir)) {
      await this.pruneSiblingCloneDirs(gitUrl, resolvedRef, legacyCloneDir);
      const cachedCloneIsSparse = await isSparseCheckoutRepo(cloneDir);
      if (cachedCloneIsSparse) await materializeSparseDirs(cloneDir, materialize, { extraGitConfig: resolveExtraGitConfig(this.options?.extraGitConfig), timeoutMs: this.remoteTimeoutMs() });
      emitMetric("cache_hit", { strategy: cachedCloneIsSparse ? "sparse" : "full" });
      return cloneDir;
    }
    pluginLogger.increment("marketplace_cache_manager.ensure_cloned.cache_miss", 1);
    return this.cloneViaStaging(cloneDir, gitUrl, sshCloneUrl, resolvedRef, legacyCloneDir, ref, pluginLogger, emitMetric, materialize);
  }

  private async cloneViaStaging(cloneDir: string, gitUrl: string, sshCloneUrl: string | null, resolvedRef: string, legacyCloneDir: string, ref: string, pluginLogger: PluginMetricsLogger, emitMetric: (suffix: string, tags?: Record<string, string>) => void, materialize: MaterializeSpec): Promise<string> {
    await this.cleanStaleStagingDirs();
    const stagingDir = await this.createStagingDir();
    pluginLogger.log("info", `MarketplaceCacheManager: Cloning ${gitUrl}@${ref} into staging directory: ${stagingDir}`, { gitUrl, ref, cloneDir });
    const heartbeat = this.sparsePluginClones ? setInterval(() => { const now = new Date(); void utimes(stagingDir, now, now).catch(() => {}); }, MarketplaceCacheManager.STAGING_HEARTBEAT_INTERVAL_MS) : undefined;
    heartbeat?.unref?.();
    try {
      let outcome: CloneOutcome;
      if (sshCloneUrl !== null) {
        try { outcome = await this.cloneResolvedRef(stagingDir, sshCloneUrl, resolvedRef, { sshBatchMode: true, materialize }); }
        catch (error) {
          if (this.sparsePluginClones && isKilledSubprocessError(error)) throw error;
          pluginLogger.log("error", "Falling back to HTTPS clone due to SSH clone failure", { gitUrl, ref, error: String(error), errorCategory: cloneErrorTag(error) });
          await rm(stagingDir, RECURSIVE_RM_OPTIONS); await mkdir(stagingDir, { recursive: true });
          outcome = await this.cloneResolvedRef(stagingDir, gitUrl, resolvedRef, { materialize });
        }
      } else outcome = await this.cloneResolvedRef(stagingDir, gitUrl, resolvedRef, { materialize });
      if (outcome.filterIgnoredByServer) { pluginLogger.log("warn", "Server ignored --filter=blob:none; sparse clone downloaded a full pack", { gitUrl, ref }); pluginLogger.increment("marketplace_cache_manager.ensure_cloned.filter_ignored_by_server", 1); }
      const resultDir = await this.moveToCanonicalDir(stagingDir, cloneDir);
      await this.pruneSiblingCloneDirs(gitUrl, resolvedRef, legacyCloneDir);
      emitMetric("cache_write_success", { strategy: outcome.strategy });
      return resultDir;
    } catch (error) {
      const errorCategory = cloneErrorTag(error); emitMetric("error", { error_category: errorCategory });
      pluginLogger.log("error", "Failed to clone marketplace repository via staging clone", { gitUrl, ref, error: String(error), errorCategory });
      pluginLogger.captureException(error, { error_type: "clone_marketplace_repository", error_category: errorCategory });
      throw error;
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      try { await rm(stagingDir, RECURSIVE_RM_OPTIONS); } catch {}
    }
  }

  async isCloneComplete(cloneDir: string): Promise<boolean> {
    try {
      const stats = await stat(cloneDir); if (!stats.isDirectory()) return false;
      const entries = await readdir(cloneDir); if (!entries.includes(".git")) return false; if (entries.length > 1) return true;
      try { return (await stat(join(cloneDir, ".git", "info", "sparse-checkout"))).isFile(); } catch { return false; }
    } catch { return false; }
  }

  getPluginDir(clonePath: string, gitPath: string): string { return validateAndResolveSubpath(clonePath, gitPath); }
  async copyPluginToDir(sourcePath: string, targetDir: string): Promise<void> { await mkdir(targetDir, { recursive: true }); await cp(sourcePath, targetDir, { recursive: true, verbatimSymlinks: true }); }

  async readManifest(clonePath: string, options: { repoName?: string; fallbackId?: string } = {}): Promise<MarketplaceManifest | null> {
    const cacheKey = manifestCacheKey(clonePath, options);
    if (this.manifestCache.has(cacheKey)) return this.manifestCache.get(cacheKey) ?? null;
    const manifest = await readMarketplaceManifestFromDir(clonePath, options); this.manifestCache.set(cacheKey, manifest); return manifest;
  }

  async resolvePluginPath(clonePath: string, pluginName: string): Promise<string | null> {
    const manifest = await this.readManifest(clonePath); if (!manifest) return null;
    const entry = manifest.plugins.find(plugin => plugin.name === pluginName.toLowerCase()); if (!entry) return null;
    const resolved = resolvePluginSourcePath(entry.source, manifest.metadata?.pluginRoot);
    return resolved && isPathSafe(resolved) ? resolved : null;
  }

  async discoverPlugins(clonePath: string): Promise<DiscoveredMarketplacePlugin[]> {
    const manifest = await this.readManifest(clonePath); return manifest ? discoverPluginsFromManifest(manifest) : [];
  }
}
