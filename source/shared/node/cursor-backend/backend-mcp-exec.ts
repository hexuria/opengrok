import { Struct, type JsonValue } from "@bufbuild/protobuf";

export const LIST_TOOLS_TIMEOUT_MS = 60_000;
export const CONTROL_RPC_TIMEOUT_MS = 30_000;
export const MCP_SDK_REQUEST_TIMEOUT_MS = 60_000;
export const EXECUTE_TOOL_DIAL_DISCOVER_CALL_TIMEOUT_MS = 3 * MCP_SDK_REQUEST_TIMEOUT_MS;

export class SandBackendMcpExecError extends Error {}
export interface BackendToolWire { readonly name: string; readonly providerIdentifier: string; readonly toolName: string; readonly description: string; readonly inputSchema?: { toJson(): unknown } }
export interface NamedBackendTool { readonly name: string; readonly providerIdentifier: string; readonly toolName: string; readonly clientKey: string; readonly description?: string; readonly inputSchema?: unknown }
export interface McpExecResult { readonly result: { readonly case: string; readonly value: unknown } }
export interface DashboardMcpExecClient {
  listSandMcpTools(request: { serverIdentifiers: string[] }, options: { timeoutMs: number }): Promise<{ servers: readonly { serverIdentifier: string; status: unknown; tools: readonly BackendToolWire[]; accountLabel?: string; rowServerIdentifier?: string }[] }>;
  executeSandMcpTool(request: { serverIdentifier: string; toolName: string; args: unknown; toolCallId: string; agentId: string }, options: { timeoutMs: number }): Promise<{ result?: McpExecResult }>;
  checkHttpMcpStatus(request: { serverIds: string[]; oauthRedirectUri: string; forceReauth: boolean; accountKey: string }, options: { timeoutMs: number }): Promise<{ statuses: readonly { id: string; isAvailable: boolean; requiresAuth: boolean; hasValidToken: boolean; authUrl: string; error: string }[] }>;
  completeMcpOAuth(request: { stateId: string; authorizationCode: string }, options: { timeoutMs: number }): Promise<unknown>;
  validateMcpOAuthTokens(request: { targets: readonly { serverUrl: string; accountKey: string }[] }, options: { timeoutMs: number }): Promise<{ results: readonly { serverUrl: string; accountKey?: string; hasValidToken: boolean }[] }>;
  deleteMcpOAuthToken(request: { serverUrl: string; accountKey: string; source: "sand" }, options: { timeoutMs: number }): Promise<unknown>;
  renameMcpOAuthAccount(request: { serverId: string; accountKey: string; newAccountKey: string }, options: { timeoutMs: number }): Promise<unknown>;
  deleteMcpOAuthAccount(request: { serverId: string; accountKey: string }, options: { timeoutMs: number }): Promise<unknown>;
}
export interface DashboardMcpExecDependencies {
  readonly getAccessToken: (options?: { backendUrl?: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>;
  readonly createClient: (credentials: Pick<DashboardMcpExecDependencies, "getAccessToken" | "getMachineId">) => DashboardMcpExecClient;
  readonly reportFailure?: (leg: string, error: unknown) => void;
  readonly recordExecError?: (toolCallId: string, error: unknown) => void;
  readonly connectErrorCode?: (error: unknown) => { readonly name: string; readonly deadlineExceeded: boolean } | undefined;
}

export function backendToolToNamed(tool: BackendToolWire): NamedBackendTool {
  return { name: tool.name, providerIdentifier: tool.providerIdentifier, toolName: tool.toolName, clientKey: tool.providerIdentifier, ...(tool.description.length === 0 ? {} : { description: tool.description }), ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema.toJson() }) };
}
export function errorResult(message: string): McpExecResult { return { result: { case: "error", value: { error: message } } }; }
export function normalizeAccountLabel(label: string | null | undefined): string { return label != null && label.length > 0 ? label : "default"; }

export function createDashboardSandBackendMcpExec(deps: DashboardMcpExecDependencies) {
  const client = deps.createClient({ getAccessToken: deps.getAccessToken, getMachineId: deps.getMachineId });
  const errorLabel = (error: unknown) => deps.connectErrorCode?.(error)?.name ?? (error instanceof Error ? error.name.length > 0 ? error.name : "Error" : typeof error);
  return {
    async listTools(serverIdentifiers: readonly string[]) {
      try {
        const response = await client.listSandMcpTools({ serverIdentifiers: [...serverIdentifiers] }, { timeoutMs: LIST_TOOLS_TIMEOUT_MS });
        return response.servers.map((server) => ({ serverIdentifier: server.serverIdentifier, status: server.status, tools: server.tools.map(backendToolToNamed), accountLabel: normalizeAccountLabel(server.accountLabel), rowServerIdentifier: server.rowServerIdentifier != null && server.rowServerIdentifier.length > 0 ? server.rowServerIdentifier : server.serverIdentifier }));
      } catch (error) { deps.reportFailure?.("backend-list-tools", error); throw new SandBackendMcpExecError(`Backend MCP tool discovery failed: ${errorLabel(error)}`, { cause: error }); }
    },
    async executeTool(args: { serverIdentifier: string; toolName: string; args: unknown; toolCallId: string; agentId?: string }): Promise<McpExecResult> {
      try {
        // Connect accepts a structural request object here, but nested message fields
        // still need to be real protobuf messages. Cursor's native inference path
        // already supplies generated values; routed providers supply ordinary JSON.
        // Normalize both at this one backend boundary so the Struct serializer never
        // receives raw values and fails while looking for `value.toJson()`.
        const requestArgs = args.args instanceof Struct
          ? args.args
          : Struct.fromJson((args.args ?? {}) as JsonValue);
        const response = await client.executeSandMcpTool({ serverIdentifier: args.serverIdentifier, toolName: args.toolName, args: requestArgs, toolCallId: args.toolCallId, agentId: args.agentId ?? "" }, { timeoutMs: EXECUTE_TOOL_DIAL_DISCOVER_CALL_TIMEOUT_MS });
        return response.result ?? errorResult(`Backend MCP execution returned no result for "${args.toolName}".`);
      }
      catch (error) { deps.recordExecError?.(args.toolCallId, error); if (deps.connectErrorCode?.(error)?.deadlineExceeded === true) return errorResult(`Backend MCP execution for "${args.toolName}" timed out after ${EXECUTE_TOOL_DIAL_DISCOVER_CALL_TIMEOUT_MS / 1_000}s. The connector may still have applied it, so retry only if repeating the call is safe.`); return errorResult(`Backend MCP execution failed for "${args.toolName}": ${errorLabel(error)}`); }
    },
    async checkAuthStatus(args: { serverId: string; oauthRedirectUri: string; forceReauth?: boolean; accountKey: string }) {
      try { const response = await client.checkHttpMcpStatus({ serverIds: [args.serverId], oauthRedirectUri: args.oauthRedirectUri, forceReauth: args.forceReauth === true, accountKey: args.accountKey }, { timeoutMs: CONTROL_RPC_TIMEOUT_MS }); const status = response.statuses.find((entry) => entry.id === args.serverId); if (status == null) throw new SandBackendMcpExecError("The backend did not report OAuth status for this connector."); return { isAvailable: status.isAvailable, requiresAuth: status.requiresAuth, hasValidToken: status.hasValidToken, authUrl: status.authUrl, error: status.error }; }
      catch (error) { deps.reportFailure?.("backend-check-auth-status", error); throw new SandBackendMcpExecError(`Backend MCP OAuth status check failed: ${errorLabel(error)}`, { cause: error }); }
    },
    async completeOAuth(args: { stateId: string; code: string }) { await client.completeMcpOAuth({ stateId: args.stateId, authorizationCode: args.code }, { timeoutMs: CONTROL_RPC_TIMEOUT_MS }); },
    async validateTokens(targets: readonly { serverUrl: string; accountKey: string }[]) {
      const cleaned = targets.map((target) => ({ serverUrl: target.serverUrl.trim(), accountKey: target.accountKey })).filter((target) => target.serverUrl.length > 0); if (cleaned.length === 0) return [];
      try { const response = await client.validateMcpOAuthTokens({ targets: cleaned }, { timeoutMs: CONTROL_RPC_TIMEOUT_MS }); return response.results.map((result) => ({ serverUrl: result.serverUrl, accountKey: normalizeAccountLabel(result.accountKey), hasValidToken: result.hasValidToken })); }
      catch (error) { deps.reportFailure?.("backend-validate-tokens", error); return []; }
    },
    async logoutAccount(args: { serverUrl: string; accountKey: string }) { await client.deleteMcpOAuthToken({ serverUrl: args.serverUrl, accountKey: args.accountKey, source: "sand" }, { timeoutMs: CONTROL_RPC_TIMEOUT_MS }); },
    async renameAccount(args: { serverId: string; accountKey: string; newAccountKey: string }) { await client.renameMcpOAuthAccount(args, { timeoutMs: CONTROL_RPC_TIMEOUT_MS }); },
    async deleteAccount(args: { serverId: string; accountKey: string }) { await client.deleteMcpOAuthAccount(args, { timeoutMs: CONTROL_RPC_TIMEOUT_MS }); },
  };
}
