type McpManagerOptions = {
  readonly settingsStore: unknown;
  readonly onAccountScopeApplied: () => void;
  readonly getAccessToken: (args: { backendUrl: string }) => Promise<string | null>;
  readonly getMachineId: () => string | Promise<string>;
  readonly listBoxMcpServers: (
    serverIdentifiers: unknown,
  ) => Promise<readonly Record<string, unknown>[]>;
  readonly onConnectorAuth: (report: unknown) => void;
  readonly onMcpDiagnostic: (failure: {
    readonly leg: string;
    readonly errorClass: string;
  }) => void;
};

type CursorAuthService = {
  readonly getValidAccessToken: (args: {
    readonly backendUrl: string;
  }) => Promise<string | null>;
};

type McpRuntimeDependencies<TManager> = {
  readonly createManager: (options: McpManagerOptions) => Promise<TManager>;
  readonly settingsStore: unknown;
  readonly pushBoxSecrets: () => Promise<unknown>;
  readonly ensureCursorAuthService: () => Promise<CursorAuthService>;
  readonly getMachineId: () => string | Promise<string>;
  readonly listBoxMcpServers: (
    serverIdentifiers: unknown,
  ) => Promise<readonly Record<string, unknown>[]>;
  readonly reportConnectorAuth: (report: unknown) => void;
  readonly reportDiagnostic: (leg: string, errorClass: string) => void;
  readonly cleanupLegacyAuth: (root: string) => Promise<unknown>;
  readonly sandRootDir: () => string;
  readonly reportFailure: (
    subsystem: string,
    leg: string,
    error: unknown,
  ) => void;
  readonly broadcast: (channel: string, completion: unknown) => void;
  readonly refreshHostMcp: (completion: unknown) => void;
};

export function createMcpRuntime<
  TManager extends {
    dispose(): Promise<void> | void;
    setAuthCompletionObserver(listener: (completion: unknown) => void): void;
  },
>(deps: McpRuntimeDependencies<TManager>) {
  let mcpManager: TManager | undefined;

  async function ensureMcpManager(): Promise<TManager> {
    if (mcpManager != null) return mcpManager;
    const manager = await deps.createManager({
      settingsStore: deps.settingsStore,
      onAccountScopeApplied: () => void deps.pushBoxSecrets(),
      getAccessToken: async ({ backendUrl }) => {
        const service = await deps.ensureCursorAuthService();
        return await service.getValidAccessToken({ backendUrl });
      },
      getMachineId: deps.getMachineId,
      listBoxMcpServers: deps.listBoxMcpServers,
      onConnectorAuth: (report) => deps.reportConnectorAuth(report),
      onMcpDiagnostic: (failure) =>
        deps.reportDiagnostic(failure.leg, failure.errorClass),
    });
    mcpManager = manager;
    void deps
      .cleanupLegacyAuth(deps.sandRootDir())
      .catch((error: unknown) =>
        deps.reportFailure("mcp-auth-cleanup", "startup-scrub", error),
      );
    manager.setAuthCompletionObserver((completion) => {
      deps.broadcast("sand:mcp-auth-event", completion);
      deps.refreshHostMcp(completion);
    });
    return manager;
  }

  async function resetMcpManager(): Promise<void> {
    const manager = mcpManager;
    mcpManager = undefined;
    await manager?.dispose();
  }

  return {
    ensureMcpManager,
    resetMcpManager,
    dispose: (): void => {
      void mcpManager?.dispose();
      mcpManager = undefined;
    },
  };
}
