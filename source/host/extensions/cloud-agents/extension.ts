import { createRealPollingPolicy, realClock } from "../../../internal/scheduling.js";
import { defineHostExtension } from "../../../internal/host-extensions.js";
import { HostExtensions } from "../extension-ids.generated.js";
import { CLOUD_AGENT_POLL_INTERVAL_MS } from "./cloud-agent-poll-loop.js";
import { SandCloudAgentManager } from "./cloud-agents-service.js";

interface CloudAgentExtensionHost {
  convertCloudAgentConversationToTrace(conversation: unknown): readonly unknown[];
}

export const cloudAgentsExtension = defineHostExtension({
  id: HostExtensions.CloudAgents,
  dependencies: [HostExtensions.Auth],
  start: (context) => {
    const auth = context.deps.auth as { getAccessToken(): Promise<string>; getMachineId(): Promise<string> };
    const host = context.host as CloudAgentExtensionHost;
    const service = new SandCloudAgentManager({ getCursorAccessToken: auth.getAccessToken, getMachineId: auth.getMachineId, convertConversationMessagesToTrace: (conversation) => host.convertCloudAgentConversationToTrace(conversation), completionPolling: createRealPollingPolicy({ name: "cloud-agent-completion", intervalMs: CLOUD_AGENT_POLL_INTERVAL_MS }), clock: realClock });
    context.onStop(() => service.dispose());
    service.prefetchTeamAdminPolicy();
    return service;
  }
});
