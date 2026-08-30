import { parse } from "jsonc-parser";
import { expandEnvVarsWithLookup, type EnvLookup } from "./env-expansion.js";
import { isPathSafe, parsePluginManifest, PLUGIN_MANIFEST_PATHS } from "./manifest-parser.js";
import { expandPluginVariables } from "./plugin-variables.js";
import { readSchemaId, resolveSchemaVersion, schemaVersionsDisagree } from "./schema-version.js";
import { mcpConfigSchema, noopPluginMetricsLogger, type McpConfig, type McpServerConfig, type PluginMetricsLogger } from "./types.js";

export const PLUGIN_MCP_CONFIG_FILE_NAMES = [".mcp.json", "mcp.json"] as const;
const MCP_NON_SERVER_METADATA_KEYS = ["author", "owner", "source", "metadata"] as const;
const NON_SERVER_METADATA_KEY_SET = new Set(MCP_NON_SERVER_METADATA_KEYS.map(key => key.toLowerCase()));

export interface McpParserOptions {
  cloudAgentEnvLookup?: EnvLookup | undefined;
  configuredVariables?: Readonly<Record<string, unknown>> | undefined;
  log?: PluginMetricsLogger | undefined;
  pluginSchemaId?: string | undefined;
  skipExpansion?: boolean | undefined;
}
export type McpFileReader = (path: string) => Promise<string | null>;
export interface ResolvedMcpConfig extends McpConfig { mcpServers: Record<string, McpServerConfig>; mcpServerSourcePaths?: Record<string, string> | undefined }
export interface ResolveMcpOptions {
  toSourcePath?: ((path: string) => string) | undefined;
  installPathForExpansion?: string | undefined;
  fallbackFileNames?: readonly string[] | undefined;
  manifestPrecedence?: "override" | "fill" | undefined;
  parserOptions?: McpParserOptions | undefined;
}

function isMcpMetadataKey(key: string): boolean { return NON_SERVER_METADATA_KEY_SET.has(key.toLowerCase()); }
function isMcpLikelyMetadataObject(key: string, value: unknown): boolean {
  if (!isMcpMetadataKey(key) || typeof value !== "object" || value === null) return false;
  const metadata = value as Record<string, unknown>;
  switch (key.toLowerCase()) {
    case "author": case "owner": return typeof metadata.name === "string";
    case "source": return typeof metadata.source === "string" || typeof metadata.repo === "string" || typeof metadata.path === "string" || typeof metadata.ref === "string" || typeof metadata.sha === "string";
    case "metadata": return typeof metadata.description === "string" || typeof metadata.version === "string" || typeof metadata.pluginRoot === "string";
    default: return false;
  }
}
function isMcpServerLikeObject(value: unknown): boolean { return typeof value === "object" && value !== null && ("command" in value || "url" in value); }

export function resolvePluginMcpConfigPaths(pluginPath?: string): string[] {
  const normalizedPluginPath = pluginPath !== undefined && pluginPath.length > 0 ? pluginPath.replace(/\/+$/, "") : undefined;
  return PLUGIN_MCP_CONFIG_FILE_NAMES.map(name => normalizedPluginPath !== undefined ? `${normalizedPluginPath}/${name}` : name);
}

function expandMcpEnvPlaceholders<T>(value: T, options?: McpParserOptions): T {
  const cloud = options?.cloudAgentEnvLookup, configured = options?.configuredVariables;
  if (cloud !== undefined) return expandEnvVarsWithLookup(value, cloud);
  return expandEnvVarsWithLookup(value, key => {
    const environment = process.env[key]; if (environment !== undefined) return environment;
    const configuredValue = configured?.[key]; if (configuredValue === undefined || configuredValue === null) return undefined;
    return typeof configuredValue === "string" ? configuredValue : String(configuredValue);
  });
}
function expandMcpServerConfig(config: McpConfig, pluginPath: string, options?: McpParserOptions): McpConfig {
  if (!config.mcpServers) return config;
  const expandedServers: Record<string, McpServerConfig> = {};
  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    const expanded: McpServerConfig = { ...serverConfig };
    if (typeof serverConfig.command === "string") expanded.command = expandPluginVariables(serverConfig.command, pluginPath);
    if (Array.isArray(serverConfig.args)) expanded.args = serverConfig.args.map(argument => typeof argument === "string" ? expandPluginVariables(argument, pluginPath) : argument);
    if (serverConfig.env && typeof serverConfig.env === "object") { const environment: Record<string, string> = {}; for (const [key, value] of Object.entries(serverConfig.env)) environment[key] = typeof value === "string" ? expandPluginVariables(value, pluginPath) : value; expanded.env = environment; }
    if (typeof serverConfig.cwd === "string") expanded.cwd = expandPluginVariables(serverConfig.cwd, pluginPath);
    expandedServers[serverName] = expanded;
  }
  return expandMcpEnvPlaceholders({ ...config, mcpServers: expandedServers }, options);
}
function parsePluginMcpConfig(content: string, installPath: string, options?: McpParserOptions): McpConfig | null {
  try {
    const data = parse(content) as unknown, schemaId = readSchemaId(data);
    if (schemaId !== undefined) {
      const logger = options?.log ?? noopPluginMetricsLogger;
      if (resolveSchemaVersion(schemaId).kind === "unsupported") logger.log("warn", `mcp.json declares an unrecognized $schema, loading anyway: ${schemaId}`);
      else if (schemaVersionsDisagree(options?.pluginSchemaId, schemaId)) logger.log("warn", `mcp.json $schema ${schemaId} disagrees with plugin.json $schema ${options?.pluginSchemaId}, loading anyway`);
    }
    const parsed = mcpConfigSchema.safeParse(data), skipExpansion = options?.skipExpansion === true;
    if (parsed.success && parsed.data.mcpServers && Object.keys(parsed.data.mcpServers).length > 0) return skipExpansion ? parsed.data : expandMcpServerConfig(parsed.data, installPath, options);
    const rootServers: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) if (key !== "mcpServers" && !isMcpLikelyMetadataObject(key, value) && isMcpServerLikeObject(value)) rootServers[key] = value;
    if (Object.keys(rootServers).length > 0) { const wrapped = mcpConfigSchema.safeParse({ mcpServers: rootServers }); if (wrapped.success) return skipExpansion ? wrapped.data : expandMcpServerConfig(wrapped.data, installPath, options); }
    return null;
  } catch { return null; }
}
function mergeResolvedServers(target: { mcpServers: Record<string, McpServerConfig>; mcpServerSourcePaths: Record<string, string> }, servers: Record<string, McpServerConfig>, sourcePath: string): void { for (const [name, server] of Object.entries(servers)) { target.mcpServers[name] = server; target.mcpServerSourcePaths[name] = sourcePath; } }

async function resolveManifestMcpServersWithReader(mcpServers: unknown, readFileContent: McpFileReader, options: ResolveMcpOptions & { manifestSourcePath?: string | undefined } = {}): Promise<{ mcpServers: Record<string, McpServerConfig>; mcpServerSourcePaths: Record<string, string> }> {
  const toSourcePath = options.toSourcePath ?? (path => path), installPath = options.installPathForExpansion ?? "", resolved = { mcpServers: {} as Record<string, McpServerConfig>, mcpServerSourcePaths: {} as Record<string, string> };
  const loadFromPath = async (rawPath: string): Promise<void> => { const normalized = rawPath.replace(/^\.\//, ""); if (!isPathSafe(normalized)) return; const content = await readFileContent(normalized); if (content === null) return; const config = parsePluginMcpConfig(content, installPath, options.parserOptions); if (config?.mcpServers && Object.keys(config.mcpServers).length > 0) mergeResolvedServers(resolved, config.mcpServers, toSourcePath(normalized)); };
  const loadInline = (item: object): void => { const config = parsePluginMcpConfig(JSON.stringify(item), installPath, options.parserOptions); if (config?.mcpServers && Object.keys(config.mcpServers).length > 0) mergeResolvedServers(resolved, config.mcpServers, options.manifestSourcePath ?? "manifest"); };
  if (typeof mcpServers === "string") await loadFromPath(mcpServers);
  else if (Array.isArray(mcpServers)) for (const item of mcpServers) { if (typeof item === "string") await loadFromPath(item); else if (typeof item === "object" && item !== null) loadInline(item); }
  else if (typeof mcpServers === "object" && mcpServers !== null) loadInline(mcpServers);
  return resolved;
}

export async function resolvePluginMcpConfigFromReader(readFileContent: McpFileReader, manifestMcpServers: unknown, manifestSourcePath: string | undefined, options: ResolveMcpOptions = {}): Promise<ResolvedMcpConfig | null> {
  const toSourcePath = options.toSourcePath ?? (path => path), installPath = options.installPathForExpansion ?? "", fallbackFileNames = options.fallbackFileNames ?? PLUGIN_MCP_CONFIG_FILE_NAMES, manifestPrecedence = options.manifestPrecedence ?? "override", mcpServers: Record<string, McpServerConfig> = {}, mcpServerSourcePaths: Record<string, string> = {};
  for (const fileName of fallbackFileNames) { const content = await readFileContent(fileName); if (content === null) continue; const config = parsePluginMcpConfig(content, installPath, options.parserOptions); if (!config?.mcpServers) continue; for (const [name, server] of Object.entries(config.mcpServers)) if (mcpServers[name] === undefined) { mcpServers[name] = server; mcpServerSourcePaths[name] = toSourcePath(fileName); } }
  if (manifestMcpServers !== undefined) {
    const fromManifest = await resolveManifestMcpServersWithReader(manifestMcpServers, readFileContent, { toSourcePath, manifestSourcePath, installPathForExpansion: installPath, parserOptions: options.parserOptions });
    for (const [name, server] of Object.entries(fromManifest.mcpServers)) { if (manifestPrecedence === "fill" && mcpServers[name] !== undefined) continue; mcpServers[name] = server; mcpServerSourcePaths[name] = fromManifest.mcpServerSourcePaths[name]!; }
  }
  if (Object.keys(mcpServers).length === 0) return null;
  return { mcpServers, ...(Object.keys(mcpServerSourcePaths).length > 0 ? { mcpServerSourcePaths } : {}) };
}

export async function resolvePluginMcpConfigWithManifestLookup(readFileContent: McpFileReader, options: ResolveMcpOptions = {}): Promise<ResolvedMcpConfig | null> {
  const toSourcePath = options.toSourcePath ?? (path => path); let manifestMcpServers: unknown, manifestSourcePath: string | undefined, pluginSchemaId: string | undefined;
  for (const manifestPath of PLUGIN_MANIFEST_PATHS) {
    const content = await readFileContent(manifestPath); if (content === null) continue;
    let rawManifest: unknown; try { rawManifest = JSON.parse(content); } catch { continue; }
    pluginSchemaId = readSchemaId(rawManifest); const parsed = parsePluginManifest(content); if (!parsed.success) continue;
    if (parsed.data.mcpServers !== undefined) { manifestMcpServers = parsed.data.mcpServers; manifestSourcePath = toSourcePath(manifestPath); }
    break;
  }
  const resolvedOptions = pluginSchemaId === undefined ? options : { ...options, parserOptions: { ...options.parserOptions, pluginSchemaId } };
  return resolvePluginMcpConfigFromReader(readFileContent, manifestMcpServers, manifestSourcePath, resolvedOptions);
}
