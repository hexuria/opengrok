import { z } from "zod";
import { getDefaultMcpCustomInstruction } from "../../../shared/mcp-custom-instructions.js";
import {
  decodeMcpAccountLabelArgument,
  encodeMcpAccountLabelForListing,
  formatMcpAccountLabelForPrompt,
} from "../../../shared/mcp.js";
import { isMcpServerId } from "../../../shared/node/mcp/mcp-server-id.js";
import { defineCommunicateTool } from "./communicate-tool.js";
import {
  readMcpInstalledListing,
  resolveMcpServerRowByIdentifierOrLegacyId,
  resolveMcpServerRowsByIdentifierOrLegacyId,
} from "./mcp-server-resolution.js";

export interface McpInstalledServer {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly serverIdentifier: string;
  readonly name: string;
  readonly status: string;
  readonly accountKey: string;
  readonly transport: string;
  readonly toolCount: number;
  readonly disabledToolCount?: number;
  readonly pluginId?: string;
  readonly statusDetail?: string;
  readonly customInstructions: string;
  readonly isTeamServer?: boolean;
}

export interface McpPluginSummary {
  readonly pluginId: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly isInstalled: boolean;
  readonly installMode?: string;
  readonly connectorCount: number;
  readonly skills: readonly { readonly name: string; readonly description: string }[];
}

export interface McpPluginDetail extends McpPluginSummary {
  readonly fields: readonly {
    readonly key: string;
    readonly label: string;
    readonly isRequired: boolean;
    readonly isSecret: boolean;
  }[];
  readonly servers: readonly McpInstalledServer[];
}

export type McpAuthenticationResult =
  | { readonly kind: "started"; readonly serverName: string }
  | { readonly kind: "already-authenticated"; readonly serverName: string }
  | { readonly kind: "not-configured"; readonly serverName: string }
  | { readonly kind: "not-supported"; readonly serverName: string; readonly message: string }
  | { readonly kind: "unreachable"; readonly serverName: string; readonly message: string };

export interface McpManagementDependencies {
  listPlugins(): Promise<readonly McpPluginSummary[]>;
  getPlugin(pluginId: string): Promise<McpPluginDetail | null>;
  install(args: { readonly id: string; readonly values?: Readonly<Record<string, string>> }): Promise<void>;
  add(args: { readonly name: string; readonly configJson: string }): Promise<readonly McpInstalledServer[]>;
  listInstalled(): Promise<readonly McpInstalledServer[]>;
  removeServer(serverId: string): Promise<{
    readonly removed: boolean;
    readonly reason?: string;
    readonly servers: readonly McpInstalledServer[];
  }>;
  uninstallPlugin(pluginId: string): Promise<{ readonly removed: boolean; readonly reason?: string }>;
  setInstructions(args: { readonly serverId: string; readonly instructions: string }): Promise<readonly McpInstalledServer[]>;
  restart(): Promise<readonly McpInstalledServer[]>;
  authenticate(serverId: string, accountKey: string, requestingAgentId: string | null, forceReauth: boolean): Promise<McpAuthenticationResult>;
  removeAccount(args: { readonly serverId: string; readonly accountKey: string }): Promise<readonly McpInstalledServer[]>;
  renameAccount(args: { readonly serverId: string; readonly accountKey: string; readonly newAccountKey: string }): Promise<readonly McpInstalledServer[]>;
}

export interface ConnectorCard {
  readonly connector: string;
  readonly serverId: string;
  readonly variant: "connect" | "connected";
}

export const searchPluginsParameters = z.object({
  query: z.string().trim().optional().describe(
    `Optional. What you're looking for, in natural language (e.g. "manage linear issues" or "write word documents") \u2014 results come back ranked by relevance. Omit to list the whole catalog.`,
  ),
});
export const getPluginParameters = z.object({
  plugin_id: z.string().trim().min(1).describe("The stable plugin id from SearchPlugins."),
});
export const installPluginParameters = z.object({
  plugin_id: z.string().trim().min(1).describe("The stable plugin id from SearchPlugins."),
  values: z.record(z.string(), z.string()).optional().describe(
    `Optional setup values keyed by the plugin's field key from GetPlugin (e.g. { "CONTEXT7_API_KEY": "..." }). Provide every required field. Ask the user for any secret you don't already have.`,
  ),
});
export const addMcpServerParameters = z.object({
  name: z.string().trim().min(1).describe('A short, unique name for the server, e.g. "superpowers".'),
  url: z.string().trim().min(1).describe("The remote server's MCP endpoint URL (https)."),
  headers: z.record(z.string(), z.string()).optional().describe(
    'Optional HTTP headers for the server, e.g. { "Authorization": "Bearer <token>" }. Ask the user for any secret rather than guessing.',
  ),
});

export const PLUGIN_QUERY_MIN_TOKEN_LENGTH = 3;

export function tokenizePluginQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(
    (token) => token.length >= PLUGIN_QUERY_MIN_TOKEN_LENGTH,
  ))];
}

export function scorePluginForToken(plugin: McpPluginSummary, token: string): number {
  const name = plugin.name.toLowerCase();
  const displayName = plugin.displayName.toLowerCase();
  if (name === token || displayName === token) return 8;
  if (name.includes(token) || displayName.includes(token)) return 5;
  if (plugin.skills.some((skill) => skill.name.toLowerCase().includes(token))) return 3;
  if (plugin.category.toLowerCase().includes(token)) return 2;
  if (plugin.description.toLowerCase().includes(token)) return 1;
  return 0;
}

export function rankPluginsLexically<T extends McpPluginSummary>(plugins: readonly T[], query: string): T[] {
  const tokens = tokenizePluginQuery(query);
  const byName = (left: T, right: T): number => left.displayName.localeCompare(right.displayName);
  if (tokens.length === 0) return [...plugins].sort(byName);
  return plugins.map((plugin) => ({
    plugin,
    score: tokens.reduce((sum, token) => sum + scorePluginForToken(plugin, token), 0),
  })).filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || byName(left.plugin, right.plugin))
    .map((entry) => entry.plugin);
}

export function validateRemoteMcpUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `"${rawUrl}" is not a valid URL. Ask the user for the server's full https endpoint (e.g. https://example.com/mcp) and try again.`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `The server URL must be http(s); "${parsed.protocol}" is not supported. Grok Bot only connects remote http/sse MCP servers over HTTP(S), so ask the user for an https endpoint.`;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return `Don't put credentials in the server URL \u2014 pass them as headers instead (e.g. { "Authorization": "Bearer <token>" }), so they aren't stored in plaintext in the URL. Ask the user for the token and try again with a clean URL.`;
  }
  return null;
}

export function buildServerConfigJson(args: { readonly url?: string | undefined; readonly headers?: Readonly<Record<string, string>> | undefined }): string | null {
  if (args.url == null || args.url.length === 0) return null;
  return JSON.stringify({
    type: "http",
    url: args.url,
    ...(args.headers != null && Object.keys(args.headers).length > 0 ? { headers: args.headers } : {}),
  });
}

export function truncateOneLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function describeInstalled(server: McpInstalledServer): string {
  const parts = [
    `- ${server.serverIdentifier}: ${server.name} [${server.status}]`,
    `account=${encodeMcpAccountLabelForListing(server.accountKey)}`,
    `transport=${server.transport}`,
    server.disabledToolCount != null && server.disabledToolCount > 0
      ? `tools=${server.toolCount}/${server.toolCount + server.disabledToolCount} enabled`
      : `tools=${server.toolCount}`,
  ];
  if (server.pluginId != null) parts.push(`plugin=${server.pluginId} (remove via UninstallPlugin — removes the whole plugin)`);
  if (server.statusDetail != null && server.statusDetail.length > 0) parts.push(`detail="${truncateOneLine(server.statusDetail, 200)}"`);
  if (server.customInstructions.length > 0 && server.customInstructions !== getDefaultMcpCustomInstruction(server.name)) {
    parts.push(`instructions="${truncateOneLine(server.customInstructions, 120)}"`);
  }
  return parts.join(" · ");
}

export function describeInstalledList(servers: readonly McpInstalledServer[]): string {
  return servers.length === 0
    ? "No MCP servers are installed."
    : [`${servers.length} installed MCP server(s):`, ...servers.map(describeInstalled)].join("\n");
}

function describePluginInstallState(plugin: McpPluginSummary): string {
  if (!plugin.isInstalled) return "installed=no";
  return plugin.installMode != null ? `installed=yes (${plugin.installMode})` : "installed=yes";
}

function describePluginIncludes(plugin: McpPluginSummary): string {
  const parts: string[] = [];
  if (plugin.connectorCount > 0) parts.push(`${plugin.connectorCount} connector${plugin.connectorCount === 1 ? "" : "s"}`);
  if (plugin.skills.length > 0) parts.push(`${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", ") : "no primitives";
}

export function describePluginSummary(plugin: McpPluginSummary): string {
  const result = [
    `- ${plugin.pluginId}: ${plugin.displayName} \u2014 ${plugin.description}`,
    `  (${[
      describePluginInstallState(plugin),
      `includes: ${describePluginIncludes(plugin)}`,
      `category=${plugin.category}`
    ].join("; ")})`,
  ];
  const guidance = getDefaultMcpCustomInstruction(plugin.displayName);
  if (guidance.length > 0) result.push(`  usage guidance: ${guidance}`);
  return result.join("\n");
}

export function describePluginDetail(detail: McpPluginDetail): string {
  const sections = [
    `${detail.pluginId}: ${detail.displayName} \u2014 ${detail.description}`,
    `${describePluginInstallState(detail)} \xB7 includes: ${describePluginIncludes(detail)} \xB7 category=${detail.category}`,
  ];
  if (detail.skills.length > 0) {
    sections.push(["Skills:", ...detail.skills.map((skill) =>
      `  - ${skill.name}${skill.description.length > 0 ? ` \u2014 ${truncateOneLine(skill.description, 140)}` : ""}`,
    )].join("\n"));
  }
  if (detail.fields.length > 0) {
    sections.push(["Setup fields (pass in InstallPlugin values):", ...detail.fields.map((field) => {
      const flags = [field.isRequired ? "required" : "optional", ...(field.isSecret ? ["secret \u2014 ask the user, never guess"] : [])];
      return `  - ${field.key} (${field.label}; ${flags.join(", ")})`;
    })].join("\n"));
  }
  if (detail.servers.length > 0) sections.push(["Its installed MCP server(s) — statuses live in GetMcpServerStatus:", ...detail.servers.map(describeInstalled)].join("\n"));
  if (detail.isInstalled && detail.installMode === "team-required") sections.push("Required by the user's team — it cannot be uninstalled.");
  return sections.join("\n");
}

export const CARD_SHOWN_NOTE = "Its connect card is now in the chat. Finish unrelated work, then end your turn — you're resumed automatically when the user authorizes. Don't send a link, another card, or reach the service another way meanwhile.";
export const MCP_AWAITING_SELECTION_MESSAGE = "You just sent a question widget, so this turn is waiting on the user's selection — their answer arrives as the next message. Don't install, uninstall, restart, or authenticate an MCP server in the same turn as the confirmation widget; wait for the user to confirm, then do it on your next turn.";

export function newNeedsAuthRows(before: readonly McpInstalledServer[], after: readonly McpInstalledServer[]): Array<{ id: string; name: string }> {
  const prior = new Set(before.map((server) => server.serverIdentifier));
  const rows = new Map<string, string>();
  for (const server of after) {
    if (!prior.has(server.serverIdentifier) && server.status === "needsAuth") rows.set(server.id, server.name);
  }
  return [...rows].map(([id, name]) => ({ id, name }));
}

export function emitAndDescribeAuthResult(
  result: McpAuthenticationResult,
  isForceReauth: boolean,
  serverId: string,
  emitConnectorCard?: (card: ConnectorCard) => void,
): string {
  switch (result.kind) {
    case "started":
      emitConnectorCard?.({ connector: result.serverName, serverId, variant: "connect" });
      return isForceReauth
        ? `Signed "${result.serverName}" out and started a fresh sign-in. ${CARD_SHOWN_NOTE}`
        : `Authentication started for "${result.serverName}". ${CARD_SHOWN_NOTE}`;
    case "already-authenticated":
      emitConnectorCard?.({ connector: result.serverName, serverId, variant: "connected" });
      return `"${result.serverName}" is already authenticated and connected; a confirmation card is now in the chat.`;
    case "not-configured": return `"${result.serverName}" is not installed, so there is nothing to authenticate. Install it first.`;
    case "not-supported": return `"${result.serverName}" does not support interactive authentication: ${result.message}`;
    case "unreachable": return `Sign-in for "${result.serverName}" never started. The server or its configuration failed the check: "${result.message}" \u2014 not a missing credential, so the user authenticating in Settings would hit the same error. Tell them what it reported instead of sending them to Settings.`;
  }
}

const serverIdParameters = z.object({ server_id: z.string().trim().min(1) });
const statusParameters = z.object({ server_id: z.string().trim().optional() });
const instructionsParameters = serverIdParameters.extend({ instructions: z.string() });
const forceReauth = z.boolean().optional();
const authParameters = serverIdParameters.extend({ force_reauth: forceReauth });
const multiAuthParameters = authParameters.extend({ account_label: z.string().trim().min(1) });
const accountParameters = serverIdParameters.extend({ account_label: z.string().trim().min(1) });
const renameParameters = accountParameters.extend({ new_account_label: z.string().trim().min(1) });

function noInstalledServerMessage(token: string): string {
  return `No installed MCP server "${token}". Run GetMcpServerStatus to list every server with its identifier.`;
}

export function createMcpManagementTools(
  management: McpManagementDependencies,
  getRequestingAgentId?: () => string | undefined,
  isAwaitingUserSelection?: () => boolean,
  isMultiAccountEnabled?: () => boolean,
  emitConnectorCard?: (card: ConnectorCard) => void,
) {
  const multiAccount = isMultiAccountEnabled?.() === true;
  const guardMutation = <A>(execute: (ctx: unknown, args: A, deps: McpManagementDependencies & { toolCallId: string }) => Promise<string>) =>
    async (ctx: unknown, args: A, deps: McpManagementDependencies & { toolCallId: string }): Promise<string> =>
      isAwaitingUserSelection?.() === true ? MCP_AWAITING_SELECTION_MESSAGE : execute(ctx, args, deps);

  const resolveServerId = async (deps: McpManagementDependencies, token: string): Promise<string | null> => {
    const trimmed = token.trim();
    if (isMcpServerId(trimmed)) return trimmed;
    const listing = await readMcpInstalledListing(() => deps.listInstalled());
    return listing.kind === "unreadable" ? trimmed : resolveMcpServerRowByIdentifierOrLegacyId(listing.servers, trimmed)?.id ?? null;
  };

  const emitNeedsAuthCards = (before: readonly McpInstalledServer[], after: readonly McpInstalledServer[]): string | null => {
    const rows = newNeedsAuthRows(before, after);
    if (rows.length === 0 || emitConnectorCard == null) return null;
    for (const row of rows) emitConnectorCard({ connector: row.name, serverId: row.id, variant: "connect" });
    return rows.length === 1
      ? `"${rows[0]?.name ?? "Connector"}" needs authentication. ${CARD_SHOWN_NOTE}`
      : `${rows.map((row) => `"${row.name}"`).join(", ")} need authentication. ${CARD_SHOWN_NOTE}`;
  };

  const tools = [
    defineCommunicateTool(management, {
      id: "SEARCH_PLUGINS", name: "SearchPlugins", description: "Search the plugins the user could install (or already has): marketplace plugins bundling connectors and skills. Say what you're looking for in natural language and results come back ranked by relevance, each with its STABLE plugin id, install state, and what it includes. Use this to discover a capability (Linear, Notion, writing Word documents, …) or to check whether a plugin is installed. Inspect one result with GetPlugin; connector runtime statuses (connected/needsAuth) live in GetMcpServerStatus. This is read-only and never needs the user's permission.", parameters: searchPluginsParameters,
      execute: async (_ctx, args: z.infer<typeof searchPluginsParameters>, deps) => {
        const query = (args.query ?? "").trim();
        const plugins = rankPluginsLexically(await deps.listPlugins(), query);
        if (plugins.length === 0) return query.length > 0 ? `No plugins match "${query}".` : "The plugin catalog is empty or unavailable right now.";
        return [`${plugins.length} plugin(s)${query.length > 0 ? ` matching "${query}" (best first)` : " available"}:`, ...plugins.map(describePluginSummary)].join("\n");
      },
    }),
    defineCommunicateTool(management, {
      id: "GET_PLUGIN", name: "GetPlugin", description: "Full detail for one plugin by its STABLE plugin id (from SearchPlugins): what it includes (connectors, skills), its install state, any setup fields InstallPlugin needs (with required/secret flags), and the installed MCP servers backing it. Read this before installing a plugin with setup fields, and before uninstalling (to know the full scope you must disclose). Read-only.", parameters: getPluginParameters,
      execute: async (_ctx, args: z.infer<typeof getPluginParameters>, deps) => {
        const detail = await deps.getPlugin(args.plugin_id);
        return detail == null ? `No plugin with id "${args.plugin_id}".` : describePluginDetail(detail);
      },
    }),
    defineCommunicateTool(management, {
      id: "INSTALL_PLUGIN", name: "InstallPlugin", description: "Install a plugin by its STABLE plugin id (from SearchPlugins) into the user's Cursor account. Only call this after the user has agreed — confirm with a question widget first, since installing changes the user's configuration. Idempotent: re-installing an installed plugin is safe. Pass any setup values GetPlugin lists (ask the user for secrets like API keys — never guess). If an installed connector needs authentication, its connect card is shown to the user automatically — finish unrelated work, then end your turn; you're resumed when they authorize. New tools and skills become available on your next message.", parameters: installPluginParameters,
      execute: guardMutation(async (_ctx, args: z.infer<typeof installPluginParameters>, deps) => {
        const before = await deps.getPlugin(args.plugin_id);
        if (before == null) return `No plugin with id "${args.plugin_id}".`;
        await deps.install({ id: args.plugin_id, ...(args.values == null ? {} : { values: args.values }) });
        const after = await deps.getPlugin(args.plugin_id);
        if (after == null || !after.isInstalled) return `The install request for "${before.displayName}" completed, but the plugin does not read as installed yet.`;
        const note = emitNeedsAuthCards(before.servers, after.servers);
        return [`Installed ${after.displayName} (plugin ${after.pluginId}).`, ...(note == null ? [] : [note]), describePluginDetail(after)].join("\n");
      }),
    }),
    defineCommunicateTool(management, {
      id: "ADD_MCP_SERVER", name: "AddMcpServer", description: "Add a remote MCP server that isn't in the catalog to the user's Cursor account — use this when the user gives you a link for a server that SearchPlugins doesn't know. Only call this after the user agrees to add it — confirm with a question widget first, since it changes the user's account configuration and the server can reach external services on their behalf. Provide the remote server's `url` (with `headers` for any auth token). Grok Bot only supports remote http/sse MCP servers (executed on the backend); local/stdio servers are not supported. Ask the user for the exact endpoint and any secrets rather than guessing; if you only have a link, open it first (WebFetch) to find the connection details. Newly added tools become available to you on your next message.", parameters: addMcpServerParameters,
      execute: guardMutation(async (_ctx, args: z.infer<typeof addMcpServerParameters>, deps) => {
        const error = validateRemoteMcpUrl(args.url);
        if (error != null) return error;
        const configJson = buildServerConfigJson(args);
        if (configJson == null) return "A remote MCP URL is required.";
        const before = await deps.listInstalled();
        const servers = await deps.add({ name: args.name, configJson });
        const note = emitNeedsAuthCards(before, servers);
        return [`Added "${args.name}".`, ...(note == null ? [] : [note]), describeInstalledList(servers)].join("\n");
      }),
    }),
    defineCommunicateTool(management, {
      id: "UNINSTALL_MCP_SERVER", name: "UninstallMcpServer", description: "Remove ONE custom MCP server — a server added with AddMcpServer, not one that came from a plugin — by its server identifier. This is destructive and deletes the server with all of its accounts, so confirm with the user via a question widget first. A server the listing marks `plugin=<id>` came from a marketplace plugin: removing it would uninstall that WHOLE plugin, which this tool refuses — use UninstallPlugin for those so the confirmation can disclose the full scope." + (multiAccount ? " To remove just one account and keep the server, use RemoveMcpAccount instead." : ""), parameters: serverIdParameters,
      execute: guardMutation(async (_ctx, args: z.infer<typeof serverIdParameters>, deps) => {
        const installed = await deps.listInstalled();
        const row = resolveMcpServerRowByIdentifierOrLegacyId(installed, args.server_id);
        if (row == null) return noInstalledServerMessage(args.server_id);
        if (row.pluginId != null) return `${row.name} was installed from marketplace plugin ${row.pluginId}; use UninstallPlugin.`;
        if (row.isTeamServer === true) return `${row.name} is provided by the user's team, so it can't be removed here.`;
        const result = await deps.removeServer(row.id);
        const status = result.removed ? `Removed MCP server ${row.name} (${row.serverIdentifier}).` : `The removal request for ${row.name} completed, but it still reads as installed.`;
        return [status, describeInstalledList(result.servers)].join("\n");
      }),
    }),
    defineCommunicateTool(management, {
      id: "UNINSTALL_PLUGIN", name: "UninstallPlugin", description: "Uninstall a plugin by its STABLE plugin id (from SearchPlugins). This is destructive and removes the WHOLE PLUGIN — its install record and EVERY connector and skill it added — so confirm with the user via a question widget first, and your confirmation must disclose that full scope (list what goes). Plugins required by the user's team cannot be uninstalled." + (multiAccount ? " This removes each of its servers with ALL of their accounts; to remove just one account from a server, use RemoveMcpAccount instead." : ""), parameters: getPluginParameters,
      execute: guardMutation(async (_ctx, args: z.infer<typeof getPluginParameters>, deps) => {
        const detail = await deps.getPlugin(args.plugin_id);
        if (detail == null) return `No plugin with id "${args.plugin_id}".`;
        if (!detail.isInstalled) return `${detail.displayName} is not installed — nothing to uninstall.`;
        if (detail.installMode === "team-required") return `${detail.displayName} is required by the user's team and cannot be uninstalled.`;
        const result = await deps.uninstallPlugin(args.plugin_id);
        return result.removed ? `Uninstalled ${detail.displayName} (plugin ${detail.pluginId}).` : `The uninstall request for ${detail.displayName} completed, but it still reads as installed.`;
      }),
    }),
    defineCommunicateTool(management, {
      id: "GET_MCP_SERVER_STATUS", name: "GetMcpServerStatus", description: "The runtime status of the user's installed MCP servers (connected / needsAuth / error, per account). Pass server_id (the server identifier, NEVER a display name) for one server; omit it to list everything. Use this to see which connectors still need authentication, to find the identifier a lifecycle tool needs — the same one GetMcpTools and CallMcpTool address — or to check a connector after installing or authenticating. Read-only and never needs the user's permission.", parameters: statusParameters,
      execute: async (_ctx, args: z.infer<typeof statusParameters>, deps) => {
        const installed = await deps.listInstalled();
        const token = args.server_id?.trim();
        if (token == null || token.length === 0) return describeInstalledList(installed);
        const rows = resolveMcpServerRowsByIdentifierOrLegacyId(installed, token);
        return rows.length === 0 ? `No installed MCP server "${token}".` : rows.map(describeInstalled).join("\n");
      },
    }),
    defineCommunicateTool(management, {
      id: "SET_MCP_INSTRUCTIONS", name: "SetMcpInstructions", description: `Set (or clear) an installed connector's custom instructions \u2014 the guidance you follow whenever you use that server (e.g. "Reply in threads on Slack"). Use this when the user tells you how they want a connector used, so the preference persists across turns. Pass an empty string to clear it and fall back to the connector's default. This changes a saved preference, not the connection (no OAuth needed); the current value shows in GetMcpServerStatus when it's been customized.`, parameters: instructionsParameters,
      execute: guardMutation(async (_ctx, args: z.infer<typeof instructionsParameters>, deps) => {
        const serverId = await resolveServerId(deps, args.server_id);
        if (serverId == null) return noInstalledServerMessage(args.server_id);
        const servers = await deps.setInstructions({ serverId, instructions: args.instructions });
        return [`${args.instructions.trim().length === 0 ? "Cleared" : "Updated"} custom instructions for MCP server ${args.server_id}.`, describeInstalledList(servers)].join("\n");
      }),
    }),
    defineCommunicateTool(management, {
      id: "RESTART_MCP_SERVERS", name: "RestartMcpServers", description: "Restart (reconnect) the installed MCP servers — useful when a server is stuck, errored, or you just finished authenticating one. Confirm with the user first if a server is mid-task.", parameters: z.object({}),
      execute: guardMutation(async (_ctx, _args: Record<string, never>, deps) => ["Restarted MCP servers.", describeInstalledList(await deps.restart())].join("\n")),
    }),
  ];

  const authenticate = (parameters: typeof authParameters | typeof multiAuthParameters) => defineCommunicateTool(management, {
    id: "AUTHENTICATE_MCP_SERVER", name: "AuthenticateMcpServer", description: "Authenticate an installed MCP server that needs it (status needsAuth, or a tool call failing with an auth error). This is the only way to start a connector's auth: its connect card is shown to the user automatically — never compose a card, paste an authorization link, or reach the same service another way while its authorization is pending. The user authorizes in place and you're resumed automatically, so finish unrelated work, then end your turn.", parameters,
    execute: guardMutation(async (_ctx, args: { server_id: string; account_label?: string; force_reauth?: boolean }, deps) => {
      const serverId = await resolveServerId(deps, args.server_id);
      if (serverId == null) return noInstalledServerMessage(args.server_id);
      const account = multiAccount ? decodeMcpAccountLabelArgument(args.account_label ?? "default") : "default";
      const result = await deps.authenticate(serverId, account, getRequestingAgentId?.() ?? null, args.force_reauth === true);
      return emitAndDescribeAuthResult(result, args.force_reauth === true, serverId, emitConnectorCard);
    }),
  });
  tools.push(authenticate(multiAccount ? multiAuthParameters : authParameters));

  if (multiAccount) {
    tools.push(
      defineCommunicateTool(management, {
        id: "REMOVE_MCP_ACCOUNT", name: "RemoveMcpAccount", description: "Remove ONE account from an MCP server: the account and its credential are deleted, while the server and its other accounts stay. This is destructive — confirm with the user via a question widget before calling it. To remove a whole custom server (every account), use UninstallMcpServer; to remove a server's whole plugin (every connector, skill, and account), use UninstallPlugin.", parameters: accountParameters,
        execute: guardMutation(async (_ctx, args: z.infer<typeof accountParameters>, deps) => {
          const serverId = await resolveServerId(deps, args.server_id);
          if (serverId == null) return noInstalledServerMessage(args.server_id);
          const accountKey = decodeMcpAccountLabelArgument(args.account_label);
          const servers = await deps.removeAccount({ serverId, accountKey });
          return [`Removed account "${formatMcpAccountLabelForPrompt(accountKey)}" from MCP server ${args.server_id}.`, describeInstalledList(servers)].join("\n");
        }),
      }),
      defineCommunicateTool(management, {
        id: "RENAME_MCP_ACCOUNT", name: "RenameMcpAccount", description: "Rename one of an MCP server's accounts (change its label). The account's server identifier changes with the label at the next listing, so after renaming, re-run GetMcpServerStatus (or GetMcpTools) before calling that account's tools again — stale identifiers fail cleanly. Confirm with a question widget first.", parameters: renameParameters,
        execute: guardMutation(async (_ctx, args: z.infer<typeof renameParameters>, deps) => {
          const serverId = await resolveServerId(deps, args.server_id);
          if (serverId == null) return noInstalledServerMessage(args.server_id);
          const accountKey = decodeMcpAccountLabelArgument(args.account_label);
          const newAccountKey = decodeMcpAccountLabelArgument(args.new_account_label);
          const servers = await deps.renameAccount({ serverId, accountKey, newAccountKey });
          return [`Renamed account "${formatMcpAccountLabelForPrompt(accountKey)}" to "${formatMcpAccountLabelForPrompt(newAccountKey)}" on MCP server ${args.server_id}.`, describeInstalledList(servers)].join("\n");
        }),
      }),
    );
  }
  return tools;
}
