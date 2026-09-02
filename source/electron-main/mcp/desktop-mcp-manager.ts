import { DashboardService } from "../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import { McpError, McpResult } from "../../packages/proto/generated/agent/v1/mcp_exec_pb.js";
import { reportDesktopEdgeFailure } from "../desktop-edge-failures.js";
import { productDisplayName } from "../../shared/product-name.js";
import { createSandCursorBackendClient, getSandInferenceBackendUrl } from "../../shared/node/cursor-backend/cursor-inference.js";
import {
  createAccountMcpWriter,
  backfillUserPluginInstalls,
  fetchAccountMcpServers,
  fetchEffectiveUserPlugins,
  type AccountMcpClient,
  type AccountMcpDependencies,
} from "../../shared/node/cursor-backend/account-mcp.js";
import {
  createDashboardSandBackendMcpExec,
  type DashboardMcpExecClient,
} from "../../shared/node/cursor-backend/backend-mcp-exec.js";
import { pinMcpDiagnosticsReporter } from "../../shared/node/mcp/mcp-diagnostics.js";
import { SandMcpManager } from "../../shared/node/mcp/mcp-manager.js";
import { createMcpToolsDiscovery } from "../../shared/node/mcp/tools-discovery.js";

export interface DesktopMcpManagerFacade {
  listServers(): Promise<unknown>;
  listEffectivePlugins(): Promise<unknown>;
  getCatalog(getAccessToken: unknown): Promise<unknown>;
  resolvePluginLogo(url: string): Promise<unknown>;
  installEntry(request: unknown, getAccessToken: unknown): Promise<unknown>;
  updatePluginInstall(request: unknown, getAccessToken: unknown): Promise<unknown>;
  removeServer(serverId: string): Promise<unknown>;
  uninstallPlugin(pluginId: string): Promise<unknown>;
  authenticateServer(serverId: string, accountKey: string, trigger?: string): Promise<unknown>;
  renameAccount(args: { serverId: string; accountKey: string; newAccountKey: string }): Promise<unknown>;
  removeAccount(args: { serverId: string; accountKey: string }): Promise<unknown>;
  setServerCustomInstructions(request: unknown): Promise<unknown>;
  listServerTools(serverId: string): Promise<unknown>;
  listRoutedTools(): Promise<unknown>;
  executeRoutedTool(request: {
    readonly providerIdentifier: string;
    readonly name: string;
    readonly toolName: string;
    readonly args: unknown;
    readonly toolCallId: string;
    readonly agentId?: string;
  }): Promise<unknown>;
  toggleMcpToolDisabled(request: unknown): Promise<unknown>;
  setAuthCompletionObserver(observer: (completion: unknown) => void): void;
  dispose(): Promise<void> | void;
}

export interface DesktopMcpManagerOptions {
  readonly settingsStore: unknown;
  readonly onAccountScopeApplied: () => void;
  readonly getAccessToken: (args: { backendUrl: string }) => Promise<string>;
  readonly getMachineId: () => string | Promise<string>;
  readonly listBoxMcpServers: (serverIdentifiers: unknown) => Promise<readonly Record<string, unknown>[]>;
  readonly onConnectorAuth: (report: unknown) => void;
  readonly onMcpDiagnostic?: (failure: { readonly leg: string; readonly errorClass: string }) => void;
}

function generatedAccountClient(credentials: Pick<AccountMcpDependencies, "getAccessToken" | "getMachineId">): AccountMcpClient {
  return createSandCursorBackendClient(DashboardService, {
    getAccessToken: async (options) => await credentials.getAccessToken({ backendUrl: options?.backendUrl }),
    getMachineId: credentials.getMachineId,
  }) as unknown as AccountMcpClient;
}

function generatedBackendClient(credentials: Pick<AccountMcpDependencies, "getAccessToken" | "getMachineId">): DashboardMcpExecClient {
  return createSandCursorBackendClient(DashboardService, {
    getAccessToken: async (options) => await credentials.getAccessToken({ backendUrl: options?.backendUrl }),
    getMachineId: credentials.getMachineId,
  }) as unknown as DashboardMcpExecClient;
}

/** Artifact anchor: electron-main/main.cjs:497780, `async function createSandDesktopMcpManager(options)`. */
export async function createSandDesktopMcpManager(options: DesktopMcpManagerOptions): Promise<DesktopMcpManagerFacade> {
  pinMcpDiagnosticsReporter(options.onMcpDiagnostic ?? null);
  const accountMcpDeps: AccountMcpDependencies = {
    getAccessToken: async (request) => await options.getAccessToken({ backendUrl: request?.backendUrl ?? getSandInferenceBackendUrl() }),
    getMachineId: async () => await options.getMachineId(),
    getBackendUrl: getSandInferenceBackendUrl,
    createClient: generatedAccountClient,
  };
  const backendMcpExec = createDashboardSandBackendMcpExec({
    getAccessToken: accountMcpDeps.getAccessToken,
    getMachineId: accountMcpDeps.getMachineId,
    createClient: generatedBackendClient,
  });
  const manager = new SandMcpManager({
    settingsStore: options.settingsStore,
    onAccountScopeApplied: options.onAccountScopeApplied,
    accountServersProvider: () => fetchAccountMcpServers(accountMcpDeps),
    accountMcpWriter: createAccountMcpWriter(accountMcpDeps),
    effectivePluginsProvider: () => fetchEffectiveUserPlugins(accountMcpDeps),
    getMachineId: accountMcpDeps.getMachineId,
    backendMcpExec,
    onConnectorAuth: options.onConnectorAuth,
  });
  const discovery = createMcpToolsDiscovery({
    definitionSource: manager.definitionSourceView(),
    lastAccountDisplayConfig: () => manager.lastAccountDisplayConfigView(),
    settingsStore: () => manager.settingsStoreView(),
    backendMcpExec,
  }, {
    boxMcpExec: {
      loadServers: async () => {},
      listTools: async (serverIdentifiers: unknown) => (await options.listBoxMcpServers(serverIdentifiers)).map((server) => ({ ...server, tools: [] })),
      executeTool: async (args: { readonly name: string }) => new McpResult({
        result: {
          case: "error",
          value: new McpError({ error: `MCP tools run on ${productDisplayName()}'s computer, not the desktop app (tool "${args.name}").` }),
        },
      }),
    },
  });
  manager.setBoxRuntime(discovery);
  let routedToolsSnapshot: unknown[] = [];
  let routedToolsWarm: Promise<unknown[]> | null = null;
  const warmRoutedTools = (): Promise<unknown[]> => routedToolsWarm ??= discovery.getTools().then((tools: unknown[]) => (routedToolsSnapshot = tools), (error: unknown) => {
    routedToolsWarm = null;
    throw error;
  });
  void warmRoutedTools().catch((error: unknown) => reportDesktopEdgeFailure("mcp-manager", "routed-tools-warm", error));
  let hasKickedInstallBackfill = false;
  const kickInstallBackfillOnce = (): void => {
    if (hasKickedInstallBackfill) return;
    hasKickedInstallBackfill = true;
    void backfillUserPluginInstalls(accountMcpDeps).catch((error: unknown) => reportDesktopEdgeFailure("mcp-manager", "install-backfill", error));
  };
  return {
    listServers: () => {
      kickInstallBackfillOnce();
      return manager.listServers();
    },
    listEffectivePlugins: () => manager.listEffectivePlugins(),
    getCatalog: (getAccessToken) => manager.getCatalog(getAccessToken),
    resolvePluginLogo: (url) => manager.resolvePluginLogo(url),
    installEntry: (request, getAccessToken) => manager.installEntry(request, getAccessToken),
    updatePluginInstall: (request, getAccessToken) => manager.updatePluginInstall(request, getAccessToken),
    removeServer: (serverId) => manager.removeServer(serverId),
    uninstallPlugin: (pluginId) => manager.uninstallPlugin(pluginId),
    authenticateServer: (serverId, accountKey, trigger) => manager.authenticateServer(serverId, accountKey, null, false, trigger ?? null),
    renameAccount: (args) => manager.renameAccount(args.serverId, args.accountKey, args.newAccountKey),
    removeAccount: (args) => manager.removeAccount(args.serverId, args.accountKey),
    setServerCustomInstructions: (request) => manager.setServerCustomInstructions(request),
    listServerTools: (serverId) => manager.listServerTools(serverId),
    listRoutedTools: async () => routedToolsSnapshot.length > 0 ? routedToolsSnapshot : await warmRoutedTools(),
    executeRoutedTool: (request) => discovery.executeTool(
      undefined,
      {
        providerIdentifier: request.providerIdentifier,
        name: request.name,
        toolName: request.toolName,
        args: request.args,
        toolCallId: request.toolCallId,
      },
      request.agentId == null ? undefined : { agentId: request.agentId },
    ),
    toggleMcpToolDisabled: (request) => manager.toggleMcpToolDisabled(request),
    setAuthCompletionObserver: (observer) => manager.setAuthCompletionObserver(observer),
    dispose: () => manager.dispose(),
  };
}
