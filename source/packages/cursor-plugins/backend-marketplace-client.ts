import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debuglog } from "node:util";
import { extract } from "tar";
import { getReleasePluginSource } from "./cloud-manifest.js";
import { resolveGitRemoteRef } from "./git-remote-ref-resolve.js";
import { materializeSparseDirs, materializeSpecForGitPaths, resolveSparseClonePlan, serverIgnoredFilter, setSparseCheckoutDirs, type MaterializeSpec } from "./git-sparse-clone.js";
import { execGitNonInteractive, resolveExtraGitConfig, type ExtraGitConfig, type ExtraGitConfigProvider } from "./git-subprocess-env.js";
import { toScmSshUrl } from "./git-url-parsing.js";
import { synthesizeInlinePluginDir } from "./inline-plugin-synthesizer.js";
import { containsPluginRootDir, isPathSafe, MARKETPLACE_MANIFEST_PATHS, parseMarketplaceManifest, resolvePluginSourcePath } from "./manifest-parser.js";
import { getCanonicalMarketplacePathSegments, isKilledSubprocessError, LOCAL_GIT_TIMEOUT_MS, LS_REMOTE_TIMEOUT_MS, MarketplaceCacheManager, REMOTE_GIT_TIMEOUT_MS, type MarketplaceCacheOptions } from "./marketplace-cache.js";
import { noopPluginMetricsLogger, type PluginMetricsLogger } from "./types.js";
import { validateAndResolveSubpath } from "./validate-subpath.js";

const log = debuglog("cursor-plugins");
const BACKEND_GIT_PREFIX = "backend-git://";
const BACKEND_RELEASE_PREFIX = "backend-release://";
const SHA_REF_REGEX = /^[0-9a-f]{7,40}$/i;
const MAX_UNCOMPRESSED_EXTRACT_BYTES = 500 * 1024 * 1024;
const MAX_EXTRACT_FILE_COUNT = 50_000;
const MAX_EXTRACT_COMPRESSION_RATIO = 100;
const MAX_RELEASE_ASSET_BYTES = 100 * 1024 * 1024;

export interface EffectiveMarketplace {
  id?: string | number | bigint;
  name?: string;
  gitUrl?: string;
  distributionGitUrl?: string;
  gitRef?: string;
  [key: string]: unknown;
}
export interface EffectivePluginDefinition {
  id?: string | number | bigint;
  name?: string;
  updatedAt?: string | number | bigint;
  gitUrl?: string;
  gitRef?: string;
  gitPath?: string;
  releaseRepo?: string;
  releaseAsset?: string;
  releaseTag?: string;
  marketplace?: EffectiveMarketplace | null;
  marketplaceId?: string | number | bigint;
}
export interface EffectivePlugin {
  isEnabled?: boolean;
  isTeamRequired?: boolean;
  pinnedGitRef?: string;
  inlineContentJson?: string;
  configuredVariables?: unknown;
  plugin?: EffectivePluginDefinition | null;
}
export interface EffectivePluginsResponse { plugins?: readonly EffectivePlugin[]; marketplaces?: readonly EffectiveMarketplace[]; [key: string]: unknown }

export function normalizeEffectiveUserPluginsResponse<Response extends { plugins?: unknown }>(response: Response): Response {
  const plugins = response.plugins;
  if (!Array.isArray(plugins) || plugins.length === 0) return response;
  const normalized = plugins.map(effectivePlugin => {
    const configuredVariables = (effectivePlugin as { configuredVariables?: unknown }).configuredVariables;
    if (configuredVariables === undefined || configuredVariables === null) return effectivePlugin;
    if (typeof configuredVariables === "object") {
      const maybeProto = configuredVariables as { toJson?: unknown };
      if (typeof maybeProto.toJson === "function") {
        let json: unknown;
        try { json = (maybeProto.toJson as () => unknown)(); } catch { return effectivePlugin; }
        return { ...effectivePlugin, configuredVariables: json !== null && typeof json === "object" && !Array.isArray(json) ? json : undefined };
      }
    }
    return effectivePlugin;
  });
  return { ...response, plugins: normalized };
}

function catalogInstallNameForPlugin(params: { name?: string | undefined; pluginId: string }): string { const trimmed = params.name?.trim(); return trimmed !== undefined && trimmed.length > 0 ? trimmed : params.pluginId; }
function resolveEffectivePluginMarketplace(plugin: EffectivePluginDefinition | null | undefined, marketplaces: readonly EffectiveMarketplace[] | undefined): EffectiveMarketplace | null | undefined {
  if (plugin?.marketplace !== undefined) return plugin.marketplace;
  if (plugin?.marketplaceId === undefined) return undefined;
  return (marketplaces ?? []).find(marketplace => marketplace.id !== undefined && String(marketplace.id) === String(plugin.marketplaceId));
}
function resolveInstallGitUrl(pluginGitUrl: string, marketplace: EffectiveMarketplace | null | undefined): string {
  const distributionGitUrl = marketplace?.distributionGitUrl?.trim();
  if (!distributionGitUrl || marketplace?.gitUrl && !isSameCanonicalRepo(pluginGitUrl, marketplace.gitUrl)) return pluginGitUrl;
  return distributionGitUrl;
}
function resolveMarketplaceCloneGitUrl(marketplace: EffectiveMarketplace | null | undefined): string | undefined { return marketplace?.distributionGitUrl?.trim() || marketplace?.gitUrl; }
function resolveEffectivePluginRef(effectivePlugin: EffectivePlugin, marketplaces: readonly EffectiveMarketplace[] | undefined): string {
  if (effectivePlugin.pinnedGitRef) return effectivePlugin.pinnedGitRef;
  if (effectivePlugin.plugin?.gitRef) return effectivePlugin.plugin.gitRef;
  const marketplace = resolveEffectivePluginMarketplace(effectivePlugin.plugin, marketplaces), pluginGitUrl = effectivePlugin.plugin?.gitUrl, marketplaceGitUrl = marketplace?.gitUrl;
  return !(pluginGitUrl && marketplaceGitUrl && pluginGitUrl !== marketplaceGitUrl) && marketplace?.gitRef ? marketplace.gitRef : "main";
}

function encodeBackendPluginSource(gitUrl: string, ref: string, gitPath?: string): string { return `${BACKEND_GIT_PREFIX}${encodeURIComponent(gitUrl)}@${encodeURIComponent(ref)}${gitPath ? `#${encodeURIComponent(gitPath)}` : ""}`; }
function decodeBackendPluginSource(downloadUrl: string): { gitUrl: string; ref: string; gitPath?: string | undefined } | null {
  if (!downloadUrl.startsWith(BACKEND_GIT_PREFIX)) return null;
  const rest = downloadUrl.slice(BACKEND_GIT_PREFIX.length), hashIndex = rest.indexOf("#"), refPart = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest, pathPart = hashIndex >= 0 ? rest.slice(hashIndex + 1) : undefined, atIndex = refPart.lastIndexOf("@");
  if (atIndex < 0) return null;
  const gitPath = pathPart ? decodeURIComponent(pathPart) : undefined;
  return { gitUrl: decodeURIComponent(refPart.slice(0, atIndex)), ref: decodeURIComponent(refPart.slice(atIndex + 1)), gitPath };
}
function encodeBackendReleaseSource(options: { repo: string; asset: string; tag?: string }): string { return `${BACKEND_RELEASE_PREFIX}${encodeURIComponent(options.repo)}#${encodeURIComponent(options.asset)}${options.tag ? `@${encodeURIComponent(options.tag)}` : ""}`; }
function decodeBackendReleaseSource(downloadUrl: string): { repo: string; asset: string; tag?: string | undefined } | null {
  if (!downloadUrl.startsWith(BACKEND_RELEASE_PREFIX)) return null;
  const rest = downloadUrl.slice(BACKEND_RELEASE_PREFIX.length), hashIndex = rest.indexOf("#"); if (hashIndex < 0) return null;
  const repo = decodeURIComponent(rest.slice(0, hashIndex)), afterHash = rest.slice(hashIndex + 1), atIndex = afterHash.lastIndexOf("@");
  return { repo, asset: decodeURIComponent(atIndex >= 0 ? afterHash.slice(0, atIndex) : afterHash), tag: atIndex >= 0 ? decodeURIComponent(afterHash.slice(atIndex + 1)) : undefined };
}
function getCanonicalRepoIdentity(gitUrl: string): string | null { try { const segments = getCanonicalMarketplacePathSegments(gitUrl); return `${segments.host}\0${segments.pathSegments.join("\0")}`; } catch { return null; } }
function isSameCanonicalRepo(left: string, right: string): boolean { if (left.trim() === right.trim()) return true; const leftIdentity = getCanonicalRepoIdentity(left), rightIdentity = getCanonicalRepoIdentity(right); return leftIdentity !== null && leftIdentity === rightIdentity; }

async function deriveGitPathFromMarketplaceManifest(cloneDir: string, pluginName: string): Promise<{ type: "resolved"; gitPath: string } | { type: "manifest-unresolved"; reason: string } | { type: "no-manifest" }> {
  for (const manifestRelPath of MARKETPLACE_MANIFEST_PATHS) {
    let content: string; try { content = await readFile(join(cloneDir, manifestRelPath), "utf-8"); } catch { continue; }
    const parseResult = parseMarketplaceManifest(content);
    if (!parseResult.success) return { type: "manifest-unresolved", reason: `Invalid marketplace manifest at ${manifestRelPath}: ${parseResult.error}` };
    const entry = parseResult.data.plugins.find(plugin => plugin.name === pluginName.toLowerCase());
    if (!entry) return { type: "manifest-unresolved", reason: `Plugin ${JSON.stringify(pluginName)} not found in ${manifestRelPath}` };
    if (typeof entry.source !== "string" && entry.source.source === "git-subdir") return { type: "manifest-unresolved", reason: `Plugin ${JSON.stringify(pluginName)} uses unsupported git-subdir source` };
    const resolved = resolvePluginSourcePath(entry.source, parseResult.data.metadata?.pluginRoot);
    if (!resolved || !isPathSafe(resolved)) return { type: "manifest-unresolved", reason: `Plugin ${JSON.stringify(pluginName)} has unresolved or unsafe source path` };
    return { type: "resolved", gitPath: resolved };
  }
  return { type: "no-manifest" };
}

async function shallowClone(gitUrl: string, ref: string, targetDir: string, pluginLogger: PluginMetricsLogger = noopPluginMetricsLogger, extraGitConfig?: ExtraGitConfig, materialize: MaterializeSpec = "all", sparsePluginClones = false): Promise<void> {
  const startTime = performance.now(), isSha = SHA_REF_REGEX.test(ref), isHead = ref.toUpperCase() === "HEAD";
  const gitConfig = { ...extraGitConfig, "safe.directory": targetDir }, remoteTimeoutMs = sparsePluginClones ? REMOTE_GIT_TIMEOUT_MS : undefined, localTimeoutMs = sparsePluginClones ? LOCAL_GIT_TIMEOUT_MS : undefined;
  const { sparse, sparseDirs } = await resolveSparseClonePlan(materialize, sparsePluginClones), sparseCloneArgs = sparse ? ["--filter=blob:none", "--sparse"] : [], sparseSshBatchMode = sparse ? true : undefined;
  const setSparseDirs = async (timeoutMs: number | undefined): Promise<void> => { if (sparse) await setSparseCheckoutDirs(targetDir, sparseDirs, { extraGitConfig: gitConfig, timeoutMs, sshBatchMode: true }); };
  const attemptClone = async (cloneUrl: string, sshBatchMode: boolean | undefined): Promise<string> => {
    let stderr = "";
    if (isHead) { ({ stderr } = await execGitNonInteractive(["clone", "--depth", "1", ...sparseCloneArgs, cloneUrl, targetDir], { extraGitConfig: gitConfig, timeoutMs: remoteTimeoutMs, sshBatchMode })); await setSparseDirs(remoteTimeoutMs); }
    else if (isSha) {
      await execGitNonInteractive(["init"], { cwd: targetDir, extraGitConfig: gitConfig, timeoutMs: localTimeoutMs }); await execGitNonInteractive(["remote", "add", "origin", cloneUrl], { cwd: targetDir, extraGitConfig: gitConfig, timeoutMs: localTimeoutMs }); await setSparseDirs(localTimeoutMs);
      ({ stderr } = await execGitNonInteractive(["fetch", "--depth", "1", ...(sparse ? ["--filter=blob:none"] : []), "origin", ref], { cwd: targetDir, extraGitConfig: gitConfig, timeoutMs: remoteTimeoutMs, sshBatchMode }));
      await execGitNonInteractive(["checkout", "FETCH_HEAD"], { cwd: targetDir, extraGitConfig: gitConfig, timeoutMs: remoteTimeoutMs, sshBatchMode });
    } else { ({ stderr } = await execGitNonInteractive(["clone", "--depth", "1", "--branch", ref, ...sparseCloneArgs, cloneUrl, targetDir], { extraGitConfig: gitConfig, timeoutMs: remoteTimeoutMs, sshBatchMode })); await setSparseDirs(remoteTimeoutMs); }
    return stderr;
  };
  const alreadySsh = gitUrl.startsWith("git@") || gitUrl.startsWith("ssh://"), sshUrl = alreadySsh ? null : toScmSshUrl(gitUrl);
  let cloneStderr: string;
  if (sshUrl !== null) {
    try { cloneStderr = await attemptClone(sshUrl, true); }
    catch (error) { if (sparsePluginClones && isKilledSubprocessError(error)) throw error; await rm(targetDir, { recursive: true, force: true }); await mkdir(targetDir, { recursive: true }); cloneStderr = await attemptClone(gitUrl, sparseSshBatchMode); }
  } else cloneStderr = await attemptClone(gitUrl, sparseSshBatchMode);
  if (sparse && serverIgnoredFilter(cloneStderr)) { pluginLogger.log("warn", `shallowClone: server ignored --filter=blob:none for ${gitUrl}; sparse clone downloaded a full pack`); pluginLogger.increment("backend_marketplace_client.shallow_clone.filter_ignored_by_server", 1); }
  const elapsed = (performance.now() - startTime).toFixed(1); log("shallowClone %s@%s completed in %sms", gitUrl, ref, elapsed); pluginLogger.log("info", `shallowClone ${gitUrl}@${ref} completed in ${elapsed}ms (${sparse ? "sparse" : "full"})`);
}

function parseReleaseRepo(repo: string): { apiBase: string; ownerRepo: string; host: string } {
  const parts = repo.split("/");
  if (parts.length === 3) return { apiBase: `https://${parts[0]}/api/v3`, ownerRepo: `${parts[1]}/${parts[2]}`, host: parts[0]! };
  if (parts.length === 2) return { apiBase: "https://api.github.com", ownerRepo: repo, host: "github.com" };
  throw new Error(`Invalid release repo format: ${repo}`);
}
function isAllowedReleaseDownloadHost(downloadHost: string, repoHost: string): boolean { return downloadHost === repoHost || downloadHost.endsWith(".githubusercontent.com") || (repoHost === "github.com" ? downloadHost === "github.com" : downloadHost.endsWith(`.${repoHost}`)); }
async function downloadReleaseAssetBuffer(options: { repo: string; asset: string; tag?: string | undefined; expectedSha256?: string | undefined; githubToken?: string | undefined }): Promise<Buffer> {
  const { repo, asset, tag } = options, { apiBase, ownerRepo, host } = parseReleaseRepo(repo), authHeaders = host === "github.com" && options.githubToken !== undefined && options.githubToken.length > 0 ? { Authorization: `token ${options.githubToken}` } : {};
  const releaseUrl = tag ? `${apiBase}/repos/${ownerRepo}/releases/tags/${encodeURIComponent(tag)}` : `${apiBase}/repos/${ownerRepo}/releases/latest`;
  const releaseResponse = await fetch(releaseUrl, { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "CursorPluginInstaller", ...authHeaders } });
  if (!releaseResponse.ok) throw new Error(`Failed to fetch release from ${releaseUrl}: ${releaseResponse.status} ${releaseResponse.statusText}`);
  const release = await releaseResponse.json() as { assets: Array<{ name: string; size: number; browser_download_url: string }> }, matchingAsset = release.assets.find(candidate => candidate.name === asset);
  if (!matchingAsset) throw new Error(`Release asset "${asset}" not found. Available assets: ${release.assets.map(candidate => candidate.name).join(", ")}`);
  if (matchingAsset.size > MAX_RELEASE_ASSET_BYTES) throw new Error(`Release asset "${asset}" exceeds maximum size of ${MAX_RELEASE_ASSET_BYTES} bytes (actual: ${matchingAsset.size})`);
  const downloadUrl = new URL(matchingAsset.browser_download_url);
  if (downloadUrl.protocol !== "https:" || !isAllowedReleaseDownloadHost(downloadUrl.hostname, host)) throw new Error(`Refusing to download release asset from untrusted host: ${downloadUrl.hostname}`);
  const assetResponse = await fetch(matchingAsset.browser_download_url, { headers: { "User-Agent": "CursorPluginInstaller", Accept: "application/octet-stream", ...authHeaders } });
  if (!assetResponse.ok) throw new Error(`Failed to download release asset: ${assetResponse.status} ${assetResponse.statusText}`);
  if (assetResponse.url) { const finalUrl = new URL(assetResponse.url); if (finalUrl.protocol !== "https:" || !isAllowedReleaseDownloadHost(finalUrl.hostname, host)) throw new Error(`Refusing to download release asset: redirected to untrusted host: ${finalUrl.hostname}`); }
  const buffer = Buffer.from(await assetResponse.arrayBuffer());
  if (buffer.byteLength > MAX_RELEASE_ASSET_BYTES) throw new Error(`Release asset "${asset}" actual download size exceeds maximum of ${MAX_RELEASE_ASSET_BYTES} bytes (actual: ${buffer.byteLength})`);
  if (options.expectedSha256) { const actual = createHash("sha256").update(buffer).digest("hex"); if (actual !== options.expectedSha256) throw new Error(`Release asset "${asset}" integrity check failed: expected SHA-256 ${options.expectedSha256}, got ${actual}`); }
  return buffer;
}
async function downloadReleaseToDir(repo: string, asset: string, tag: string | undefined, targetDir: string, expectedSha256?: string, githubToken?: string): Promise<void> {
  const buffer = await downloadReleaseAssetBuffer({ repo, asset, tag, expectedSha256, githubToken }), compressedSize = buffer.byteLength;
  await mkdir(targetDir, { recursive: true }); const tempDir = await mkdtemp(join(tmpdir(), "release-asset-")), tempTarPath = join(tempDir, "asset.tar.gz"), extractDir = join(tempDir, "extracted");
  try {
    await writeFile(tempTarPath, buffer); await mkdir(extractDir, { recursive: true }); let totalUncompressedSize = 0, entryCount = 0;
    await extract({ file: tempTarPath, cwd: extractDir, onReadEntry: entry => { entryCount++; if (entryCount > MAX_EXTRACT_FILE_COUNT) throw new Error(`Release archive contains too many files (>${MAX_EXTRACT_FILE_COUNT}).`); totalUncompressedSize += entry.size; if (totalUncompressedSize > MAX_UNCOMPRESSED_EXTRACT_BYTES) throw new Error(`Release archive uncompressed size exceeds maximum of ${MAX_UNCOMPRESSED_EXTRACT_BYTES} bytes.`); if (compressedSize > 0 && totalUncompressedSize / compressedSize > MAX_EXTRACT_COMPRESSION_RATIO) throw new Error(`Release archive has suspicious compression ratio (>${MAX_EXTRACT_COMPRESSION_RATIO}x).`); } });
    const topEntries = await readdir(extractDir, { withFileTypes: true }), topDirs = topEntries.filter(entry => entry.isDirectory()), topFiles = topEntries.filter(entry => entry.isFile()); let sourceDir = extractDir;
    if (topDirs.length === 1 && topFiles.length === 0) { const wrapperDir = join(extractDir, topDirs[0]!.name); if (containsPluginRootDir(await readdir(wrapperDir))) sourceDir = wrapperDir; }
    await Promise.all((await readdir(sourceDir)).map(name => cp(join(sourceDir, name), join(targetDir, name), { recursive: true, verbatimSymlinks: true })));
  } finally { await rm(tempDir, { recursive: true, force: true }).catch(() => {}); }
}

export interface MarketplaceDescriptor { id: string; name: string; gitUrl?: string; gitRef?: string }
export interface BackendPluginEntry {
  pluginId: string; pluginDbId?: string | undefined; configuredVariables?: unknown; isTeamRequired?: boolean | undefined; name: string; version: string; downloadUrl: string; marketplaceDbId?: string | undefined; marketplace?: MarketplaceDescriptor | undefined; inlineContentJson?: string | undefined; gitPath?: string | undefined; isOriginBacked?: true | undefined;
}
export interface BackendPluginListFailure { pluginName: string; pluginId: string; pluginDbId?: string | undefined; marketplaceName?: string | undefined; errorMessage: string; errorType: "timeout" | "clone" }

async function clonePluginToDir(entry: BackendPluginEntry, targetDir: string, pluginLogger: PluginMetricsLogger = noopPluginMetricsLogger, extraGitConfig?: ExtraGitConfig, options?: { expectedReleaseAssetSha256?: string | undefined; githubToken?: string | undefined; sparsePluginClones?: boolean | undefined }): Promise<void> {
  const sparsePluginClones = options?.sparsePluginClones ?? false, materializeTimeoutMs = sparsePluginClones ? REMOTE_GIT_TIMEOUT_MS : undefined, releaseSource = decodeBackendReleaseSource(entry.downloadUrl);
  if (releaseSource) {
    if (entry.gitPath) { const tempDir = await mkdtemp(join(tmpdir(), "release-plugin-")); try { await downloadReleaseToDir(releaseSource.repo, releaseSource.asset, releaseSource.tag, tempDir, options?.expectedReleaseAssetSha256, options?.githubToken); const sourceDir = validateAndResolveSubpath(tempDir, entry.gitPath); await mkdir(targetDir, { recursive: true }); await cp(sourceDir, targetDir, { recursive: true, verbatimSymlinks: true }); } finally { await rm(tempDir, { recursive: true, force: true }).catch(() => {}); } }
    else await downloadReleaseToDir(releaseSource.repo, releaseSource.asset, releaseSource.tag, targetDir, options?.expectedReleaseAssetSha256, options?.githubToken);
    return;
  }
  const source = decodeBackendPluginSource(entry.downloadUrl); if (!source) throw new Error(`Invalid download URL format for plugin ${entry.pluginId}: ${entry.downloadUrl}`);
  const tempDir = await mkdtemp(join(tmpdir(), "backend-plugin-"));
  try {
    await shallowClone(source.gitUrl, source.ref, tempDir, pluginLogger, extraGitConfig, source.gitPath ? materializeSpecForGitPaths([source.gitPath]) : [], sparsePluginClones);
    let sourceDir: string;
    if (source.gitPath) sourceDir = validateAndResolveSubpath(tempDir, source.gitPath);
    else {
      const derived = await deriveGitPathFromMarketplaceManifest(tempDir, entry.name);
      if (derived.type === "resolved") { await materializeSparseDirs(tempDir, materializeSpecForGitPaths([derived.gitPath]), { extraGitConfig, timeoutMs: materializeTimeoutMs }); sourceDir = validateAndResolveSubpath(tempDir, derived.gitPath); }
      else if (derived.type === "manifest-unresolved") throw new Error(`Unable to install plugin ${JSON.stringify(entry.name)} without gitPath: ${derived.reason}`);
      else { await materializeSparseDirs(tempDir, "all", { extraGitConfig, timeoutMs: materializeTimeoutMs }); sourceDir = tempDir; }
    }
    await mkdir(targetDir, { recursive: true }); await cp(sourceDir, targetDir, { recursive: true, verbatimSymlinks: true });
  } finally { await rm(tempDir, { recursive: true, force: true }).catch(() => {}); }
}

export interface BackendMarketplaceClientOptions {
  marketplaceCacheRoot?: string | undefined; pluginLogger?: PluginMetricsLogger | undefined; marketplaceCacheOptions?: MarketplaceCacheOptions | undefined; listOptions?: { allowedMarketplaceNames?: readonly string[] | undefined; enableInlinePlugins?: boolean | undefined } | undefined; extraGitConfig?: ExtraGitConfigProvider; githubToken?: string | undefined; sparsePluginClones?: boolean | undefined;
}

export class BackendMarketplaceClient {
  private readonly pluginLogger: PluginMetricsLogger;
  private readonly extraGitConfig: ExtraGitConfigProvider;
  private readonly githubToken: string | undefined;
  private readonly sparsePluginClones: boolean;
  private readonly marketplaceCache: MarketplaceCacheManager | undefined;
  private readonly allowedMarketplaceNames: Set<string> | undefined;
  private readonly enableInlinePlugins: boolean;
  constructor(private readonly getEffectiveUserPlugins: () => Promise<EffectivePluginsResponse>, optionsOrMarketplaceCacheRoot?: BackendMarketplaceClientOptions | string, pluginLogger?: PluginMetricsLogger, marketplaceCacheOptions?: MarketplaceCacheOptions, listOptions?: BackendMarketplaceClientOptions["listOptions"]) {
    const options: BackendMarketplaceClientOptions = typeof optionsOrMarketplaceCacheRoot === "string" || optionsOrMarketplaceCacheRoot === undefined ? { marketplaceCacheRoot: optionsOrMarketplaceCacheRoot, pluginLogger, marketplaceCacheOptions, listOptions } : optionsOrMarketplaceCacheRoot;
    const resolvedMarketplaceCacheOptions = options.marketplaceCacheOptions ?? marketplaceCacheOptions;
    this.pluginLogger = options.pluginLogger ?? pluginLogger ?? noopPluginMetricsLogger; this.extraGitConfig = options.extraGitConfig; this.githubToken = options.githubToken; this.sparsePluginClones = options.sparsePluginClones ?? false;
    this.marketplaceCache = options.marketplaceCacheRoot ? new MarketplaceCacheManager(options.marketplaceCacheRoot, { ...resolvedMarketplaceCacheOptions, extraGitConfig: resolvedMarketplaceCacheOptions?.extraGitConfig ?? options.extraGitConfig, sparsePluginClones: this.sparsePluginClones }) : undefined;
    const resolvedListOptions = options.listOptions ?? listOptions; this.allowedMarketplaceNames = resolvedListOptions?.allowedMarketplaceNames ? new Set(resolvedListOptions.allowedMarketplaceNames) : undefined; this.enableInlinePlugins = resolvedListOptions?.enableInlinePlugins ?? false;
  }
  private isMarketplaceAllowed(marketplace: EffectiveMarketplace | null | undefined): boolean { return this.allowedMarketplaceNames === undefined || marketplace?.name !== undefined && this.allowedMarketplaceNames.has(marketplace.name); }

  async listEnabledPlugins(_userId?: string, _teamId?: string): Promise<{ plugins: BackendPluginEntry[]; listFailures: BackendPluginListFailure[] }> {
    const response = await this.getEffectiveUserPlugins(), pluginList = response.plugins ?? [], marketplacesList = response.marketplaces ?? [], plugins: BackendPluginEntry[] = [], listFailures: BackendPluginListFailure[] = [], resolvedShaByGitRef = new Map<string, string>();
    const resolveVersionSha = async (repoUrl: string, gitRef: string): Promise<string> => {
      const key = `${repoUrl}\0${gitRef}`; let sha = resolvedShaByGitRef.get(key);
      if (!sha) {
        const extraGitConfig = resolveExtraGitConfig(this.extraGitConfig), timeoutMs = this.sparsePluginClones ? LS_REMOTE_TIMEOUT_MS : undefined, alreadySsh = repoUrl.startsWith("git@") || repoUrl.startsWith("ssh://"), sshUrl = alreadySsh ? null : toScmSshUrl(repoUrl);
        const runLsRemote = async (url: string, sshBatchMode: boolean): Promise<string> => { const options: { sshBatchMode?: true; extraGitConfig?: ExtraGitConfig; timeoutMs?: number } = {}; if (sshBatchMode) options.sshBatchMode = true; if (extraGitConfig !== undefined) options.extraGitConfig = extraGitConfig; if (timeoutMs !== undefined) options.timeoutMs = timeoutMs; return (Object.keys(options).length > 0 ? await resolveGitRemoteRef(url, gitRef, options) : await resolveGitRemoteRef(url, gitRef)).fullSha; };
        if (sshUrl !== null) { try { sha = await runLsRemote(sshUrl, true); } catch (error) { if (this.sparsePluginClones && isKilledSubprocessError(error)) throw error; sha = await runLsRemote(repoUrl, false); } }
        else sha = await runLsRemote(repoUrl, false);
        resolvedShaByGitRef.set(key, sha);
      }
      return sha;
    };
    const resolveVersionShaWithSourceFallback = async (args: { preferredGitUrl: string; sourceGitUrl: string; gitRef: string; pluginId: string }): Promise<{ sha: string; gitUrl: string }> => {
      if (args.preferredGitUrl !== args.sourceGitUrl) {
        const preferredKey = `${args.preferredGitUrl}\0${args.gitRef}`, isFirstOriginAttempt = !resolvedShaByGitRef.has(preferredKey); if (isFirstOriginAttempt) this.pluginLogger.increment("marketplace.origin_distribution.fetch", 1);
        try { const resolved = { sha: await resolveVersionSha(args.preferredGitUrl, args.gitRef), gitUrl: args.preferredGitUrl }; if (isFirstOriginAttempt) try { this.pluginLogger.log("info", `Resolved plugin ${args.pluginId} from Origin distribution mirror ${args.preferredGitUrl}@${args.gitRef}`, { pluginId: args.pluginId, preferredGitUrl: args.preferredGitUrl, gitRef: args.gitRef }); } catch {} return resolved; }
        catch (error) { if (isFirstOriginAttempt) this.pluginLogger.increment("marketplace.origin_distribution.fetch.error", 1); this.pluginLogger.captureException(error, { error_type: "distribution_url_fallback" }); this.pluginLogger.log("warn", `Distribution mirror ${args.preferredGitUrl}@${args.gitRef} unavailable (not synced yet or unreachable); falling back to source ${args.sourceGitUrl}`, { ...args, error: String(error) }); }
      }
      return { sha: await resolveVersionSha(args.sourceGitUrl, args.gitRef), gitUrl: args.sourceGitUrl };
    };
    for (const effectivePlugin of pluginList) {
      if (!effectivePlugin.isEnabled || !effectivePlugin.plugin?.name) continue;
      const plugin = effectivePlugin.plugin, marketplaceDefinition = resolveEffectivePluginMarketplace(plugin, marketplacesList);
      if (!this.isMarketplaceAllowed(marketplaceDefinition)) { this.pluginLogger.log("info", `Skipping plugin ${plugin.name} because marketplace ${marketplaceDefinition?.name ?? "<none>"} is not allowed`, { pluginId: plugin.name, marketplaceName: marketplaceDefinition?.name, allowedMarketplaceNames: this.allowedMarketplaceNames !== undefined ? Array.from(this.allowedMarketplaceNames) : undefined }); continue; }
      const name = catalogInstallNameForPlugin({ name: plugin.name, pluginId: plugin.id !== undefined ? String(plugin.id) : plugin.name ?? "" }), pluginId = name;
      if (!plugin.gitUrl) {
        if (!this.enableInlinePlugins) { this.pluginLogger.log("info", `Skipping plugin ${name} without gitUrl (enableInlinePlugins=false)`, { pluginId }); continue; }
        if (!effectivePlugin.inlineContentJson) { this.pluginLogger.log("info", `Skipping DB-inline plugin ${name}: no inline content provided`, { pluginId }); continue; }
        const version = createHash("sha256").update(`${plugin.id ?? "0"}:${plugin.updatedAt ?? "0"}`).digest("hex").slice(0, 40), marketplace = marketplaceDefinition?.name ? { id: marketplaceDefinition.id !== undefined ? `${marketplaceDefinition.name}-${marketplaceDefinition.id}` : `${marketplaceDefinition.name}-inline`, name: marketplaceDefinition.name } : undefined;
        this.pluginLogger.log("info", `BackendMarketplaceClient: Adding DB-inline plugin: ${pluginId}`, { pluginId, marketplaceId: marketplace?.id ?? "unknown", version });
        plugins.push({ pluginId, pluginDbId: plugin.id !== undefined ? String(plugin.id) : undefined, configuredVariables: effectivePlugin.configuredVariables, isTeamRequired: effectivePlugin.isTeamRequired, name, version, downloadUrl: `inline://${plugin.id ?? pluginId}`, marketplaceDbId: marketplaceDefinition?.id !== undefined ? String(marketplaceDefinition.id) : undefined, marketplace, inlineContentJson: effectivePlugin.inlineContentJson }); continue;
      }
      const gitUrl = plugin.gitUrl, preferredInstallGitUrl = resolveInstallGitUrl(gitUrl, marketplaceDefinition), ref = resolveEffectivePluginRef(effectivePlugin, marketplacesList), releaseSource = getReleasePluginSource(plugin, ref), marketplaceRef = marketplaceDefinition?.gitRef ?? ref;
      let version: string, installGitUrl = preferredInstallGitUrl;
      try { if (releaseSource !== undefined) version = `release/${releaseSource.releaseTag}`; else { const resolved = await resolveVersionShaWithSourceFallback({ preferredGitUrl: preferredInstallGitUrl, sourceGitUrl: gitUrl, gitRef: ref, pluginId }); version = resolved.sha; installGitUrl = resolved.gitUrl; } }
      catch (error) { this.pluginLogger.captureException(error, { error_type: "resolve_version_sha" }); this.pluginLogger.log("error", `Failed to resolve version for plugin ${name}@${ref}, skipping plugin`, { pluginId, ref, error: String(error) }); const errorMessage = error instanceof Error ? error.message : String(error); listFailures.push({ pluginName: name, pluginId, pluginDbId: plugin.id !== undefined ? String(plugin.id) : undefined, marketplaceName: marketplaceDefinition?.name, errorMessage, errorType: /timed?\s*out/i.test(errorMessage) ? "timeout" : "clone" }); continue; }
      const downloadUrl = releaseSource !== undefined ? encodeBackendReleaseSource({ repo: releaseSource.releaseRepo, asset: releaseSource.releaseAsset, tag: releaseSource.releaseTag }) : encodeBackendPluginSource(installGitUrl, ref, plugin.gitPath ?? undefined);
      const marketplaceCloneGitUrl = resolveMarketplaceCloneGitUrl(marketplaceDefinition); let effectiveMarketplaceCloneGitUrl = marketplaceCloneGitUrl, marketplaceGitRef = marketplaceRef;
      if (marketplaceDefinition?.gitUrl && marketplaceCloneGitUrl) {
        const marketplaceUsesPluginRepo = isSameCanonicalRepo(gitUrl, marketplaceDefinition.gitUrl), preferredCacheRepoUrl = marketplaceUsesPluginRepo ? installGitUrl : marketplaceCloneGitUrl, sourceCacheRepoUrl = marketplaceUsesPluginRepo ? gitUrl : marketplaceDefinition.gitUrl, cacheRef = marketplaceUsesPluginRepo ? ref : marketplaceRef;
        try { const resolved = await resolveVersionShaWithSourceFallback({ preferredGitUrl: preferredCacheRepoUrl, sourceGitUrl: sourceCacheRepoUrl, gitRef: cacheRef, pluginId }); marketplaceGitRef = resolved.sha; effectiveMarketplaceCloneGitUrl = resolved.gitUrl; }
        catch (error) { this.pluginLogger.captureException(error, { error_type: "resolve_marketplace_cache_ref" }); this.pluginLogger.log("warn", `Failed to resolve marketplace cache ref for plugin ${name} from ${preferredCacheRepoUrl}@${cacheRef}, falling back to raw ref`, { pluginId, cacheRepoUrl: preferredCacheRepoUrl, cacheRef, error: String(error) }); effectiveMarketplaceCloneGitUrl = sourceCacheRepoUrl; }
      }
      const marketplace = marketplaceDefinition?.name ? { id: marketplaceDefinition.id !== undefined ? `${marketplaceDefinition.name}-${marketplaceDefinition.id}` : `${marketplaceDefinition.name}-${encodeURIComponent(marketplaceDefinition.gitUrl ?? "project")}`, name: marketplaceDefinition.name, ...(effectiveMarketplaceCloneGitUrl ? { gitUrl: effectiveMarketplaceCloneGitUrl, gitRef: marketplaceGitRef } : {}) } : undefined;
      this.pluginLogger.log("info", `BackendMarketplaceClient: Adding enabled plugin: ${pluginId} from ${marketplaceGitRef} at ${plugin.gitPath}`, { pluginId, marketplaceId: marketplace?.id ?? "unknown", gitPath: plugin.gitPath ?? undefined, gitRef: marketplaceGitRef });
      plugins.push({ pluginId, pluginDbId: plugin.id !== undefined ? String(plugin.id) : undefined, configuredVariables: effectivePlugin.configuredVariables, isTeamRequired: effectivePlugin.isTeamRequired, name, version, downloadUrl, marketplaceDbId: marketplaceDefinition?.id !== undefined ? String(marketplaceDefinition.id) : undefined, marketplace, gitPath: plugin.gitPath ?? undefined, isOriginBacked: releaseSource === undefined && installGitUrl !== gitUrl ? true : undefined });
    }
    return { plugins, listFailures };
  }

  private isDirectInstallSameFetch(entry: BackendPluginEntry): boolean { const marketplace = entry.marketplace; if (!marketplace?.gitUrl || !marketplace.gitRef) return false; const direct = decodeBackendPluginSource(entry.downloadUrl); return direct !== null && isSameCanonicalRepo(direct.gitUrl, marketplace.gitUrl) && (direct.ref === marketplace.gitRef || entry.version === marketplace.gitRef); }
  async installPlugin(entry: BackendPluginEntry, targetDir: string): Promise<void> {
    if (entry.inlineContentJson) { await synthesizeInlinePluginDir({ targetDir, inlineContentJson: entry.inlineContentJson, pluginName: entry.name }); return; }
    if (decodeBackendReleaseSource(entry.downloadUrl) === null) {
      try { if (await this.tryInstallFromMarketplaceCache(entry, targetDir)) { this.emitOriginLoadIfApplicable(entry); return; } }
      catch (error) { this.pluginLogger.captureException(error, { error_type: "install_plugin_from_marketplace_cache" }); if (this.sparsePluginClones && this.isDirectInstallSameFetch(entry) && isKilledSubprocessError(error)) { this.pluginLogger.log("warn", `Failed to install plugin ${entry.name} from marketplace cache; skipping direct install fallback because it would repeat the identical fetch`, { pluginId: entry.pluginId, version: entry.version, error: String(error) }); throw error; } this.pluginLogger.log("warn", `Failed to install plugin ${entry.name} from marketplace cache, falling back to direct install`, { pluginId: entry.pluginId, version: entry.version, error: String(error) }); }
    }
    await clonePluginToDir(entry, targetDir, this.pluginLogger, resolveExtraGitConfig(this.extraGitConfig), { githubToken: this.githubToken, sparsePluginClones: this.sparsePluginClones }); this.emitOriginLoadIfApplicable(entry);
  }
  private emitOriginLoadIfApplicable(entry: BackendPluginEntry): void { if (!entry.isOriginBacked) return; try { this.pluginLogger.increment("marketplace.origin_distribution.load", 1); this.pluginLogger.log("info", `Loaded plugin ${entry.pluginId} from Origin distribution (fetch complete)`, { pluginId: entry.pluginId }); } catch {} }
  async prewarmMarketplaceClones(entries: readonly BackendPluginEntry[]): Promise<void> {
    if (!this.marketplaceCache) return;
    const groups = new Map<string, { marketplaceId: string; gitUrl: string; gitRef: string; gitPaths: string[] }>();
    for (const entry of entries) { const marketplace = entry.marketplace; if (!marketplace?.gitUrl) continue; const gitRef = marketplace.gitRef ?? "main", key = `${marketplace.id}\0${marketplace.gitUrl}\0${gitRef}`; let group = groups.get(key); if (group === undefined) { group = { marketplaceId: marketplace.id, gitUrl: marketplace.gitUrl, gitRef, gitPaths: [] }; groups.set(key, group); } if (entry.gitPath) group.gitPaths.push(entry.gitPath); }
    for (const group of groups.values()) { const materialize = materializeSpecForGitPaths(group.gitPaths), start = performance.now(); try { await this.marketplaceCache.ensureCloned(group.marketplaceId, group.gitUrl, group.gitRef, this.pluginLogger, { materialize }); this.pluginLogger.log("info", `Prewarmed marketplace clone ${group.gitUrl}@${group.gitRef} for ${group.gitPaths.length} plugin directories`, { ...group, requestedDirs: group.gitPaths.length, materialize: materialize === "all" ? "all" : materialize.length }); this.pluginLogger.increment("marketplace_cache_manager.prewarm.success", 1, { materialize: materialize === "all" ? "all" : "dirs" }); }
      catch (error) { this.pluginLogger.captureException(error, { error_type: "prewarm_marketplace_clone" }); this.pluginLogger.log("warn", `Failed to prewarm marketplace clone ${group.gitUrl}@${group.gitRef}; falling back to per-plugin materialization`, { ...group, error: String(error) }); this.pluginLogger.increment("marketplace_cache_manager.prewarm.error", 1); }
      this.pluginLogger.distribution("marketplace_cache_manager.prewarm.duration", performance.now() - start);
    }
  }
  private async tryInstallFromMarketplaceCache(entry: BackendPluginEntry, targetDir: string): Promise<boolean> {
    const cache = this.marketplaceCache, marketplace = entry.marketplace;
    if (!cache || !marketplace?.gitUrl) { this.pluginLogger.log("info", "No marketplace cache or marketplace metadata, skipping cache check", { pluginId: entry.pluginId, name: entry.name, version: entry.version, marketplaceId: entry.marketplace?.id }); return false; }
    const clonePath = await cache.ensureCloned(marketplace.id, marketplace.gitUrl, marketplace.gitRef ?? "main", this.pluginLogger, { materialize: entry.gitPath ? materializeSpecForGitPaths([entry.gitPath]) : [] });
    const gitPath = entry.gitPath ?? await cache.resolvePluginPath(clonePath, entry.name); if (!gitPath) { this.pluginLogger.log("info", "No git path found for plugin, skipping cache check", { pluginId: entry.pluginId, name: entry.name, version: entry.version, marketplaceId: entry.marketplace?.id }); return false; }
    if (entry.gitPath === undefined) await cache.ensureMaterialized(clonePath, materializeSpecForGitPaths([gitPath]), this.pluginLogger);
    await cache.copyPluginToDir(cache.getPluginDir(clonePath, gitPath), targetDir); return true;
  }
  async discoverMarketplacePlugins(marketplaceId: string, gitUrl: string, gitRef: string) { if (!this.marketplaceCache) throw new Error("discoverMarketplacePlugins requires a MarketplaceCacheManager (marketplaceCacheRoot)"); const clonePath = await this.marketplaceCache.ensureCloned(marketplaceId, gitUrl, gitRef, this.pluginLogger, { materialize: [] }); return this.marketplaceCache.discoverPlugins(clonePath); }
}

export function createBackendMarketplaceClient(getEffectiveUserPlugins: () => Promise<EffectivePluginsResponse>, marketplaceCacheRootOrOptions?: string | BackendMarketplaceClientOptions, pluginLogger?: PluginMetricsLogger, marketplaceCacheOptions?: MarketplaceCacheOptions, listOptions?: BackendMarketplaceClientOptions["listOptions"]): BackendMarketplaceClient {
  return new BackendMarketplaceClient(getEffectiveUserPlugins, marketplaceCacheRootOrOptions, pluginLogger, marketplaceCacheOptions, listOptions);
}
