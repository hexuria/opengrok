import type { McpServerConfig } from "./mcp-display-runtime.js";
import {
  bestEffortToken,
  createDashboardClient,
  CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS,
} from "../marketplace/cursor-marketplace-client.js";
import { rememberPluginLogoUrl } from "../marketplace/cursor-marketplace-logo-registry.js";
export { bestEffortToken } from "../marketplace/cursor-marketplace-client.js";
export { resolvePluginLogo } from "./mcp-marketplace-logo.js";
import {
  createDeadlinePolicy,
  realClock,
  type DeadlinePolicy,
} from "../../../internal/scheduling.js";
import {
  pluginVariablesSchemaToFields,
  type PluginVariableField,
} from "./mcp-plugin-variables.js";
export interface SandMarketplacePlugin {
  pluginId: string;
  name: string;
  displayName: string;
  description: string;
  category: string;
  logoUrl: string | undefined;
  homepage: string | undefined;
  sourceUrls: string[];
  connectors: Array<{ name: string; description: string }>;
  skills: Array<{ name: string; description: string; sourceUrl?: string }>;
  variableFields: PluginVariableField[];
  marketplace?: {
    name: string;
    displayName: string;
    ownership: "team" | "user";
  };
  publisher?: { name: string; displayName: string; isUserOwned: boolean };
}
export function marketplacePluginToView(plugin: SandMarketplacePlugin) {
  return {
    id: plugin.pluginId,
    name: plugin.name,
    displayName: plugin.displayName,
    description: plugin.description,
    category: plugin.category,
    homepage: plugin.homepage,
    iconUrl: plugin.logoUrl,
    connectors: plugin.connectors,
    skills: plugin.skills,
    ...(plugin.variableFields.length > 0
      ? { fields: plugin.variableFields }
      : {}),
    ...(plugin.marketplace == null ? {} : { marketplace: plugin.marketplace }),
    ...(plugin.publisher == null ? {} : { publisher: plugin.publisher }),
  };
}
export function toRawGithubUrl(blobUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(blobUrl);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || parts[2] !== "blob") return null;
  const [owner, repo, , ref, ...rest] = parts;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join("/")}`;
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value != null && !Array.isArray(value);
export function normalizeServer(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const { transport, ...rest } = value;
  if (typeof transport === "string" && rest.type == null) {
    if (transport === "sse") rest.type = "sse";
    else if (transport === "http" || transport === "streamableHttp")
      rest.type = "http";
  }
  return rest;
}
export function normalizePluginConfig(
  raw: unknown,
  safeParse: (value: unknown) => { success: boolean; data?: McpServerConfig },
): Record<string, McpServerConfig> {
  if (!isObject(raw)) return {};
  const candidate = isObject(raw.mcpServers) ? raw.mcpServers : raw,
    servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(candidate)) {
    if (!isObject(value)) continue;
    const parsed = safeParse(normalizeServer(value));
    if (parsed.success && parsed.data != null) servers[name] = parsed.data;
  }
  return servers;
}
export interface MarketplaceDeps {
  bestEffortToken(getAccessToken: unknown): Promise<unknown>;
  createClient(getAccessToken: unknown, getMachineId: unknown): any;
  timeoutMs: number;
  rememberPluginLogoUrl(url: string): void;
  safeParseServer(value: unknown): { success: boolean; data?: McpServerConfig };
  fetch(url: string, signal: AbortSignal): Promise<Response>;
  fetchTimeoutMs: number;
  fetchDeadline?: DeadlinePolicy;
}
export type MarketplaceListingDeps = Pick<
  MarketplaceDeps,
  "bestEffortToken" | "createClient" | "timeoutMs" | "rememberPluginLogoUrl"
>;
const defaultMarketplaceListingDependencies: MarketplaceListingDeps = {
  bestEffortToken,
  createClient: createDashboardClient,
  timeoutMs: CURSOR_MARKETPLACE_REQUEST_TIMEOUT_MS,
  rememberPluginLogoUrl,
};
function toPlugin(
  plugin: any,
  deps: Pick<MarketplaceDeps, "rememberPluginLogoUrl">,
): SandMarketplacePlugin | null {
  const skills = plugin.skills.map((skill: any) => ({
    name: skill.name,
    description: skill.description ?? "",
    ...(skill.sourceUrl != null && skill.sourceUrl.length > 0
      ? { sourceUrl: skill.sourceUrl }
      : {}),
  }));
  if (plugin.mcpServers.length === 0 && skills.length === 0) return null;
  const publisher = plugin.publisher,
    logoUrl = publisher?.logoUrl || plugin.logoUrl || undefined;
  if (logoUrl != null) deps.rememberPluginLogoUrl(logoUrl);
  const marketplace = plugin.marketplace;
  const categoryKey = plugin.curatedCategoryKeys.find(
    (value: string) => value.length > 0,
  );
  return {
    pluginId: plugin.id.toString(),
    name: plugin.mcpServers[0]?.name ?? plugin.name,
    displayName:
      plugin.displayName.length > 0 ? plugin.displayName : plugin.name,
    description: plugin.description ?? "",
    category:
      categoryKey == null
        ? "MCP"
        : categoryKey
            .toLowerCase()
            .split("_")
            .map((word: string) =>
              word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : word,
            )
            .join(" "),
    logoUrl,
    homepage: plugin.repositoryUrl || publisher?.websiteUrl || undefined,
    sourceUrls: plugin.mcpServers
      .map((server: any) => server.sourceUrl ?? "")
      .filter((url: string) => url.length > 0),
    connectors: plugin.mcpServers.map((server: any) => ({
      name: server.name,
      description: server.description ?? "",
    })),
    skills,
    variableFields: pluginVariablesSchemaToFields(plugin.variables?.toJson()),
    ...(marketplace != null &&
    (marketplace.teamId != null || marketplace.userId != null)
      ? {
          marketplace: {
            name: marketplace.name,
            displayName:
              marketplace.displayName != null &&
              marketplace.displayName.length > 0
                ? marketplace.displayName
                : marketplace.name,
            ownership:
              marketplace.teamId != null
                ? ("team" as const)
                : ("user" as const),
          },
        }
      : {}),
    ...(publisher == null
      ? {}
      : {
          publisher: {
            name: publisher.name,
            displayName:
              publisher.displayName.length > 0
                ? publisher.displayName
                : publisher.name,
            isUserOwned: publisher.isUserOwned,
          },
        }),
  };
}
export async function fetchMarketplaceMcpPlugins(
  getAccessToken: unknown,
  getMachineId: unknown,
  deps: MarketplaceListingDeps = defaultMarketplaceListingDependencies,
): Promise<{
  plugins: SandMarketplacePlugin[];
  includesPrivateMarketplaces: boolean;
}> {
  const client = deps.createClient(getAccessToken, getMachineId),
    response = await client.listMarketplacePlugins(
      { excludeCloudAgentPlugins: true },
      { timeoutMs: deps.timeoutMs },
    ),
    byId = new Map<string, SandMarketplacePlugin>();
  const add = (plugin: any) => {
    const converted = toPlugin(plugin, deps);
    if (converted != null) byId.set(converted.pluginId, converted);
  };
  response.plugins.forEach(add);
  const includesPrivateMarketplaces =
    (await deps.bestEffortToken(getAccessToken)) != null;
  if (includesPrivateMarketplaces) {
    let marketplaces: any[] = [];
    try {
      marketplaces = (
        await client.listMarketplaces({}, { timeoutMs: deps.timeoutMs })
      ).marketplaces.filter(
        (item: any) => item.teamId != null || item.userId != null,
      );
    } catch {}
    const lists = await Promise.all(
      marketplaces.map(async (marketplace) => {
        try {
          return (
            await client.listMarketplacePlugins(
              { marketplaceId: marketplace.id, excludeCloudAgentPlugins: true },
              { timeoutMs: deps.timeoutMs },
            )
          ).plugins;
        } catch {
          return [];
        }
      }),
    );
    lists.flat().forEach(add);
  }
  return {
    plugins: [...byId.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    ),
    includesPrivateMarketplaces,
  };
}
const parseConfigText = (
  text: string,
  deps: MarketplaceDeps,
): Record<string, McpServerConfig> => {
  try {
    return normalizePluginConfig(JSON.parse(text), deps.safeParseServer);
  } catch {
    return {};
  }
};
export async function fetchPluginServers(
  plugin: SandMarketplacePlugin,
  getAccessToken: unknown,
  getMachineId: unknown,
  deps: MarketplaceDeps,
): Promise<Record<string, McpServerConfig>> {
  if ((await deps.bestEffortToken(getAccessToken)) != null) {
    try {
      const response = await deps
          .createClient(getAccessToken, getMachineId)
          .getPluginMcpConfig(
            { pluginId: BigInt(plugin.pluginId) },
            { timeoutMs: deps.timeoutMs },
          ),
        parsed = parseConfigText(response.configJson ?? "", deps);
      if (Object.keys(parsed).length > 0) return parsed;
    } catch {}
  }
  const fetchDeadline =
    deps.fetchDeadline ??
    createDeadlinePolicy(realClock, {
      name: "mcp-marketplace-fetch",
      timeoutMs: deps.fetchTimeoutMs,
    });
  for (const sourceUrl of plugin.sourceUrls) {
    const raw = toRawGithubUrl(sourceUrl);
    if (raw == null) continue;
    try {
      const response = await fetchDeadline.run((signal) =>
        deps.fetch(raw, signal),
      );
      if (!response.ok) continue;
      const servers = parseConfigText(await response.text(), deps);
      if (Object.keys(servers).length > 0) return servers;
    } catch {}
  }
  return {};
}
