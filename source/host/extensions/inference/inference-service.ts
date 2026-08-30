import { join } from "node:path";

import { resolveComputerUseModelSelection, type SandAgentModelSelection } from "../../../shared/agents/sand-agent-model.js";
import type { SandModelExperimentState } from "../../../shared/node/experiments/sand-model-experiment.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { createCursorSandInference } from "./cursor-session.js";
import type { SandInferenceProvider } from "../../../shared/inference-router.js";
import type { PromptExecutor } from "./sand-labeling.js";
import { createProviderPromptSession } from "./provider-session.js";
import { getSandRootDir } from "../../host-paths.js";
export interface HostInferenceOptions {
  auth: { getAccessToken(...args: unknown[]): Promise<string>; getMachineId(): string };
  experiments: { checkFeatureGate(name: string): boolean; getComputerUseModelOverride(): SandAgentModelSelection | undefined; getBrowserUseModelOverride(): SandAgentModelSelection | undefined; getSandModelExperimentState(): SandModelExperimentState | null | undefined; hasHydratedStatsigUserId(): boolean; getConfiguredDefaultModel(): SandAgentModelSelection | undefined; getConfiguredAutomationsModel(): SandAgentModelSelection | undefined };
  settings: { getAgentDefaultModel(): SandAgentModelSelection | undefined; getComputerUseModel(): SandAgentModelSelection | undefined; getInferenceProvider(): SandInferenceProvider; recordInferenceUsage(provider: SandInferenceProvider, usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void };
  onModelExperimentApplied(): void;
}
export function createHostInference(options: HostInferenceOptions) {
  const { auth, experiments, settings } = options;
  const routerSettings = new SandSettingsStore(join(getSandRootDir(), "settings.json"));
  const cursor = createCursorSandInference({
    getAccessToken: auth.getAccessToken,
    getMachineId: auth.getMachineId,
    isGeminiVideoDeveloperApiEnabled: () => experiments.checkFeatureGate("gemini_video_developer_api"),
    getDefaultModel: () => settings.getAgentDefaultModel(),
    getComputerUseModel: () => { const storedModel=settings.getComputerUseModel(),overrideModel=experiments.getComputerUseModelOverride();return resolveComputerUseModelSelection({...(storedModel==null?{}:{storedModel}),...(overrideModel==null?{}:{overrideModel})}); },
    getBrowserUseModel: () => experiments.getBrowserUseModelOverride(),
    getModelExperimentState: () => { const state = experiments.getSandModelExperimentState(); if (experiments.hasHydratedStatsigUserId()) options.onModelExperimentApplied(); return state; },
    getConfiguredDefaultModel: () => experiments.getConfiguredDefaultModel(),
    getConfiguredAutomationsModel: () => experiments.getConfiguredAutomationsModel()
  });
  const wrapExecutor = (executor: PromptExecutor, provider: SandInferenceProvider): PromptExecutor => ({
    appendMessages(messages) { executor.appendMessages(messages); return this; },
    getState: () => executor.getState(),
    getMessages: () => executor.getMessages(),
    clearMessages: () => executor.clearMessages(),
    stream(...args: readonly unknown[]) {
      const result = executor.stream(...args) as Record<string, any>;
      const extendedUsage = result?.extendedUsage as PromiseLike<Record<string, unknown>> | undefined;
      if (extendedUsage != null && typeof extendedUsage.then === "function") {
        void Promise.resolve(extendedUsage).then((usage: Record<string, unknown>) => {
          options.settings.recordInferenceUsage(provider, {
            ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
            ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
            ...(typeof usage.cacheReadTokens === "number" ? { cacheReadTokens: usage.cacheReadTokens } : {}),
            ...(typeof usage.cacheWriteTokens === "number" ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
          });
        }).catch(() => {});
      }
      return result;
    },
  });
  const routedSession = (session: ReturnType<typeof cursor.createSession>, provider: SandInferenceProvider) => ({
    getModelId: () => session.getModelId(),
    getExecutor: (state?: unknown) => wrapExecutor(session.getExecutor(state) as unknown as PromptExecutor, provider),
  });
  return {
    ...cursor,
    createSession(onRequestId: (requestId: string) => void, sessionOptions?: Parameters<typeof cursor.createSession>[1]) {
      const provider = routerSettings.getInferenceProvider();
      if (provider === "cursor") return routedSession(cursor.createSession(onRequestId, sessionOptions), provider);
      return createProviderPromptSession(provider) as ReturnType<typeof cursor.createSession>;
    },
    createSummarizationSession(onRequestId: (requestId: string) => void, sessionOptions?: Parameters<NonNullable<typeof cursor.createSummarizationSession>>[1]) {
      const provider = routerSettings.getInferenceProvider();
      if (provider === "cursor") return routedSession(cursor.createSession(onRequestId, { ...(sessionOptions ?? {}), isSummarizationSession: true }), provider) as ReturnType<NonNullable<typeof cursor.createSummarizationSession>>;
      return createProviderPromptSession(provider) as ReturnType<NonNullable<typeof cursor.createSummarizationSession>>;
    },
  };
}
