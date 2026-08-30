import type { MethodInfoUnary } from "@bufbuild/protobuf";
import { countListenerPlatforms, type ListenerPlatform } from "../../automations/listener-integrations.js";
import { DashboardService } from "../../../packages/proto/generated/aiserver/v1/dashboard_connect.js";
import {
  GetScmConnectionStatusRequest,
  type GetScmConnectionStatusResponse,
  GetSlackInstallUrlRequest,
  type GetSlackInstallUrlResponse,
  GetSlackUserSettingsRequest,
  type GetSlackUserSettingsResponse
} from "../../../packages/proto/generated/aiserver/v1/dashboard_pb.js";
import { createSandCursorBackendClient } from "../../../shared/node/cursor-backend/cursor-inference.js";
export const DASHBOARD_INTEGRATIONS_URL = "https://cursor.com/dashboard?tab=integrations";
export const LISTENER_INTEGRATIONS = [{ platform: "slack" as const }, { platform: "github" as const }];
export const CONNECTOR_MANIFESTS = [{ platform: "slack" as const }, { platform: "github" as const }];
export interface ListenerDashboardClient { getSlackUserSettings(): Promise<{ hasSlackAuth?: boolean }>; getScmConnectionStatus(): Promise<{ connected?: boolean }>; getSlackInstallUrl(): Promise<{ url: string }> }
export function createListenerIntegrationReads(deps: { readonly auth?: { getAccessToken(args: { backendUrl: string }): Promise<string>; getMachineId(): Promise<string> }; readonly dashboard?: () => ListenerDashboardClient; readonly transcript: { listAllAutomationDefinitions(): Promise<readonly { automation: { isEnabled: boolean; trigger: Parameters<typeof countListenerPlatforms>[0][number]["trigger"] } }[]>; getAgentChannels(agentId: string): Promise<readonly { platform: string; [key: string]: unknown }[]> }; readonly sourceStatuses: () => ReadonlyMap<string, { state: string; detail?: string; scopeIssues?: readonly unknown[] }>; readonly log?: (message: string) => void }) {
  const log = deps.log ?? ((message: string) => console.log(`[sand-listener-integrations] ${message}`));
  const dashboard = deps.dashboard ?? (() => {
    if (deps.auth === undefined) throw new TypeError("listener integrations require auth");
    const service = DashboardService as typeof DashboardService & {
      readonly methods: typeof DashboardService.methods & {
        readonly getSlackUserSettings: MethodInfoUnary<GetSlackUserSettingsRequest, GetSlackUserSettingsResponse>;
        readonly getScmConnectionStatus: MethodInfoUnary<GetScmConnectionStatusRequest, GetScmConnectionStatusResponse>;
        readonly getSlackInstallUrl: MethodInfoUnary<GetSlackInstallUrlRequest, GetSlackInstallUrlResponse>;
      };
    };
    const client = createSandCursorBackendClient(service, { getAccessToken: deps.auth.getAccessToken, getMachineId: deps.auth.getMachineId });
    return {
      getSlackUserSettings: () => client.getSlackUserSettings(new GetSlackUserSettingsRequest({})),
      getScmConnectionStatus: () => client.getScmConnectionStatus(new GetScmConnectionStatusRequest({})),
      getSlackInstallUrl: () => client.getSlackInstallUrl(new GetSlackInstallUrlRequest({}))
    };
  });
  const isPlatformConnected = async (platform: ListenerPlatform) => platform === "slack" ? (await dashboard().getSlackUserSettings()).hasSlackAuth === true : (await dashboard().getScmConnectionStatus()).connected === true;
  return { isPlatformConnected, async getIntegrations() { const statuses = deps.sourceStatuses(), counts = countListenerPlatforms((await deps.transcript.listAllAutomationDefinitions()).map((entry) => entry.automation)), read = (platform: ListenerPlatform) => isPlatformConnected(platform).catch((error) => { log(`${platform} connection read degraded to disconnected: ${error instanceof Error ? error.name : typeof error}`); return false; }), [slack, github] = await Promise.all([read("slack"), read("github")]), connected = { slack, github }; return { integrations: LISTENER_INTEGRATIONS.map(({ platform }) => { const status = statuses.get(platform); return { platform, isConnected: connected[platform], state: status?.state ?? "idle", ...(status?.detail == null ? {} : { detail: status.detail }), ...(status?.scopeIssues?.length ? { scopeIssues: status.scopeIssues } : {}), neededByCount: counts[platform] }; }) }; }, async getConnectUrl(platform: ListenerPlatform) { if (platform !== "slack") return DASHBOARD_INTEGRATIONS_URL; try { return (await dashboard().getSlackInstallUrl()).url || DASHBOARD_INTEGRATIONS_URL; } catch { return DASHBOARD_INTEGRATIONS_URL; } }, async getAgentChannels(agentId: string) { const known = new Set(CONNECTOR_MANIFESTS.map(({ platform }) => platform)); return { manifests: CONNECTOR_MANIFESTS, connections: (await deps.transcript.getAgentChannels(agentId)).filter((connection) => known.has(connection.platform as ListenerPlatform)) }; } };
}
