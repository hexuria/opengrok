import type { JsonValue } from "@bufbuild/protobuf";
import { productDisplayName } from "../../product-name.js";
import { errorMessage } from "../../errors.js";
import {
  formatMcpCustomInstructionToolNote,
  resolveMcpCustomInstruction,
} from "../../mcp-custom-instructions.js";
import {
  createDeadlinePolicy,
  realClock,
  type DeadlinePolicy,
} from "../../../internal/scheduling.js";
import { displayRowOwnsIdentifier } from "./mcp-definition-source.js";
import { SandMcpConfigError } from "./mcp-config-error.js";
import { generatedMcpResultFactory } from "./mcp-result-factory.js";
import {
  reportMcpHostEdgeDegraded,
  reportMcpHostEdgeFailure,
} from "./mcp-diagnostics.js";
import {
  augmentMcpResultWithSavedImages,
  type McpContentItem,
  type McpResultLike,
  type McpResultFactory,
} from "./mcp-image-assets.js";
import { toJsonArgs } from "./mcp-validation.js";

export const MCP_TOOLS_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const TOOLS_DISCOVERY_DEADLINE_MS = 120_000;

export interface McpDiscoveryResultFactory extends McpResultFactory {
  error(message: string): McpResultLike;
}

type Tool = { providerIdentifier: string; name: string; toolName: string; description?: string; inputSchema?: JsonValue };
type ToolServer = {
  serverIdentifier: string;
  tools: Tool[];
  toolCount?: number;
};
type CacheResolution = { tools: Tool[]; resolvedKey: string };
type CacheEntry = {
  requestedKey: string;
  promise: Promise<CacheResolution>;
  fulfilled?: { tools: Tool[]; resolvedKey: string; atMs: number };
  staleTools?: Tool[];
};

export function applyCustomInstructionsToMcpResult<T extends McpResultLike>(
  result: T,
  serverName: string,
  rawInstructions: string,
  factory: McpResultFactory = generatedMcpResultFactory,
): T {
  const instructions = rawInstructions.trim();
  if (instructions.length === 0 || result.result.case !== "success")
    return result;
  const success = result.result.value as { content: McpContentItem[] };
  const note = factory.textItem(
    formatMcpCustomInstructionToolNote(serverName, instructions),
  );
  return factory.success(result, [note, ...success.content]);
}

export function createMcpToolsDiscovery(
  core: any,
  deps: {
    boxMcpExec?: any;
    deadline?: DeadlinePolicy;
    resultFactory?: McpDiscoveryResultFactory;
    onConnectorAuth?(event: Record<string, unknown>): void;
    onDiscoveryFailed?(event: Record<string, unknown>): void;
  } = {},
) {
  let boxMcpExecSlot = deps.boxMcpExec;
  let lastPushedBoxConfigJson: string | null = null;
  let hasEverPushedBoxConfig = false;
  let boxPushChain = Promise.resolve();
  let toolsCacheEntry: CacheEntry | null = null;
  let toolsCacheEpoch = 0;
  let toolsColdWarmScheduled = false;
  const firstCallReported = new Map<string, { ok: boolean; failed: boolean }>();
  const resultFactory = deps.resultFactory ?? generatedMcpResultFactory;
  const discoveryDeadline =
    deps.deadline ??
    createDeadlinePolicy(realClock, {
      name: "mcp-tools-discovery",
      timeoutMs: TOOLS_DISCOVERY_DEADLINE_MS,
    });

  function displayRowForIdentifier(identifier: string): any {
    return core
      .lastAccountDisplayConfig()
      ?.servers.find(
        (server: any) =>
          server.serverIdentifier != null &&
          displayRowOwnsIdentifier(
            identifier,
            server.serverIdentifier,
            server.accounts,
          ),
      );
  }

  function reportFirstCall(providerIdentifier: string, ok: boolean): void {
    if (deps.onConnectorAuth == null) return;
    const entry = firstCallReported.get(providerIdentifier) ?? {
      ok: false,
      failed: false,
    };
    if (ok ? entry.ok : entry.failed) return;
    if (ok) entry.ok = true;
    else entry.failed = true;
    firstCallReported.set(providerIdentifier, entry);
    const row = displayRowForIdentifier(providerIdentifier);
    deps.onConnectorAuth({
      phase: "first_call_ok",
      outcome: ok ? "ok" : "failed",
      serverName: row?.name,
      serverId: row?.id,
    });
  }

  function filterDisabledTools(tools: Tool[]): Tool[] {
    const disabledByServerId = core
      .settingsStore()
      .getMcpDisabledToolsByServerId();
    if (Object.keys(disabledByServerId).length === 0) return tools;
    return tools.filter((tool) => {
      const row = displayRowForIdentifier(tool.providerIdentifier);
      return (
        row == null ||
        !(disabledByServerId[row.id]?.includes(tool.toolName) ?? false)
      );
    });
  }

  function countEnabledTools(serverId: string, tools: Tool[]): number {
    const disabled = core.settingsStore().getMcpDisabledToolsByServerId()[
      serverId
    ];
    return disabled == null || disabled.length === 0
      ? tools.length
      : tools.filter((tool) => !disabled.includes(tool.toolName)).length;
  }

  const toolServerSetKey = (serverNames: string[]): string =>
    [...serverNames].sort().join("\0");

  function peekDiscoveryServerNames(): string[] | undefined {
    const httpServerNames = core.definitionSource.peekHttpServerNames();
    if (httpServerNames === undefined) return undefined;
    if (boxMcpExecSlot == null) return httpServerNames;
    return [
      ...httpServerNames,
      ...(core.definitionSource.peekStdioServerNames() ?? []),
    ];
  }

  async function ensureBoxServersPushed(): Promise<void> {
    const boxMcpExec = boxMcpExecSlot;
    if (boxMcpExec == null) return;
    const stdioConfigs = await core.definitionSource.getStdioServerConfigs();
    const configJson = JSON.stringify({ mcpServers: stdioConfigs });
    if (configJson === lastPushedBoxConfigJson) return;
    if (Object.keys(stdioConfigs).length === 0 && !hasEverPushedBoxConfig)
      return;
    const push = boxPushChain.then(async () => {
      if (configJson === lastPushedBoxConfigJson) return;
      await boxMcpExec.loadServers(configJson);
      lastPushedBoxConfigJson = configJson;
      hasEverPushedBoxConfig = true;
    });
    boxPushChain = push.catch((error) =>
      reportMcpHostEdgeFailure("box-config-push", error),
    );
    await push;
  }

  function currentToolsForKey(key: string): Tool[] | undefined {
    const entry = toolsCacheEntry;
    if (entry == null) return undefined;
    if (entry.fulfilled?.resolvedKey === key) return entry.fulfilled.tools;
    if (entry.requestedKey === key) return entry.staleTools;
    return undefined;
  }

  function toolsEntryUsable(key: string): boolean {
    const entry = toolsCacheEntry;
    if (entry == null) return false;
    if (entry.fulfilled === undefined) return entry.requestedKey === key;
    return (
      entry.fulfilled.resolvedKey === key &&
      Date.now() - entry.fulfilled.atMs < MCP_TOOLS_CACHE_TTL_MS
    );
  }

  function dropSettledCacheForEmptyServerSet(): void {
    if (toolsCacheEntry?.fulfilled !== undefined) toolsCacheEntry = null;
  }

  async function httpServerNamesForBackend(): Promise<string[]> {
    const userServers = await core.definitionSource.getUserServerConfigs();
    return Object.entries(userServers)
      .filter(([, config]: [string, any]) => "url" in config)
      .map(([name]) => name);
  }

  async function stdioServerNamesForBox(): Promise<string[]> {
    return boxMcpExecSlot == null
      ? []
      : Object.keys(await core.definitionSource.getStdioServerConfigs());
  }

  async function discoverHttpTools(
    serverIdentifiers: string[],
  ): Promise<Tool[]> {
    if (serverIdentifiers.length === 0) return [];
    const servers = await core.backendMcpExec.listTools(serverIdentifiers);
    if (servers.length === 0) {
      reportMcpHostEdgeDegraded("backend-list-tools", "none_resolved");
      return [];
    }
    return servers.flatMap((server: ToolServer) => server.tools);
  }

  async function discoverBoxTools(stdioServerNames: string[]): Promise<Tool[]> {
    const boxMcpExec = boxMcpExecSlot;
    if (boxMcpExec == null) return [];
    if (stdioServerNames.length === 0) {
      try {
        await ensureBoxServersPushed();
      } catch (error) {
        reportMcpHostEdgeFailure("box-config-reconcile", error);
      }
      return [];
    }
    await ensureBoxServersPushed();
    return (await boxMcpExec.listTools(stdioServerNames)).flatMap(
      (server: ToolServer) => server.tools,
    );
  }

  async function fetchToolsViaBackend(): Promise<CacheResolution> {
    const [httpServerNames, stdioServerNames] = await Promise.all([
      httpServerNamesForBackend(),
      stdioServerNamesForBox(),
    ]);
    const resolvedKey = toolServerSetKey([
      ...httpServerNames,
      ...stdioServerNames,
    ]);
    const [httpResult, boxResult] = await Promise.allSettled([
      discoverHttpTools(httpServerNames),
      discoverBoxTools(stdioServerNames),
    ]);
    if (httpResult.status === "rejected") throw httpResult.reason;
    if (boxResult.status === "rejected") {
      if (httpServerNames.length === 0) throw boxResult.reason;
      reportMcpHostEdgeFailure("box-list-tools", boxResult.reason);
      return { tools: httpResult.value, resolvedKey };
    }
    return { tools: [...httpResult.value, ...boxResult.value], resolvedKey };
  }

  function getToolsViaBackend(): Promise<CacheResolution> {
    return discoveryDeadline.run(() => fetchToolsViaBackend());
  }

  function startToolsResolution(
    requestedKey: string,
    carryStale: boolean,
  ): CacheEntry {
    const staleTools = carryStale
      ? currentToolsForKey(requestedKey)
      : undefined;
    const startedAtMs = Date.now();
    const entry: CacheEntry = {
      requestedKey,
      promise: getToolsViaBackend(),
      ...(staleTools === undefined ? {} : { staleTools }),
    };
    toolsCacheEntry = entry;
    void entry.promise.then(
      ({ tools, resolvedKey }) => {
        if (toolsCacheEntry === entry)
          entry.fulfilled = { tools, resolvedKey, atMs: Date.now() };
      },
      (error) => {
        if (toolsCacheEntry === entry) {
          if (entry.staleTools === undefined) toolsCacheEntry = null;
          else
            entry.fulfilled = {
              tools: entry.staleTools,
              resolvedKey: entry.requestedKey,
              atMs: 0,
            };
        }
        deps.onDiscoveryFailed?.({
          errorClass:
            error instanceof Error
              ? error.name.length > 0
                ? error.name
                : "Error"
              : typeof error,
          elapsedMs: Date.now() - startedAtMs,
          servedStale: staleTools !== undefined,
        });
      },
    );
    return entry;
  }

  async function getToolsRaw(): Promise<Tool[]> {
    const entry = toolsCacheEntry;
    const serverNames = peekDiscoveryServerNames();
    if (entry != null && entry.fulfilled === undefined) {
      if (
        serverNames !== undefined &&
        entry.staleTools !== undefined &&
        entry.requestedKey === toolServerSetKey(serverNames)
      ) {
        return entry.staleTools;
      }
      return (await entry.promise).tools;
    }
    if (entry?.fulfilled !== undefined && serverNames !== undefined) {
      const key = toolServerSetKey(serverNames);
      if (entry.fulfilled.resolvedKey === key) {
        if (Date.now() - entry.fulfilled.atMs >= MCP_TOOLS_CACHE_TTL_MS)
          startToolsResolution(key, true);
        return entry.fulfilled.tools;
      }
    }
    if (serverNames !== undefined) {
      const key = toolServerSetKey(serverNames);
      return (await startToolsResolution(key, false).promise).tools;
    }
    return (await getToolsViaBackend()).tools;
  }

  async function warmToolsCache(epoch: number): Promise<void> {
    const [httpServerNames, stdioServerNames] = await Promise.all([
      httpServerNamesForBackend(),
      stdioServerNamesForBox(),
    ]);
    if (epoch !== toolsCacheEpoch) return;
    const key = toolServerSetKey([...httpServerNames, ...stdioServerNames]);
    if (key === "") {
      dropSettledCacheForEmptyServerSet();
      return;
    }
    if (!toolsEntryUsable(key)) startToolsResolution(key, false);
  }

  function scheduleColdStartWarm(): void {
    if (toolsColdWarmScheduled) return;
    toolsColdWarmScheduled = true;
    const epoch = toolsCacheEpoch;
    void warmToolsCache(epoch).finally(() => {
      toolsColdWarmScheduled = false;
    });
  }

  async function isHttpProvider(providerIdentifier: string): Promise<boolean> {
    try {
      const echoedRow = core
        .lastAccountDisplayConfig()
        ?.servers.find((server: any) =>
          server.accounts?.some(
            (slot: any) => slot.serverIdentifier === providerIdentifier,
          ),
        );
      if (echoedRow != null) return "url" in echoedRow.config;
      return (
        (await core.definitionSource.getServerUrlForIdentifier(
          providerIdentifier,
        )) !== undefined
      );
    } catch {
      return false;
    }
  }

  async function isBoxStdioProvider(
    providerIdentifier: string,
  ): Promise<boolean> {
    try {
      return (
        providerIdentifier in
        (await core.definitionSource.getStdioServerConfigs())
      );
    } catch {
      return false;
    }
  }

  async function executeToolRaw(
    args: any,
    auditIdentity: any,
  ): Promise<McpResultLike> {
    if (await isHttpProvider(args.providerIdentifier)) {
      const result = await core.backendMcpExec.executeTool({
        serverIdentifier: args.providerIdentifier,
        toolName: args.name,
        args: toJsonArgs(args.args),
        toolCallId: args.toolCallId,
        agentId: auditIdentity?.agentId,
      });
      reportFirstCall(args.providerIdentifier, result.result.case !== "error");
      return result;
    }
    const boxMcpExec = boxMcpExecSlot;
    if (
      boxMcpExec != null &&
      (await isBoxStdioProvider(args.providerIdentifier))
    ) {
      try {
        await ensureBoxServersPushed();
      } catch (error) {
        return resultFactory.error(
          `Could not load MCP servers onto ${productDisplayName()}'s computer: ${errorMessage(error)}`,
        );
      }
      return boxMcpExec.executeTool(args);
    }
    return resultFactory.error(
      `MCP server "${args.providerIdentifier}" is not available here. HTTP/SSE servers execute on the backend and stdio servers run on Grok Bot's computer; this server is neither reachable nor supported in this context.`,
    );
  }

  return {
    getTools: async (_ctx?: unknown) =>
      filterDisabledTools(await getToolsRaw()),
    getToolsRaw,
    getToolsForTurnStart: async (_ctx?: unknown) => {
      const serverNames = peekDiscoveryServerNames();
      if (serverNames === undefined) {
        scheduleColdStartWarm();
        return [];
      }
      const key = toolServerSetKey(serverNames);
      if (key === "") {
        dropSettledCacheForEmptyServerSet();
        return [];
      }
      if (!toolsEntryUsable(key)) startToolsResolution(key, true);
      return filterDisabledTools(currentToolsForKey(key) ?? []);
    },
    async listBoxServers(
      serverIdentifiers: string[],
      options?: unknown,
    ): Promise<Array<ToolServer & { status: string; statusDetail?: string; toolCount: number }>> {
      const boxMcpExec = boxMcpExecSlot;
      if (boxMcpExec == null)
        throw new SandMcpConfigError(
          "This surface has no box MCP execution port.",
        );
      await core.definitionSource.ensureConfigLoaded();
      await ensureBoxServersPushed();
      const servers: Array<ToolServer & { status: string; statusDetail?: string; toolCount: number }> = await boxMcpExec.listTools(
        serverIdentifiers,
        options,
      );
      return servers.map((server) => {
        const row = displayRowForIdentifier(server.serverIdentifier);
        return row == null || server.tools.length === 0
          ? server
          : { ...server, toolCount: countEnabledTools(row.id, server.tools) };
      });
    },
    async resolveProviderTransport(
      providerIdentifier: string,
    ): Promise<"http" | "stdio" | "unknown"> {
      if (await isHttpProvider(providerIdentifier)) return "http";
      if (await isBoxStdioProvider(providerIdentifier)) return "stdio";
      return "unknown";
    },
    async executeTool(
      _ctx: unknown,
      args: any,
      auditIdentity: any,
    ): Promise<McpResultLike> {
      const displayServer = displayRowForIdentifier(args.providerIdentifier);
      const displayName = displayServer?.name ?? args.providerIdentifier;
      if (
        displayServer != null &&
        (core
          .settingsStore()
          .getMcpDisabledToolsByServerId()
          [displayServer.id]?.includes(args.toolName) ??
          false)
      ) {
        return resultFactory.error(
          `Tool "${args.toolName}" is disabled for "${displayName}".`,
        );
      }
      const raw = await executeToolRaw(args, auditIdentity);
      return applyCustomInstructionsToMcpResult(
        raw,
        displayName,
        resolveMcpCustomInstruction(
          displayName,
          core
            .settingsStore()
            .getRawMcpCustomInstructionByServerId(displayServer?.id ?? "") ??
            core.settingsStore().getRawMcpCustomInstruction(displayName),
        ),
        resultFactory,
      );
    },
    setBoxMcpExec(next: any): void {
      boxMcpExecSlot = next;
      lastPushedBoxConfigJson = null;
      toolsCacheEntry = null;
      firstCallReported.clear();
      toolsCacheEpoch += 1;
      void warmToolsCache(toolsCacheEpoch).catch(() => {});
    },
    invalidateToolsCache(): void {
      const epoch = ++toolsCacheEpoch;
      toolsCacheEntry = null;
      firstCallReported.clear();
      void warmToolsCache(epoch).catch(() => {});
    },
    resetPushState(): void {
      lastPushedBoxConfigJson = null;
    },
    isBoxExecWired: (): boolean => boxMcpExecSlot != null,
  };
}

export class SandMcpExecutor {
  constructor(
    private readonly discovery: any,
    private readonly persistImage?: any,
    private readonly spillLargeText?: any,
    private readonly auditIdentity?: any,
    private readonly resultFactory?: McpResultFactory,
  ) {}

  async execute(ctx: unknown, args: unknown): Promise<unknown> {
    const result = await this.discovery.executeTool(
      ctx,
      args,
      this.auditIdentity,
    );
    const spilled =
      this.spillLargeText == null
        ? result
        : await this.spillLargeText(ctx, result);
    if (this.persistImage == null) return spilled;
    return augmentMcpResultWithSavedImages(
      spilled,
      this.persistImage,
      this.resultFactory,
    );
  }
}
