import { DashboardService } from "../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import { createSandCursorBackendClient } from "../../shared/node/cursor-backend/cursor-inference.js";
import { createDashboardSandBackendMcpExec, type DashboardMcpExecClient } from "../../shared/node/cursor-backend/backend-mcp-exec.js";
import { createSandMcpOAuthLoopback } from "../../shared/node/mcp/mcp-oauth-loopback.js";

export interface ProductionMcpOAuthLoopback {
  registerPendingAuthFromUrl(args: { authorizationUrl: string; serverName?: string }): Promise<boolean>;
  dispose(): Promise<void> | void;
}

export interface ProductionMcpOAuthLoopbackPorts {
  readonly getAccessToken: (options?: { backendUrl?: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>;
  readonly log: (message: string) => void;
  readonly onConnectorAuth?: (event: Record<string, unknown>) => void;
}

function createGeneratedBackendClient(ports: Pick<ProductionMcpOAuthLoopbackPorts, "getAccessToken" | "getMachineId">): DashboardMcpExecClient {
  return createSandCursorBackendClient(DashboardService, {
    getAccessToken: ports.getAccessToken,
    getMachineId: ports.getMachineId,
  }) as unknown as DashboardMcpExecClient;
}

/** Artifact anchor: electron-main/main.cjs:497538, createDesktopMcpOAuthLoopbackFactory. */
export function createProductionMcpOAuthLoopbackFactory(ports: ProductionMcpOAuthLoopbackPorts): () => Promise<ProductionMcpOAuthLoopback> {
  return async () => {
    const backendMcpExec = createDashboardSandBackendMcpExec({
      getAccessToken: ports.getAccessToken,
      getMachineId: ports.getMachineId,
      createClient: (credentials) => createGeneratedBackendClient(credentials),
    });
    return createSandMcpOAuthLoopback({
      completeOAuth: (args) => backendMcpExec.completeOAuth(args),
      log: ports.log,
      ...(ports.onConnectorAuth == null ? {} : { onCallback: ports.onConnectorAuth }),
    });
  };
}
