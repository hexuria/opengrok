import { defineHostExtension } from "../../../internal/host-extensions.js";
import { getSandRootDir } from "../../host-paths.js";
import { resolveMultitaskEnabled } from "../../sand-multitask.js";
import { resolveSpotlightEnabled } from "../../../shared/sand-spotlight.js";
import { SandExperimentService } from "../../../shared/node/experiments/cursor-experiments.js";
import { HostExtensions } from "../extension-ids.generated.js";

interface AuthApi { getAccessToken(options: { backendUrl: string }): Promise<string>; getMachineId(): Promise<string>; peekAccessToken(): string | null; subscribeToRenewal(listener: (event: { outcome: string; isFirstCredential: boolean }) => void): () => void; }
interface SettingsApi { subscribeToFeatureFlagOverrides(listener: (overrides: Record<string, boolean>) => void): () => void; }
export const experimentsExtension = defineHostExtension({
  id: HostExtensions.Experiments, dependencies: [HostExtensions.Auth, HostExtensions.Settings],
  start: (context) => {
    const auth = context.deps[HostExtensions.Auth] as AuthApi; const settings = context.deps[HostExtensions.Settings] as SettingsApi;
    const service = new SandExperimentService({ getAccessToken: auth.getAccessToken, getMachineId: auth.getMachineId, getCacheDir: () => getSandRootDir(), isDevBuild: process.env.SAND_PACKAGED !== "1" || process.env.SAND_HOST_DEV_ERROR_DETAIL === "1" });
    service.start(); context.onStop(() => service.dispose()); context.onStop(auth.subscribeToRenewal((event) => { if (event.outcome === "renewed" && (event.isFirstCredential || !service.hasAuthenticatedStatsigBootstrap())) service.handleAuthChange(); }));
    if (auth.peekAccessToken() !== null) service.handleAuthChange(); context.onStop(settings.subscribeToFeatureFlagOverrides((overrides) => service.replaceFeatureFlagOverrides(overrides)));
    return {
      checkFeatureGate: (name: Parameters<typeof service.checkFeatureGate>[0]) => service.checkFeatureGate(name), getFeatureGateProperty: (name: Parameters<typeof service.getFeatureGateProperty>[0]) => service.getFeatureGateProperty(name),
      checkGate: (name: Parameters<typeof service.checkGate>[0], options?: { timeoutMs?: number }) => service.checkGate(name, options), getDynamicConfig: (name: Parameters<typeof service.getDynamicConfig>[0]) => service.getDynamicConfig(name), subscribe: (listener: Parameters<typeof service.subscribe>[0]) => service.subscribe(listener),
      pinGateOnAuthenticatedBootstrap: (name: Parameters<typeof service.pinGateOnAuthenticatedBootstrap>[0], pin: (value: boolean) => void) => service.pinGateOnAuthenticatedBootstrap(name, pin), hasHydratedStatsigUserId: () => service.hasHydratedStatsigUserId(), waitForHydratedStatsigUserId: (timeoutMs?: number) => service.waitForHydratedStatsigUserId(timeoutMs),
      hasAuthenticatedStatsigBootstrap: () => service.hasAuthenticatedStatsigBootstrap(), getSandModelExperimentState: () => service.getSandModelExperimentState(), logSandModelExperimentExposure: () => service.logSandModelExperimentExposure(), getConfiguredDefaultModel: () => service.getConfiguredDefaultModel(), getConfiguredAutomationsModel: () => service.getConfiguredAutomationsModel(), getComputerUseModelOverride: () => service.getComputerUseModelOverride(), getBrowserUseModelOverride: () => service.getBrowserUseModelOverride(),
      isAgentNetworkEnabled: () => service.checkFeatureGate("sand_agent_network"), isMcpMultiAccountEnabled: () => service.checkFeatureGate("mcp_multi_account"), isSparsePluginClonesEnabled: () => service.checkFeatureGate("enable_sparse_plugin_clones"),
      isMultitaskEnabled: () => resolveMultitaskEnabled(process.env.SAND_MULTITASK, () => service.checkFeatureGate("sand_multitask")), isSendMessageDeliveryOwedEnabled: () => service.checkFeatureGate("sand_send_message_delivery_owed"), isDynamicToolsEnabled: () => service.checkFeatureGate("grok_bot_dynamic_tools"), isBrowserUseSubagentEnabled: () => service.checkFeatureGate("sand_browser_use_subagent"),
      isSpotlightEnabled: () => resolveSpotlightEnabled(process.env.SAND_SPOTLIGHT, () => service.checkFeatureGate("sand_spotlight")), isUnicodeTypingEnabled: () => service.checkFeatureGate("sand_computer_use_unicode_typing"), isUaTokenKillSwitchEnabled: () => service.checkFeatureGate("sand_browser_ua_token_kill_switch")
    };
  }
});
