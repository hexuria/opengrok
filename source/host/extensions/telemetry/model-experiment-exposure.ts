import { readSandModelExperimentEnvOverride } from "../../../shared/node/experiments/sand-model-experiment.js";
export const HYDRATION_WAIT_MS = 60_000;
export interface ModelExperimentExposureDeps {
  experiments: {
    hasHydratedStatsigUserId(): boolean;
    waitForHydratedStatsigUserId(timeoutMs: number): Promise<boolean>;
    getSandModelExperimentState():
      { active: boolean; arm: string } | null | undefined;
    logSandModelExperimentExposure(): boolean;
  };
  analytics: {
    canRecordEvents(): boolean;
    trackEvent(name: string, properties: { arm: string }): void;
  };
  env?: NodeJS.ProcessEnv;
}
export function createModelExperimentExposureLatch(
  deps: ModelExperimentExposureDeps,
) {
  let logged = false;
  async function flush() {
    if (logged) return;
    const envOverride = readSandModelExperimentEnvOverride(
      deps.env ?? process.env,
    );
    if (envOverride == null && !deps.experiments.hasHydratedStatsigUserId()) {
      const ready =
        await deps.experiments.waitForHydratedStatsigUserId(HYDRATION_WAIT_MS);
      if (logged || !ready) return;
    }
    const state = envOverride ?? deps.experiments.getSandModelExperimentState();
    if (state == null || !state.active) return;
    const sdkExposed = deps.experiments.logSandModelExperimentExposure();
    if (!sdkExposed) {
      if (envOverride == null || !deps.analytics.canRecordEvents()) return;
    }
    logged = true;
    if (deps.analytics.canRecordEvents())
      deps.analytics.trackEvent("sand.model_experiment.exposure", {
        arm: state.arm,
      });
  }
  return {
    note: () => {
      if (!logged) void flush();
    },
  };
}
