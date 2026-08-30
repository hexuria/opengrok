import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar";
import { sanitizeFilename } from "../utils/path-matchers.js";

export const PLUGINS_CACHE_ROOT = "plugins/cache";
export const PLUGIN_CACHE_SENTINEL = ".cache-complete";

export interface PluginCacheKey {
  readonly marketplaceSlug: string;
  readonly pluginId: string;
  readonly version?: string;
}

function sanitizePluginCacheMarketplaceSlug(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function sanitizePluginCachePluginId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function sanitizePluginCacheVersion(raw: string): string {
  return sanitizeFilename(raw);
}

function getPluginCachePath(
  cacheRoot: string,
  marketplaceSlug: string,
  pluginId: string,
  version?: string,
): string {
  const parts = [cacheRoot, marketplaceSlug, pluginId];
  if (version !== undefined) parts.push(version);
  return join(...parts);
}

export function getPluginInstallCachePath(
  cacheRoot: string,
  args: PluginCacheKey,
): string {
  return getPluginCachePath(
    cacheRoot,
    sanitizePluginCacheMarketplaceSlug(args.marketplaceSlug),
    sanitizePluginCachePluginId(args.pluginId),
    args.version !== undefined
      ? sanitizePluginCacheVersion(args.version)
      : undefined,
  );
}

export class DefaultPluginCacheManager {
  readonly cacheRoot: string;

  constructor(
    userHomeDir?: string,
    options?: { readonly cacheRoot?: string },
  ) {
    const home = userHomeDir ?? process.env.HOME ?? "";
    this.cacheRoot = options?.cacheRoot
      ?? join(home, ".cursor", PLUGINS_CACHE_ROOT);
  }

  getCacheDir(args: PluginCacheKey): string {
    return getPluginInstallCachePath(this.cacheRoot, args);
  }

  async isCached(args: PluginCacheKey): Promise<boolean> {
    const cacheDir = this.getCacheDir(args);
    try {
      const stats = await stat(join(cacheDir, PLUGIN_CACHE_SENTINEL));
      return stats.isFile();
    } catch {
      return false;
    }
  }

  async extractToCache(
    args: PluginCacheKey & { readonly tarball: Uint8Array },
  ): Promise<string> {
    const cacheDir = this.getCacheDir(args);
    await mkdir(cacheDir, { recursive: true });
    const bufferStream = Readable.from(args.tarball);
    await pipeline(
      bufferStream,
      createGunzip(),
      extract({ cwd: cacheDir, strip: 1 }),
    );
    await this.markCacheComplete(args);
    return cacheDir;
  }

  async listCachedVersions(
    args: Omit<PluginCacheKey, "version">,
  ): Promise<string[]> {
    const safeSlug = sanitizePluginCacheMarketplaceSlug(args.marketplaceSlug);
    const safePluginId = sanitizePluginCachePluginId(args.pluginId);
    const pluginDir = join(this.cacheRoot, safeSlug, safePluginId);
    try {
      const entries = await readdir(pluginDir, { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    } catch {
      return [];
    }
  }

  async removeVersion(args: PluginCacheKey): Promise<void> {
    try {
      await rm(this.getCacheDir(args), { recursive: true, force: true });
    } catch {
      // Cache cleanup is best effort in the immutable implementation.
    }
  }

  async removeAllVersions(
    args: Omit<PluginCacheKey, "version">,
  ): Promise<void> {
    await rm(getPluginInstallCachePath(this.cacheRoot, args), {
      recursive: true,
      force: true,
    });
  }

  async pruneOldVersions(
    args: Omit<PluginCacheKey, "version"> & {
      readonly keepVersions: readonly string[];
    },
  ): Promise<void> {
    const cachedVersions = await this.listCachedVersions(args);
    const keepSet = new Set(
      args.keepVersions.map(version => sanitizePluginCacheVersion(version)),
    );
    for (const version of cachedVersions) {
      if (!keepSet.has(version)) {
        await this.removeVersion({ ...args, version });
      }
    }
  }

  async markCacheComplete(args: PluginCacheKey): Promise<void> {
    await writeFile(join(this.getCacheDir(args), PLUGIN_CACHE_SENTINEL), "");
  }
}
