import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Context } from "../context/core.js";
import { createContext } from "../context/core.js";
import { createLogger, loggerKey, type ContextLoggerBackend } from "../context/logger.js";
import { createSpan } from "../context/otel.js";
import { createCounter, createGauge } from "../metrics/index.js";
import {
  McpDescriptor,
  McpFileSystemOptions,
  McpToolDescriptor,
} from "../proto/generated/agent/v1/mcp_pb.js";
import {
  buildMcpToolFileContent,
  isFullMcpLeaseInvalidation,
  mergeMcpLeaseEvents,
  supportsInteractiveMcpAuth,
  type McpLeaseChangeEvent,
  type McpToolFileLike,
} from "../agent-exec/mcp.js";
import { sanitizeServerName } from "./mcp.js";
import { toolAnnotationsJsonField, type ToolAnnotations } from "./mcp-tool-annotations.js";

const loggerBase = createLogger("McpFileSystemWriter");
const MCP_FS_STRUCTURED_LOG_OPT_IN_METADATA_KEY = "mcpFsStructuredLogOptIn";
const MCPS_SUBDIR = "mcps";
const MCP_TOOLS_SUBDIR = "tools";
const SERVER_METADATA_FILENAME = "SERVER_METADATA.json";
const MCP_RESOURCES_SUBDIR = "resources";
const MCP_PROMPTS_SUBDIR = "prompts";
const STAGING_SUFFIX = "~staging";
const PREV_SUFFIX = "~prev";
const INSTRUCTIONS_FILENAME = "INSTRUCTIONS.md";
const STATUS_FILENAME = "STATUS.md";
const MCP_AUTH_TOOL_NAME = "mcp_auth";
const DEFAULT_MCP_AUTH_TOOL_DESCRIPTION = "Authenticate this MCP server so its tools can be used. Call this tool through your MCP tool-calling interface when STATUS.md indicates this server needs authentication.";
const DEFAULT_MCP_ERROR_STATUS_MESSAGE = "The MCP server errored. If this server is important for completing the task, concisely inform the user and ask them to check the MCP status in Cursor's Customize page > MCPs; otherwise continue with a different approach.";
const DEFAULT_MCP_NEEDS_AUTH_STATUS_MESSAGE = 'The MCP server needs authentication. Authenticate it by calling the `{authToolName}` tool for server "{serverIdentifier}" through your MCP tool-calling interface using an empty arguments object. If this server is important for completing the task, authenticate it first; otherwise continue with a different approach.';
const DEFAULT_MCP_NEEDS_AUTH_STATUS_MESSAGE_NO_VIRTUAL_TOOL = "This MCP server requires authentication before its tools can be used. Open Cursor's Customize page > MCPs, select this server, and use Authenticate/Reopen, or refresh credentials in your MCP configuration (for example, mcp.json), then restart this environment. If this server is not required for the task, continue without it.";
const CURSOR_DIR_GITIGNORE_MANAGED_START = "# >>> CURSOR MANAGED BLOCK >>>";
const CURSOR_DIR_GITIGNORE_MANAGED_END = "# <<< CURSOR MANAGED BLOCK <<<";
const CURSOR_DIR_GITIGNORE_CONTENT = [
  "# Ignore everything in .cursor",
  "*",
  "# Un-ignore projects so we can descend to allowlisted subdirs",
  "!projects/",
  "projects/*",
  "!projects/*/",
  "projects/*/*",
  "# MCP tool descriptors, resources, prompts",
  "!projects/*/mcps/",
  "!projects/*/mcps/**",
  "# Agent transcripts for citation",
  "!projects/*/agent-transcripts/",
  "!projects/*/agent-transcripts/**",
  "# Terminal output files",
  "!projects/*/terminals/",
  "!projects/*/terminals/**",
  "# Conversation notes (shared scratchpad)",
  "!projects/*/agent-notes/",
  "!projects/*/agent-notes/**",
  "# Large tool output files",
  "!projects/*/agent-tools/",
  "!projects/*/agent-tools/**",
  "# Plugin cache (rules, skills, agents)",
  "!plugins/",
  "!plugins/**",
  "# Built-in Cursor skills",
  "!skills-cursor/",
  "!skills-cursor/**",
  "# User's personal skills",
  "!skills/",
  "!skills/**",
  "# User's personal slash commands",
  "!commands/",
  "!commands/**",
  "# User's plan files",
  "!plans/",
  "!plans/**",
  "# Subagent state/transcripts",
  "!subagents/",
  "!subagents/**",
  "# User-level cursor rules",
  "!rules/",
  "!rules/**",
].join("\n");
const DEFAULT_DEBOUNCE_MS = 100;
const CLIENT_FETCH_TIMEOUT_MS = 15_000;

const mcpFilesystemDivergence = createCounter("mcp.filesystem.divergence", {
  description: "Divergence detected between MCP lease state and filesystem state",
  labelNames: ["divergence_type", "mcp_source", "configured_servers", "mcp_version"],
});
const mcpFilesystemSyncCheck = createCounter("mcp.filesystem.sync_check", {
  description: "MCP filesystem sync check executed",
  labelNames: ["synced", "mcp_source", "configured_servers", "mcp_version"],
});
const mcpFilesystemSyncExpectedServers = createGauge("mcp.filesystem.sync_check.expected_servers", {
  description: "Number of expected MCP servers at last sync check",
  labelNames: ["mcp_source", "mcp_version"],
});
const mcpFilesystemSyncActualServers = createGauge("mcp.filesystem.sync_check.actual_servers", {
  description: "Number of actual MCP servers at last sync check",
  labelNames: ["mcp_source", "mcp_version"],
});
const mcpFilesystemSyncServersMissing = createGauge("mcp.filesystem.sync_check.servers_missing", {
  description: "Number of expected MCP servers missing from disk at last sync check",
  labelNames: ["mcp_source", "mcp_version"],
});
const mcpFilesystemSyncToolMismatches = createGauge("mcp.filesystem.sync_check.tool_mismatches", {
  description: "Number of MCP servers with tool count mismatches at last sync check",
  labelNames: ["mcp_source", "mcp_version"],
});

const logger = {
  debug(ctx: Context, message: string, metadata?: Readonly<Record<string, unknown>>, options?: { includeStructuredLogs?: boolean }): void {
    loggerBase.debug(ctx, message, withStructuredLogOptIn(metadata, options));
  },
  info(ctx: Context, message: string, metadata?: Readonly<Record<string, unknown>>, options?: { includeStructuredLogs?: boolean }): void {
    loggerBase.info(ctx, message, withStructuredLogOptIn(metadata, options));
  },
  warn(ctx: Context, message: string, metadata?: Readonly<Record<string, unknown>>, options?: { includeStructuredLogs?: boolean }): void {
    loggerBase.warn(ctx, message, withStructuredLogOptIn(metadata, options));
  },
  error(ctx: Context, message: string, error: unknown, metadata?: Readonly<Record<string, unknown>>, options?: { includeStructuredLogs?: boolean }): void {
    loggerBase.error(ctx, message, error, withStructuredLogOptIn(metadata, options));
  },
};

function withStructuredLogOptIn(metadata: Readonly<Record<string, unknown>> | undefined, options: { includeStructuredLogs?: boolean } | undefined): Readonly<Record<string, unknown>> | undefined {
  if (!options?.includeStructuredLogs) return metadata;
  return { ...(metadata ?? {}), [MCP_FS_STRUCTURED_LOG_OPT_IN_METADATA_KEY]: true };
}

function configuredServersBucket(count: number): string {
  if (count === 0) return "0";
  if (count <= 3) return "1-3";
  if (count <= 6) return "4-6";
  if (count <= 10) return "7-10";
  return "11+";
}

async function ensureCursorDirGitignore(cursorDir: string): Promise<void> {
  const gitignorePath = join(cursorDir, ".gitignore");
  const managedBlock = `${CURSOR_DIR_GITIGNORE_MANAGED_START}\n${CURSOR_DIR_GITIGNORE_CONTENT}\n${CURSOR_DIR_GITIGNORE_MANAGED_END}\n`;
  await mkdir(cursorDir, { recursive: true });
  let existingContent: string | undefined;
  try { existingContent = await readFile(gitignorePath, "utf-8"); }
  catch (error: unknown) { if ((error as { code?: unknown } | null)?.code !== "ENOENT") throw error; }
  if (existingContent === undefined) { await writeFile(gitignorePath, managedBlock); return; }
  const startIdx = existingContent.indexOf(CURSOR_DIR_GITIGNORE_MANAGED_START);
  const endIdx = existingContent.indexOf(CURSOR_DIR_GITIGNORE_MANAGED_END, startIdx + CURSOR_DIR_GITIGNORE_MANAGED_START.length);
  if (startIdx !== -1 && endIdx !== -1) {
    const before = existingContent.slice(0, startIdx);
    const after = existingContent.slice(endIdx + CURSOR_DIR_GITIGNORE_MANAGED_END.length).replace(/^\n/, "");
    const updatedContent = `${before}${managedBlock}${after}`;
    if (updatedContent !== existingContent) await writeFile(gitignorePath, updatedContent);
    return;
  }
  await writeFile(gitignorePath, managedBlock);
}

function withTimeout<Value>(promise: Promise<Value>, fallback: Value, timeoutMs = CLIENT_FETCH_TIMEOUT_MS): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<Value>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

function sanitizeFileName(name: string): string { return name.replace(/[^a-zA-Z0-9_-]/g, "_"); }
function getValidCopyOverride(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
function interpolateMcpAuthTemplate(template: string, params: { serverIdentifier: string; authToolName: string }): string {
  return template.replace(/\{serverIdentifier\}/g, params.serverIdentifier).replace(/\{authToolName\}/g, params.authToolName);
}
function createVirtualMcpAuthToolDefinition(params: { serverIdentifier: string; serverName: string; plugin?: string | undefined; marketplace?: string | undefined; pluginId?: string | undefined; marketplaceId?: string | undefined; authToolDescription: string }): WriterTool {
  return {
    clientKey: params.serverIdentifier,
    providerIdentifier: params.serverName,
    plugin: params.plugin,
    marketplace: params.marketplace,
    pluginId: params.pluginId,
    marketplaceId: params.marketplaceId,
    toolName: MCP_AUTH_TOOL_NAME,
    name: MCP_AUTH_TOOL_NAME,
    description: params.authToolDescription,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}
function clientStateToServerStatus(state: ClientState): ServerStatus {
  switch (state.kind) {
    case "loading": return "initializing";
    case "requires_authentication": return "needsAuth";
    case "ready": return "connected";
    case "error": return "error";
    default: return "disconnected";
  }
}
function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entryValue]) => [key, canonicalizeJsonValue(entryValue)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}
function canonicalJsonString(value: unknown): string { return JSON.stringify(canonicalizeJsonValue(value)); }
function sortByCanonicalJson<Value>(values: readonly Value[]): Value[] {
  return values.map((value) => ({ value, key: canonicalJsonString(value) })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map((entry) => entry.value);
}
function serverFingerprint(server: WriterServer): string {
  const tools = sortByCanonicalJson(server.tools.map((tool) => ({ name: tool.toolName, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema })));
  const resources = sortByCanonicalJson(server.resources.map((resource) => ({ uri: resource.uri, name: resource.name, description: resource.description, mimeType: resource.mimeType })));
  const prompts = sortByCanonicalJson(server.prompts.map((prompt) => ({ name: prompt.name, description: prompt.description, arguments: prompt.arguments })));
  return canonicalJsonString({ id: server.serverIdentifier, name: server.serverName, plugin: server.plugin, marketplace: server.marketplace, pluginId: server.pluginId, marketplaceId: server.marketplaceId, tools, resources, prompts, instructions: server.instructions, status: server.status });
}

function rejectionReason(result: PromiseSettledResult<unknown>): unknown {
  return result.status === "rejected" ? result.reason : undefined;
}

type ServerStatus = "initializing" | "needsAuth" | "connected" | "error" | "disconnected";
type ClientState = { readonly kind: "loading" | "requires_authentication" | "ready" | "error"; readonly message?: string };
export interface McpFileSystemClient {
  readonly serverName: string;
  readonly plugin?: string | undefined;
  readonly marketplace?: string | undefined;
  readonly pluginId?: string | undefined;
  readonly marketplaceId?: string | undefined;
  getState(ctx: Context): Promise<ClientState>;
  getTools(ctx: Context): Promise<readonly WriterTool[]>;
  listResources(ctx: Context): Promise<{ readonly resources: readonly WriterResource[] }>;
  listPrompts(ctx: Context): Promise<readonly WriterPrompt[]>;
  getInstructions?(ctx: Context): Promise<string | undefined>;
}
export interface McpFileSystemLease {
  onDidChange(listener: (event: McpLeaseChangeEvent | undefined) => void): { dispose(): void };
  getTools(ctx: Context): Promise<readonly WriterTool[]>;
  getToolsForServers?(ctx: Context, serverIdentifiers: readonly string[]): Promise<readonly WriterTool[]>;
  getInstructions(ctx: Context): Promise<readonly WriterInstruction[]>;
  getClients(ctx: Context): Promise<Readonly<Record<string, McpFileSystemClient>>>;
  getClient?(ctx: Context, serverIdentifier: string): Promise<McpFileSystemClient | undefined>;
}
export interface McpFileSystemSnapshotProvider {
  getAllSnapshots(ctx: Context): Promise<readonly McpFileSystemSnapshot[]>;
}
export interface McpFileSystemSnapshot {
  readonly serverIdentifier: string;
  readonly serverName: string;
  readonly plugin?: string;
  readonly marketplace?: string;
  readonly pluginId?: string;
  readonly marketplaceId?: string;
  readonly tools: readonly SnapshotTool[];
  readonly resources: readonly WriterResource[];
  readonly prompts: readonly WriterPrompt[];
  readonly instructions?: string;
  readonly status: ServerStatus;
}
interface SnapshotTool { readonly name: string; readonly annotations?: ToolAnnotations }
interface WriterResource { readonly uri: string; readonly name?: string; readonly description?: string; readonly mimeType?: string }
interface WriterPrompt { readonly name: string; readonly description?: string; readonly arguments?: readonly unknown[] }
interface WriterInstruction { readonly serverIdentifier?: string; readonly serverName?: string; readonly instructions?: string }
interface WriterServer {
  readonly serverIdentifier: string;
  readonly serverName: string;
  readonly plugin?: string | undefined;
  readonly marketplace?: string | undefined;
  readonly pluginId?: string | undefined;
  readonly marketplaceId?: string | undefined;
  readonly sanitizedId: string;
  readonly folderPath: string;
  tools: WriterTool[];
  readonly resources: WriterResource[];
  readonly prompts: WriterPrompt[];
  instructions?: string | undefined;
  readonly status?: ServerStatus | undefined;
}
interface WriterTool extends McpToolFileLike {
  readonly name: string;
  readonly clientKey: string;
  readonly providerIdentifier: string;
  readonly annotations?: ToolAnnotations;
}
interface WriterOptions {
  readonly debounceMs?: number;
  readonly mcpAuthCopyOverrides?: { readonly authToolDescription?: string; readonly errorStatusMessage?: string; readonly needsAuthStatusMessageWithAuthTool?: string; readonly needsAuthStatusMessageWithoutVirtualTool?: string };
  readonly useDirectClientTools?: boolean;
  readonly getEnabledToolsByServer?: (ctx: Context) => Promise<Readonly<Record<string, readonly string[]>>>;
  readonly exposeVirtualMcpAuthTool?: boolean;
  readonly alwaysExposeVirtualMcpAuthTool?: boolean;
  readonly snapshotProvider?: McpFileSystemSnapshotProvider;
  readonly mcpVersion?: string;
  readonly onDidWrite?: (descriptors: readonly McpFileSystemDescriptor[]) => void;
  readonly loggerBackend?: ContextLoggerBackend;
}
export interface McpFileSystemDescriptor { readonly serverIdentifier: string; readonly folderPath: string; readonly tools: readonly { readonly toolName: string; readonly definitionPath: string }[] }

export class McpFileSystemWriter {
  static readonly DIVERGENCE_CHECK_COOLDOWN_MS = 10_000;
  private readonly cachedFingerprints = new Map<string, string>();
  private cachedServerData: WriterServer[] | undefined;
  private disposed = false;
  private hasPendingLeaseChangeEvent = false;
  private pendingServerEvent: McpLeaseChangeEvent | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private writePromise: Promise<void> | undefined;
  private readonly mcpLease: McpFileSystemLease;
  private readonly projectDir: string;
  private readonly debounceMs: number;
  private readonly mcpAuthCopyOverrides: WriterOptions["mcpAuthCopyOverrides"];
  private readonly useDirectClientTools: boolean;
  private readonly enabledToolsByServerProvider: WriterOptions["getEnabledToolsByServer"];
  private readonly exposeVirtualMcpAuthTool: boolean;
  private readonly alwaysExposeVirtualMcpAuthTool: boolean;
  private readonly snapshotProvider: McpFileSystemSnapshotProvider | undefined;
  private readonly mcpVersion: string;
  private readonly onDidWrite: WriterOptions["onDidWrite"];
  private readonly ctx: Context;
  private readonly startupCleanupPromise: Promise<void>;
  private leaseChangeDisposable: { dispose(): void } | undefined;
  private lastDivergenceCheckMs = 0;

  constructor(mcpLease: McpFileSystemLease, projectDir: string, options?: WriterOptions) {
    this.mcpLease = mcpLease;
    this.projectDir = projectDir;
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.mcpAuthCopyOverrides = options?.mcpAuthCopyOverrides;
    this.useDirectClientTools = options?.useDirectClientTools ?? false;
    this.enabledToolsByServerProvider = options?.getEnabledToolsByServer;
    this.exposeVirtualMcpAuthTool = options?.exposeVirtualMcpAuthTool ?? true;
    this.alwaysExposeVirtualMcpAuthTool = options?.alwaysExposeVirtualMcpAuthTool ?? false;
    this.snapshotProvider = options?.snapshotProvider;
    this.mcpVersion = options?.mcpVersion ?? (this.snapshotProvider ? "snapshots" : "v1");
    this.onDidWrite = options?.onDidWrite;
    this.ctx = this.getContext(options?.loggerBackend);
    this.startupCleanupPromise = this.cleanupStaleStagingDirs(this.ctx);
    this.leaseChangeDisposable = this.mcpLease.onDidChange((event) => {
      logger.info(this.ctx, "Lease change event received", { serverIdentifiers: event?.serverIdentifiers, reason: event?.reason });
      this.onLeaseChanged(this.ctx, event);
    });
    logger.info(this.ctx, "Constructor: scheduling initial write");
    this.scheduleWrite(this.ctx);
    this.ensureCursorDirGitignore();
  }

  private ensureCursorDirGitignore(): void { void ensureCursorDirGitignore(join(homedir(), ".cursor")).catch((error) => logger.warn(this.ctx, "Failed to ensure ~/.cursor/.gitignore", { error: String(error) })); }
  private async cleanupStaleStagingDirs(ctx: Context): Promise<void> { const logCtx = this.getLogContext(ctx); const mcpsPath = join(this.projectDir, MCPS_SUBDIR); try { const entries = await readdir(mcpsPath); await Promise.allSettled(entries.filter((entry) => entry.endsWith(STAGING_SUFFIX)).map((entry) => rm(join(mcpsPath, entry), { recursive: true, force: true }))); } catch (error) { if ((error as { code?: unknown } | null)?.code !== "ENOENT") logger.error(logCtx, "Error clearing stale mcps staging dirs", error); } }
  private onLeaseChanged(ctx: Context, event: McpLeaseChangeEvent | undefined): void { if (this.disposed) return; const normalizedEvent = event ?? { serverIdentifiers: undefined }; this.pendingServerEvent = this.hasPendingLeaseChangeEvent ? mergeMcpLeaseEvents(this.pendingServerEvent ?? { serverIdentifiers: undefined }, normalizedEvent) : normalizedEvent; this.hasPendingLeaseChangeEvent = true; if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer); this.debounceTimer = setTimeout(() => { this.debounceTimer = undefined; this.scheduleWrite(ctx, this.takePendingLeaseChangeEvent()); }, this.debounceMs); }
  private takePendingLeaseChangeEvent(): McpLeaseChangeEvent | undefined { if (!this.hasPendingLeaseChangeEvent) return undefined; const event = this.pendingServerEvent ?? { serverIdentifiers: undefined }; this.pendingServerEvent = undefined; this.hasPendingLeaseChangeEvent = false; return event; }
  private scheduleWrite(ctx: Context, leaseChangeEvent?: McpLeaseChangeEvent): void { const logCtx = this.getLogContext(ctx); if (this.disposed) return; const previousPromise = this.writePromise; this.writePromise = (async () => { if (previousPromise) { try { await previousPromise; } catch (error) { logger.error(logCtx, "Error waiting for previous write", error); } } if (this.disposed) return; await this.startupCleanupPromise; if (this.disposed) return; await this.fetchAndWrite(ctx, leaseChangeEvent); })(); }
  private getContext(loggerBackend?: ContextLoggerBackend): Context { return loggerBackend === undefined ? createContext() : createContext().with(loggerKey, loggerBackend); }
  private getLogContext(ctx: Context): Context { return ctx.with(loggerKey, this.ctx.get(loggerKey)); }
  private getMetricTags(labels: Readonly<Record<string, string>>): Record<string, string> { return { ...labels, mcp_version: this.mcpVersion }; }
  private getMcpAuthToolDescription(): string { return getValidCopyOverride(this.mcpAuthCopyOverrides?.authToolDescription) ?? DEFAULT_MCP_AUTH_TOOL_DESCRIPTION; }
  private shouldExposeVirtualMcpAuthToolForStatus(serverIdentifier: string, status: ServerStatus | undefined): boolean { return this.exposeVirtualMcpAuthTool && supportsInteractiveMcpAuth(serverIdentifier) && (this.alwaysExposeVirtualMcpAuthTool || status === "needsAuth"); }
  private getErrorStatusMessage(): string { return getValidCopyOverride(this.mcpAuthCopyOverrides?.errorStatusMessage) ?? DEFAULT_MCP_ERROR_STATUS_MESSAGE; }
  private getNeedsAuthStatusMessage(serverIdentifier: string): string { return interpolateMcpAuthTemplate(getValidCopyOverride(this.mcpAuthCopyOverrides?.needsAuthStatusMessageWithAuthTool) ?? DEFAULT_MCP_NEEDS_AUTH_STATUS_MESSAGE, { serverIdentifier, authToolName: MCP_AUTH_TOOL_NAME }); }
  private getNeedsAuthStatusMessageForWrite(serverIdentifier: string): string { if (!this.exposeVirtualMcpAuthTool || !supportsInteractiveMcpAuth(serverIdentifier)) return getValidCopyOverride(this.mcpAuthCopyOverrides?.needsAuthStatusMessageWithoutVirtualTool) ?? DEFAULT_MCP_NEEDS_AUTH_STATUS_MESSAGE_NO_VIRTUAL_TOOL; return this.getNeedsAuthStatusMessage(serverIdentifier); }

  private async getToolsForServers(ctx: Context, serverIdentifiers: readonly string[]): Promise<readonly WriterTool[]> { if (serverIdentifiers.length === 0) return []; const logCtx = this.getLogContext(ctx); try { if (this.mcpLease.getToolsForServers === undefined) throw new Error("scoped MCP lease tool lookup unavailable"); return await this.mcpLease.getToolsForServers(ctx, serverIdentifiers); } catch (error) { logger.warn(logCtx, `getToolsForServers() threw, falling back to filtered getTools(): ${String(error)}`); const allTools = await this.mcpLease.getTools(ctx).catch((fallbackError) => { logger.warn(logCtx, `getTools() threw during scoped-tool fallback, defaulting to []: ${String(fallbackError)}`); return []; }); const requested = new Set(serverIdentifiers); return allTools.filter((tool) => requested.has(tool.clientKey)); } }
  private async getEnabledToolsByServer(ctx: Context): Promise<Readonly<Record<string, readonly string[]>> | undefined> { if (!this.useDirectClientTools || this.enabledToolsByServerProvider === undefined) return undefined; try { return await this.enabledToolsByServerProvider(ctx); } catch (error) { logger.warn(this.getLogContext(ctx), `getEnabledToolsByServer() threw, falling back to raw direct client tool lists: ${String(error)}`); return undefined; } }
  private async fetchClientDataForServer(ctx: Context, clientKey: string, client: McpFileSystemClient, options?: { fetchInstructions?: boolean }): Promise<ClientData> { const logCtx = this.getLogContext(ctx); const state = await withTimeout(client.getState(ctx), { kind: "error" }).then((value) => { if (value.kind === "error" && !("message" in value)) logger.warn(ctx, `getState() timed out for "${clientKey}", defaulting to error`); return value; }); const reachable = state.kind === "ready" || state.kind === "requires_authentication"; const [clientTools, resources, prompts, instructions] = await Promise.all([reachable && this.useDirectClientTools ? withTimeout(client.getTools(ctx), []).then((tools) => { if (tools.length === 0) logger.info(logCtx, `Direct client getTools() returned 0 tools for "${clientKey}" (state=${state.kind})`); return tools; }) : Promise.resolve([] as readonly WriterTool[]), reachable ? withTimeout(client.listResources(ctx), { resources: [] }) : Promise.resolve({ resources: [] as readonly WriterResource[] }), reachable ? withTimeout(client.listPrompts(ctx), []) : Promise.resolve([] as readonly WriterPrompt[]), reachable && options?.fetchInstructions && client.getInstructions !== undefined ? withTimeout(client.getInstructions(ctx), undefined) : Promise.resolve(undefined)]); return { clientKey, serverName: client.serverName, plugin: client.plugin, marketplace: client.marketplace, pluginId: client.pluginId, marketplaceId: client.marketplaceId, clientTools: clientTools.map((tool) => ({ ...tool, clientKey, providerIdentifier: client.serverName, plugin: client.plugin, marketplace: client.marketplace, pluginId: client.pluginId, marketplaceId: client.marketplaceId, toolName: tool.name })), resources: resources.resources.map((resource) => ({ ...resource, serverIdentifier: clientKey, serverName: client.serverName })), prompts: prompts.map((prompt) => ({ ...prompt, serverIdentifier: clientKey, serverName: client.serverName })), instructions, status: clientStateToServerStatus(state) }; }

  private buildServerDataMap(ctx: Context, tools: readonly WriterTool[], clientData: readonly ClientData[], enabledToolsByServer: Readonly<Record<string, readonly string[]>> | undefined, instructions: readonly WriterInstruction[]): Map<string, WriterServer> { const clientToolsByKey = new Map(clientData.map((data) => [data.clientKey, data.clientTools])); const serverDataMap = new Map<string, WriterServer>(); for (const data of clientData) { const sanitizedId = sanitizeServerName(data.clientKey); serverDataMap.set(data.clientKey, { serverIdentifier: data.clientKey, serverName: data.serverName, plugin: data.plugin, marketplace: data.marketplace, pluginId: data.pluginId, marketplaceId: data.marketplaceId, sanitizedId, folderPath: join(this.projectDir, MCPS_SUBDIR, sanitizedId), tools: [], resources: data.resources, prompts: data.prompts, instructions: data.instructions, status: data.status }); } for (const tool of tools) { let serverData = serverDataMap.get(tool.clientKey); if (serverData === undefined) { const sanitizedId = sanitizeServerName(tool.clientKey); serverData = { serverIdentifier: tool.clientKey, serverName: tool.providerIdentifier, plugin: tool.plugin, marketplace: tool.marketplace, pluginId: tool.pluginId, marketplaceId: tool.marketplaceId, sanitizedId, folderPath: join(this.projectDir, MCPS_SUBDIR, sanitizedId), tools: [], resources: [], prompts: [], instructions: undefined, status: undefined }; serverDataMap.set(tool.clientKey, serverData!); } serverData!.tools.push(tool); } for (const [key, serverData] of serverDataMap) { if (serverData.tools.length === 0) { const fallbackTools = clientToolsByKey.get(key); if (fallbackTools !== undefined && fallbackTools.length > 0) { const enabledToolNames = enabledToolsByServer?.[key]; const filtered = enabledToolNames !== undefined ? fallbackTools.filter((tool) => enabledToolNames.includes(tool.toolName)) : fallbackTools; if (enabledToolNames !== undefined && filtered.length === 0) { logger.info(ctx, `Skipping direct client tool fallback for "${key}": settings report 0 enabled tools`); continue; } logger.info(ctx, `Using direct client tool fallback for "${key}": lease had 0 tools, client has ${fallbackTools.length}, writing ${filtered.length}`); serverData.tools = [...filtered]; } } } for (const instruction of instructions) { const instructionIdentifier = instruction.serverIdentifier?.trim(); let serverData = instructionIdentifier === undefined ? undefined : [...serverDataMap.values()].find((server) => server.serverIdentifier === instructionIdentifier); if (serverData === undefined) { const instructionServerName = instruction.serverName?.trim(); serverData = instructionServerName === undefined ? undefined : [...serverDataMap.values()].find((server) => server.serverName === instructionServerName); } if (serverData !== undefined && instruction.instructions) serverData.instructions = instruction.instructions; } if (this.exposeVirtualMcpAuthTool) { for (const server of serverDataMap.values()) { if (!this.shouldExposeVirtualMcpAuthToolForStatus(server.serverIdentifier, server.status)) continue; if (!server.tools.some((tool) => tool.toolName === MCP_AUTH_TOOL_NAME)) server.tools.push(createVirtualMcpAuthToolDefinition({ serverIdentifier: server.serverIdentifier, serverName: server.serverName, plugin: server.plugin, marketplace: server.marketplace, pluginId: server.pluginId, marketplaceId: server.marketplaceId, authToolDescription: this.getMcpAuthToolDescription() })); } } return serverDataMap; }
  private buildServersToWrite(ctx: Context, serverDataMap: Map<string, WriterServer>): WriterServer[] { const serversToWrite: WriterServer[] = []; const seen = new Set<string>(); for (const server of serverDataMap.values()) { const hasContent = server.tools.length > 0 || server.resources.length > 0 || server.prompts.length > 0 || Boolean(server.instructions); const shouldWriteEmpty = server.status === "error" || server.status === "needsAuth" || server.status === "initializing"; if (!hasContent && !shouldWriteEmpty) { logger.info(ctx, `Server "${server.serverIdentifier}" excluded from write: tools=${server.tools.length}, resources=${server.resources.length}, prompts=${server.prompts.length}, hasInstructions=${Boolean(server.instructions)}, status=${server.status}`); continue; } if (seen.has(server.sanitizedId)) { logger.warn(ctx, `Skipping server "${server.serverIdentifier}" — sanitizedId "${server.sanitizedId}" collides with another server`); continue; } seen.add(server.sanitizedId); serversToWrite.push(server); } return serversToWrite; }
  private mergeScopedRefreshWithCachedServerData(cached: WriterServer, refreshed: WriterServer): WriterServer { const tools = [...refreshed.tools]; if (this.shouldExposeVirtualMcpAuthToolForStatus(cached.serverIdentifier, cached.status) && !tools.some((tool) => tool.toolName === MCP_AUTH_TOOL_NAME)) { const cachedAuthTool = cached.tools.find((tool) => tool.toolName === MCP_AUTH_TOOL_NAME); if (cachedAuthTool !== undefined) tools.push(cachedAuthTool); } return { ...cached, ...refreshed, tools, resources: cached.resources, prompts: cached.prompts, instructions: cached.instructions, status: cached.status, plugin: refreshed.plugin ?? cached.plugin, marketplace: refreshed.marketplace ?? cached.marketplace, pluginId: refreshed.pluginId ?? cached.pluginId, marketplaceId: refreshed.marketplaceId ?? cached.marketplaceId }; }

  private async refreshServersFromLease(ctx: Context, leaseChangeEvent: McpLeaseChangeEvent): Promise<void> { const logCtx = this.getLogContext(ctx); const ids = [...new Set(leaseChangeEvent.serverIdentifiers ?? [])]; logger.info(logCtx, `fetchAndWrite: refreshing ${ids.length} targeted servers`, { serverIdentifiers: ids }); const tools = await this.getToolsForServers(ctx, ids); const instructions = await this.mcpLease.getInstructions(ctx).catch((error) => { logger.warn(logCtx, `getInstructions() threw during scoped refresh, defaulting to []: ${String(error)}`); return []; }); const lookups = await Promise.all(ids.map(async (serverIdentifier): Promise<ClientLookup> => { try { if (this.mcpLease.getClient === undefined) return { serverIdentifier, kind: "missing" }; const client = await this.mcpLease.getClient(ctx, serverIdentifier); return client === undefined ? { serverIdentifier, kind: "missing" } : { serverIdentifier, kind: "client", client }; } catch (error) { logger.warn(logCtx, `getClient("${serverIdentifier}") threw, preserving cached data: ${String(error)}`); return { serverIdentifier, kind: "error", error }; } })); const missing = lookups.filter((lookup): lookup is MissingLookup => lookup.kind === "missing").map((lookup) => lookup.serverIdentifier); let confirmedMissing = new Set<string>(); if (missing.length > 0) { const allClients = await this.mcpLease.getClients(ctx).catch((error) => { logger.warn(logCtx, `getClients() threw while confirming targeted server removal, preserving cached data: ${String(error)}`); return undefined; }); if (allClients !== undefined) confirmedMissing = new Set(missing.filter((id) => allClients[id] === undefined)); } const [clientData, enabledTools] = await Promise.all([Promise.all(lookups.filter((lookup): lookup is ClientLookupWithClient => lookup.kind === "client").map(({ serverIdentifier, client }) => this.fetchClientDataForServer(ctx, serverIdentifier, client, { fetchInstructions: true }))), this.getEnabledToolsByServer(ctx)]); const next = new Map((this.cachedServerData ?? []).map((server) => [server.serverIdentifier, server])); const refreshed = this.buildServerDataMap(ctx, tools, clientData, enabledTools, instructions); const targeted = new Set(ids); const transient = new Set(lookups.filter((lookup) => lookup.kind === "error" || lookup.kind === "missing" && !confirmedMissing.has(lookup.serverIdentifier)).map((lookup) => lookup.serverIdentifier)); for (const id of ids) { const cached = next.get(id); const replacement = refreshed.get(id); if (replacement !== undefined) { next.set(id, transient.has(id) && cached !== undefined ? this.mergeScopedRefreshWithCachedServerData(cached, replacement) : replacement); continue; } if (confirmedMissing.has(id)) next.delete(id); else logger.warn(logCtx, `refreshServersFromLease: preserving cached data for "${id}" because targeted refresh returned no replacement`); } const leaseSanitizedIdMap = new Map([...next.values()].map((server) => [server.sanitizedId, server.serverIdentifier])); for (const [id] of this.cachedFingerprints) if (!targeted.has(id) && !next.has(id)) leaseSanitizedIdMap.set(sanitizeServerName(id), id); const servers = this.buildServersToWrite(ctx, next); await this.writeServerData(ctx, servers, leaseSanitizedIdMap); this.cachedServerData = servers; this.fireOnDidWrite(servers); }

  private async fetchAndWrite(ctx: Context, leaseChangeEvent?: McpLeaseChangeEvent): Promise<void> { using span = createSpan(ctx.withName("McpFileSystemWriter.fetchAndWrite")); const logCtx = this.getLogContext(ctx); try { if (this.cachedServerData !== undefined && leaseChangeEvent !== undefined && !isFullMcpLeaseInvalidation(leaseChangeEvent)) { const ids = [...new Set(leaseChangeEvent.serverIdentifiers ?? [])]; if (ids.length > 0) { await this.refreshServersFromLease(ctx, leaseChangeEvent); return; } } const [tools, instructions, clients, enabledTools] = await Promise.all([this.mcpLease.getTools(ctx).catch((error) => { logger.warn(logCtx, `getTools() threw, defaulting to []: ${String(error)}`); return []; }), this.mcpLease.getInstructions(ctx).catch(() => []), this.mcpLease.getClients(ctx).catch((error) => { logger.warn(logCtx, `getClients() threw, defaulting to {}: ${String(error)}`); return {}; }), this.getEnabledToolsByServer(ctx)]); const clientData = await Promise.all(Object.entries(clients).map(([clientKey, client]) => this.fetchClientDataForServer(ctx, clientKey, client))); const serverDataMap = this.buildServerDataMap(ctx, tools, clientData, enabledTools, instructions); const servers = this.buildServersToWrite(ctx, serverDataMap); const leaseSanitizedIdMap = new Map([...serverDataMap.values()].map((server) => [server.sanitizedId, server.serverIdentifier])); await this.writeServerData(ctx, servers, leaseSanitizedIdMap); this.cachedServerData = servers; this.fireOnDidWrite(servers); } catch (error) { logger.error(logCtx, "Error fetching/writing MCP state", error); } }
  private fireOnDidWrite(servers: readonly WriterServer[]): void { if (this.onDidWrite === undefined) return; try { this.onDidWrite(servers.map((server) => ({ serverIdentifier: server.serverIdentifier, folderPath: server.folderPath, tools: server.tools.map((tool) => ({ toolName: tool.toolName, definitionPath: join(server.folderPath, MCP_TOOLS_SUBDIR, `${sanitizeFileName(tool.toolName)}.json`) })) }))); } catch {} }

  private async writeServerData(ctx: Context, servers: readonly WriterServer[], leaseSanitizedIdMap: ReadonlyMap<string, string>): Promise<void> { using span = createSpan(ctx.withName("McpFileSystemWriter.writeServerData")); const logCtx = this.getLogContext(ctx); const mcpsPath = join(this.projectDir, MCPS_SUBDIR); await mkdir(mcpsPath, { recursive: true }); const newFingerprints = new Map<string, string>(); for (const server of servers) { try { newFingerprints.set(server.serverIdentifier, serverFingerprint(server)); } catch (error) { logger.error(logCtx, "Error computing server fingerprint, will force write", error, { serverIdentifier: server.serverIdentifier }); newFingerprints.set(server.serverIdentifier, `__error_${Date.now()}_${Math.random()}`); } } const toWrite = servers.filter((server) => this.cachedFingerprints.get(server.serverIdentifier) !== newFingerprints.get(server.serverIdentifier)); for (const server of servers) if (!toWrite.includes(server)) { try { await stat(join(mcpsPath, server.sanitizedId)); } catch { toWrite.push(server); } } const toRemove = new Set<string>(); for (const [id] of this.cachedFingerprints) if (!newFingerprints.has(id)) { const old = this.cachedServerData?.find((server) => server.serverIdentifier === id); const sanitizedId = old?.sanitizedId ?? sanitizeServerName(id); if (!leaseSanitizedIdMap.has(sanitizedId)) toRemove.add(sanitizedId); else newFingerprints.set(id, this.cachedFingerprints.get(id)!); } if (this.cachedServerData === undefined) { try { const entries = await readdir(mcpsPath); const liveEntries = new Set(entries.filter((entry) => !entry.endsWith(STAGING_SUFFIX) && !entry.endsWith(PREV_SUFFIX))); for (const entry of entries) { if (entry.endsWith(STAGING_SUFFIX)) await rm(join(mcpsPath, entry), { recursive: true, force: true }); else if (entry.endsWith(PREV_SUFFIX)) { const liveName = entry.slice(0, -PREV_SUFFIX.length); if (!liveEntries.has(liveName)) { try { await rename(join(mcpsPath, entry), join(mcpsPath, liveName)); liveEntries.add(liveName); } catch { await rm(join(mcpsPath, entry), { recursive: true, force: true }).catch(() => {}); } } else await rm(join(mcpsPath, entry), { recursive: true, force: true }); } } for (const liveEntry of liveEntries) { if (!leaseSanitizedIdMap.has(liveEntry)) toRemove.add(liveEntry); else { const serverIdentifier = leaseSanitizedIdMap.get(liveEntry); if (serverIdentifier !== undefined && !newFingerprints.has(serverIdentifier)) newFingerprints.set(serverIdentifier, `__preserved_${liveEntry}`); } } } catch (error) { logger.error(logCtx, "Error clearing mcps directory", error); } } const toRemoveIds = [...toRemove]; const writeResults = await Promise.allSettled(toWrite.map((server) => this.writeServerAtomic(ctx, server, mcpsPath))); for (let index = 0; index < toWrite.length; index += 1) if (writeResults[index]?.status === "rejected") { const server = toWrite[index]!; const old = this.cachedFingerprints.get(server.serverIdentifier); if (old === undefined) newFingerprints.delete(server.serverIdentifier); else newFingerprints.set(server.serverIdentifier, old); logger.error(ctx, "Error writing server directory", rejectionReason(writeResults[index]!), { serverIdentifier: server.serverIdentifier, sanitizedId: server.sanitizedId }, { includeStructuredLogs: true }); } const removalResults = await Promise.allSettled(toRemoveIds.map((id) => rm(join(mcpsPath, id), { recursive: true, force: true }))); for (let index = 0; index < removalResults.length; index += 1) if (removalResults[index]?.status === "rejected") logger.error(ctx, "Error removing server directory", rejectionReason(removalResults[index]!), { sanitizedId: toRemoveIds[index] }, { includeStructuredLogs: true }); this.cachedFingerprints.clear(); for (const [key, value] of newFingerprints) this.cachedFingerprints.set(key, value); }

  private async writeServerAtomic(ctx: Context, server: WriterServer, mcpsPath: string): Promise<void> { using span = createSpan(ctx.withName("McpFileSystemWriter.writeServerAtomic")); const stagingName = `${server.sanitizedId}${STAGING_SUFFIX}`; const prevName = `${server.sanitizedId}${PREV_SUFFIX}`; const stagingDir = join(mcpsPath, stagingName); const prevDir = join(mcpsPath, prevName); const liveDir = join(mcpsPath, server.sanitizedId); await rm(stagingDir, { recursive: true, force: true }); try { await rename(prevDir, liveDir); } catch { await rm(prevDir, { recursive: true, force: true }); } await this.writeServerDirectory(ctx, server, { basePath: mcpsPath, dirName: stagingName }); try { try { await rename(liveDir, prevDir); } catch {} await rename(stagingDir, liveDir); } catch (error) { logger.error(ctx, "Per-server swap failed", error, { serverIdentifier: server.serverIdentifier, sanitizedId: server.sanitizedId }, { includeStructuredLogs: true }); try { await rename(prevDir, liveDir); } catch {} await rm(stagingDir, { recursive: true, force: true }); throw error; } await rm(prevDir, { recursive: true, force: true }).catch(() => {}); }
  private async writeServerDirectory(ctx: Context, server: WriterServer, options: { basePath: string; dirName?: string }): Promise<void> { using span = createSpan(ctx.withName("McpFileSystemWriter.writeServerDirectory")); const serverDir = join(options.basePath, options.dirName ?? server.sanitizedId); await mkdir(serverDir, { recursive: true }); if (server.tools.length > 0) { const toolsDir = join(serverDir, MCP_TOOLS_SUBDIR); await mkdir(toolsDir, { recursive: true }); for (const tool of server.tools) await writeFile(join(toolsDir, `${sanitizeFileName(tool.toolName)}.json`), JSON.stringify(buildMcpToolFileContent(tool), null, 2)); } if (server.resources.length > 0) { const resourcesDir = join(serverDir, MCP_RESOURCES_SUBDIR); await mkdir(resourcesDir, { recursive: true }); for (const resource of server.resources) await writeFile(join(resourcesDir, `${sanitizeFileName(resource.name || resource.uri.replace(/[^a-zA-Z0-9_-]/g, "_"))}.json`), JSON.stringify({ uri: resource.uri, name: resource.name, description: resource.description, mimeType: resource.mimeType }, null, 2)); } if (server.prompts.length > 0) { const promptsDir = join(serverDir, MCP_PROMPTS_SUBDIR); await mkdir(promptsDir, { recursive: true }); for (const prompt of server.prompts) await writeFile(join(promptsDir, `${sanitizeFileName(prompt.name)}.json`), JSON.stringify({ name: prompt.name, description: prompt.description, arguments: prompt.arguments }, null, 2)); } if (server.instructions && server.instructions.trim().length > 0) await writeFile(join(serverDir, INSTRUCTIONS_FILENAME), server.instructions.trim()); if (server.status === "error" || server.status === "needsAuth") await writeFile(join(serverDir, STATUS_FILENAME), server.status === "error" ? this.getErrorStatusMessage() : this.getNeedsAuthStatusMessageForWrite(server.serverIdentifier)); await writeFile(join(serverDir, SERVER_METADATA_FILENAME), JSON.stringify({ serverIdentifier: server.serverIdentifier, serverName: server.serverName }, null, 2)); }

  async getMcpFileSystemOptions(ctx: Context, options?: { timeoutMs?: number }): Promise<McpFileSystemOptions | undefined> { if (this.disposed) return undefined; using span = createSpan(ctx.withName("McpFileSystemWriter.getMcpFileSystemOptions")); const writeTimedOut = await this.ensureWritesSettled(ctx, options?.timeoutMs); if (this.snapshotProvider && !writeTimedOut) return this.buildOptionsFromSnapshots(ctx); const servers = this.cachedServerData ?? []; const mcpDescriptors = servers.map((server) => new McpDescriptor({ serverIdentifier: server.serverIdentifier, serverName: server.serverName, ...(server.plugin === undefined ? {} : { plugin: server.plugin }), ...(server.marketplace === undefined ? {} : { marketplace: server.marketplace }), ...(server.pluginId === undefined ? {} : { pluginDbId: server.pluginId }), ...(server.marketplaceId === undefined ? {} : { marketplaceId: server.marketplaceId }), folderPath: server.folderPath, ...(server.instructions === undefined ? {} : { serverUseInstructions: server.instructions }), tools: server.tools.map((tool) => new McpToolDescriptor({ toolName: tool.toolName, definitionPath: join(server.folderPath, MCP_TOOLS_SUBDIR, `${sanitizeFileName(tool.toolName)}.json`), ...toolAnnotationsJsonField(tool.annotations) })) })); this.checkDescriptorsVsFilesystem(ctx, mcpDescriptors, "workbench_lease"); return new McpFileSystemOptions({ enabled: true, workspaceProjectDir: this.projectDir, mcpDescriptors }); }
  private async ensureWritesSettled(ctx: Context, timeoutMs?: number): Promise<boolean> { const logCtx = this.getLogContext(ctx); const hadPendingDebounce = this.debounceTimer !== undefined; if (this.debounceTimer !== undefined) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; this.scheduleWrite(ctx, this.takePendingLeaseChangeEvent()); } if (hadPendingDebounce) logger.info(logCtx, "getMcpFileSystemOptions force-fired pending debounce"); if (this.writePromise === undefined) return false; if (timeoutMs !== undefined) { let timedOut = false; let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([this.writePromise, new Promise<void>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); })]); } catch (error) { logger.error(logCtx, "Error waiting for pending write to complete", error); } finally { if (timer !== undefined) clearTimeout(timer); } if (timedOut) logger.warn(logCtx, `getMcpFileSystemOptions timed out after ${timeoutMs}ms waiting for write; returning stale cache`); return timedOut; } try { await this.writePromise; } catch (error) { logger.error(logCtx, "Error waiting for pending write to complete", error); } return false; }
  private async buildOptionsFromSnapshots(ctx: Context): Promise<McpFileSystemOptions> { using span = createSpan(ctx.withName("McpFileSystemWriter.buildOptionsFromSnapshots")); if (this.snapshotProvider === undefined) throw new Error("snapshot provider unavailable"); const logCtx = this.getLogContext(ctx); const startMs = Date.now(); const snapshots = await this.snapshotProvider.getAllSnapshots(ctx); const mcpDir = join(this.projectDir, MCPS_SUBDIR); const mcpDescriptors = snapshots.filter((snapshot) => snapshot.tools.length > 0 || snapshot.resources.length > 0 || snapshot.prompts.length > 0 || snapshot.instructions !== undefined || this.shouldExposeVirtualMcpAuthToolForStatus(snapshot.serverIdentifier, snapshot.status) || snapshot.status === "needsAuth" || snapshot.status === "error").map((snapshot) => { const folderPath = join(mcpDir, sanitizeServerName(snapshot.serverIdentifier)); const tools = snapshot.tools.map((tool) => new McpToolDescriptor({ toolName: tool.name, definitionPath: join(folderPath, MCP_TOOLS_SUBDIR, `${sanitizeFileName(tool.name)}.json`), ...toolAnnotationsJsonField(tool.annotations) })); if (this.shouldExposeVirtualMcpAuthToolForStatus(snapshot.serverIdentifier, snapshot.status) && !snapshot.tools.some((tool) => tool.name === MCP_AUTH_TOOL_NAME)) tools.push(new McpToolDescriptor({ toolName: MCP_AUTH_TOOL_NAME, definitionPath: join(folderPath, MCP_TOOLS_SUBDIR, `${sanitizeFileName(MCP_AUTH_TOOL_NAME)}.json`) })); return new McpDescriptor({ serverIdentifier: snapshot.serverIdentifier, serverName: snapshot.serverName, ...(snapshot.plugin === undefined ? {} : { plugin: snapshot.plugin }), ...(snapshot.marketplace === undefined ? {} : { marketplace: snapshot.marketplace }), ...(snapshot.pluginId === undefined ? {} : { pluginDbId: snapshot.pluginId }), ...(snapshot.marketplaceId === undefined ? {} : { marketplaceId: snapshot.marketplaceId }), folderPath, ...(snapshot.instructions === undefined ? {} : { serverUseInstructions: snapshot.instructions }), tools }); }); const totalToolCount = mcpDescriptors.reduce((sum, descriptor) => sum + descriptor.tools.length, 0); logger.info(logCtx, `buildOptionsFromSnapshots completed in ${Date.now() - startMs}ms: ${snapshots.length} snapshots, ${mcpDescriptors.length} descriptors, ${totalToolCount} tools`); this.checkDescriptorsVsFilesystem(ctx, mcpDescriptors, "snapshot"); return new McpFileSystemOptions({ enabled: true, workspaceProjectDir: this.projectDir, mcpDescriptors }); }
  async waitForPendingWrites(): Promise<void> { if (this.debounceTimer !== undefined) await new Promise<void>((resolve) => { const checkTimer = (): void => { if (this.debounceTimer === undefined) resolve(); else setTimeout(checkTimer, 10); }; checkTimer(); }); if (this.writePromise !== undefined) { try { await this.writePromise; } catch {} } }
  getCachedServerData(): readonly WriterServer[] | undefined { return this.cachedServerData; }
  checkDescriptorsVsFilesystem(ctx: Context, descriptors: readonly McpDescriptor[], source: string): void { const logCtx = this.getLogContext(ctx); const now = Date.now(); if (now - this.lastDivergenceCheckMs < McpFileSystemWriter.DIVERGENCE_CHECK_COOLDOWN_MS) return; this.lastDivergenceCheckMs = now; void this._checkDescriptorsVsFilesystemAsync(ctx, descriptors, source).catch((error) => logger.warn(logCtx, "Divergence check failed", error)); }
  private async _checkDescriptorsVsFilesystemAsync(ctx: Context, descriptors: readonly McpDescriptor[], source: string): Promise<void> { const logCtx = this.getLogContext(ctx); const mcpsPath = join(this.projectDir, MCPS_SUBDIR); const expectedServerIds = new Set<string>(); const expectedToolCounts = new Map<string, number>(); for (const descriptor of descriptors) { const sanitizedId = sanitizeServerName(descriptor.serverIdentifier); expectedServerIds.add(sanitizedId); expectedToolCounts.set(sanitizedId, descriptor.tools.length); } let actualDirs: string[] = []; try { actualDirs = (await readdir(mcpsPath)).filter((entry) => !entry.endsWith(STAGING_SUFFIX) && !entry.endsWith(PREV_SUFFIX)); } catch (error) { if ((error as { code?: unknown } | null)?.code !== "ENOENT") throw error; } const actualServerIds = new Set(actualDirs); let synced = true; let serversMissing = 0; let serversStale = 0; let toolMismatches = 0; const serversBucket = configuredServersBucket(expectedServerIds.size); for (const expected of expectedServerIds) if (!actualServerIds.has(expected)) { synced = false; serversMissing += 1; mcpFilesystemDivergence.increment(ctx, 1, this.getMetricTags({ divergence_type: "server_missing", mcp_source: source, configured_servers: serversBucket })); } for (const actual of actualServerIds) if (!expectedServerIds.has(actual)) { synced = false; serversStale += 1; mcpFilesystemDivergence.increment(ctx, 1, this.getMetricTags({ divergence_type: "server_stale", mcp_source: source, configured_servers: serversBucket })); } for (const serverId of expectedServerIds) { if (!actualServerIds.has(serverId)) continue; let actualCount = 0; try { actualCount = (await readdir(join(mcpsPath, serverId, MCP_TOOLS_SUBDIR)).then((files) => files.filter((file) => file.endsWith(".json")).length)); } catch {} if (actualCount !== (expectedToolCounts.get(serverId) ?? 0)) { synced = false; toolMismatches += 1; mcpFilesystemDivergence.increment(ctx, 1, this.getMetricTags({ divergence_type: "tool_count_mismatch", mcp_source: source, configured_servers: serversBucket })); } } mcpFilesystemSyncCheck.increment(ctx, 1, this.getMetricTags({ synced: String(synced), mcp_source: source, configured_servers: serversBucket })); mcpFilesystemSyncExpectedServers.gauge(ctx, expectedServerIds.size, this.getMetricTags({ mcp_source: source })); mcpFilesystemSyncActualServers.gauge(ctx, actualServerIds.size, this.getMetricTags({ mcp_source: source })); mcpFilesystemSyncServersMissing.gauge(ctx, serversMissing, this.getMetricTags({ mcp_source: source })); mcpFilesystemSyncToolMismatches.gauge(ctx, toolMismatches, this.getMetricTags({ mcp_source: source })); logger.info(logCtx, "MCP filesystem sync check", { mcpFileSystemMeta: { synced, expectedServers: expectedServerIds.size, actualServers: actualServerIds.size, serversMissing, serversStale, toolMismatches, source, configuredServers: expectedServerIds.size, configuredServersBucket: serversBucket } }, { includeStructuredLogs: true }); if (!synced) logger.warn(logCtx, "MCP filesystem divergence summary", { mcpFileSystemMeta: { synced, expectedServers: expectedServerIds.size, actualServers: actualServerIds.size, serversMissing, serversStale, toolMismatches, source, configuredServers: expectedServerIds.size, configuredServersBucket: serversBucket } }, { includeStructuredLogs: true }); }
  dispose(): void { if (this.disposed) return; this.disposed = true; if (this.debounceTimer !== undefined) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; } this.leaseChangeDisposable?.dispose(); this.leaseChangeDisposable = undefined; this.cachedServerData = undefined; this.cachedFingerprints.clear(); }
}

interface ClientData { readonly clientKey: string; readonly serverName: string; readonly plugin?: string | undefined; readonly marketplace?: string | undefined; readonly pluginId?: string | undefined; readonly marketplaceId?: string | undefined; readonly clientTools: WriterTool[]; readonly resources: WriterResource[]; readonly prompts: WriterPrompt[]; readonly instructions?: string | undefined; readonly status: ServerStatus }
type MissingLookup = { readonly serverIdentifier: string; readonly kind: "missing" };
type ClientLookupWithClient = { readonly serverIdentifier: string; readonly kind: "client"; readonly client: McpFileSystemClient };
type ClientLookup = MissingLookup | ClientLookupWithClient | { readonly serverIdentifier: string; readonly kind: "error"; readonly error: unknown };
