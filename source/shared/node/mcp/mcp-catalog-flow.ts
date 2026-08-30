import { CATALOG_CACHE_TTL_MS } from "./mcp-catalog-cache.js";
import { SandMcpConfigError } from "./mcp-config-error.js";
import { findMissingRequiredCatalogFields } from "./mcp-plugin-variables.js";
import type { SandMarketplacePlugin } from "./mcp-marketplace.js";
export class SandMcpCatalogFlow {
  private readonly catalog = new Map<string, SandMarketplacePlugin>();
  private viewsCache: {
    views: unknown[];
    atMs: number;
    includesPrivateMarketplaces: boolean;
  } | null = null;
  constructor(
    private readonly core: {
      getMachineId: unknown;
      listEffectivePlugins?: () => Promise<
        Array<{ pluginId: string; hasTeamConfiguredVariables?: boolean }>
      >;
      requireAccountWriter(): any;
      reloadServers(): Promise<unknown>;
      bestEffortToken?(token: unknown): Promise<unknown>;
      fetchMarketplace?(
        token: unknown,
        machine: unknown,
      ): Promise<{
        plugins: SandMarketplacePlugin[];
        includesPrivateMarketplaces: boolean;
      }>;
      resolveLogo?(url: string): Promise<unknown>;
      now?: () => number;
    },
  ) {}
  async getCatalog(
    getAccessToken: unknown,
    options?: { forceRefresh?: boolean },
  ): Promise<unknown[]> {
    const marketplace = await import("./mcp-marketplace.js");
    const bestEffort = this.core.bestEffortToken ?? marketplace.bestEffortToken;
    const fetchMarketplace = this.core.fetchMarketplace ?? marketplace.fetchMarketplaceMcpPlugins;
    const authenticated =
        (await bestEffort(getAccessToken)) != null,
      cached = this.viewsCache,
      usable =
        cached != null && cached.includesPrivateMarketplaces === authenticated,
      now = this.core.now?.() ?? Date.now();
    if (
      options?.forceRefresh !== true &&
      usable &&
      now - cached.atMs < CATALOG_CACHE_TTL_MS
    )
      return cached.views;
    let listing;
    try {
      listing = await fetchMarketplace(
        getAccessToken,
        this.core.getMachineId,
      );
    } catch (error) {
      if (!usable) throw error;
      return cached.views;
    }
    this.catalog.clear();
    const views = listing.plugins
      .map((plugin) => {
        this.catalog.set(plugin.pluginId, plugin);
        return marketplace.marketplacePluginToView(plugin);
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.viewsCache = {
      views,
      atMs: this.core.now?.() ?? Date.now(),
      includesPrivateMarketplaces: listing.includesPrivateMarketplaces,
    };
    return views;
  }
  async resolvePluginLogo(url: string): Promise<unknown> {
    if (this.core.resolveLogo != null) return await this.core.resolveLogo(url);
    return await (await import("./mcp-marketplace.js")).resolvePluginLogo(url);
  }
  private async requirePlugin(
    id: string,
    token: unknown,
  ): Promise<SandMarketplacePlugin> {
    let plugin = this.catalog.get(id);
    if (plugin == null) {
      await this.getCatalog(token, { forceRefresh: true });
      plugin = this.catalog.get(id);
    }
    if (plugin == null)
      throw new SandMcpConfigError(
        `Unknown marketplace plugin "${id}". Reopen settings and try again.`,
      );
    return plugin;
  }
  private assertRequired(
    plugin: SandMarketplacePlugin,
    values: Record<string, string | undefined>,
  ): void {
    const missing = findMissingRequiredCatalogFields(
      plugin.variableFields,
      values,
    );
    if (missing.length > 0)
      throw new SandMcpConfigError(
        `"${plugin.displayName}" needs a value for ${missing.map((field) => field.label).join(", ")} before it can be installed. Ask the user for it and pass it in "values" (key${missing.length > 1 ? "s" : ""}: ${missing.map((field) => field.key).join(", ")}), then try again.`,
      );
  }
  async installEntry(
    request: {
      entryId: string;
      values?: Record<string, string>;
      hasTeamConfiguredVariables?: boolean;
    },
    token: unknown,
  ): Promise<unknown> {
    const plugin = await this.requirePlugin(request.entryId, token);
    let teamKnown = request.hasTeamConfiguredVariables === true;
    if (!teamKnown && this.core.listEffectivePlugins != null)
      try {
        teamKnown = (await this.core.listEffectivePlugins()).some(
          (item) =>
            item.pluginId === plugin.pluginId &&
            item.hasTeamConfiguredVariables === true,
        );
      } catch {}
    if (!teamKnown) this.assertRequired(plugin, request.values ?? {});
    await this.core
      .requireAccountWriter()
      .installPlugin({
        pluginId: BigInt(plugin.pluginId),
        ...(request.values == null ? {} : { variables: request.values }),
      });
    return this.core.reloadServers();
  }
  async updatePluginInstall(
    request: { pluginId: string; values: Record<string, string> },
    token: unknown,
  ): Promise<unknown> {
    const plugin = await this.requirePlugin(request.pluginId, token);
    this.assertRequired(plugin, request.values);
    await this.core
      .requireAccountWriter()
      .updatePluginInstall({
        pluginId: BigInt(plugin.pluginId),
        variables: request.values,
      });
    return this.core.reloadServers();
  }
}
