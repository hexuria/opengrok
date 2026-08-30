import type { SandAgentModelSelection } from "../../../shared/agents/sand-agent-model.js";
import { SAND_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION, type SandModelExperimentState } from "../../../shared/node/experiments/sand-model-experiment.js";

export function selectSandModelExperimentModel(state: SandModelExperimentState | undefined | null, _requestSource: string | undefined, configuredModel: SandAgentModelSelection | undefined): SandAgentModelSelection | undefined {
  if (state == null || !state.active) return undefined;
  if (state.arm === "control") return SAND_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION;
  return configuredModel ?? SAND_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION;
}

export const SAND_AUTOMATION_REQUEST_SOURCE = "automation";
export function selectSandExperimentTurnModel(inputs: { state?: SandModelExperimentState | null; requestSource?: string; readConfiguredDefaultModel(): SandAgentModelSelection | undefined; readConfiguredAutomationsModel(): SandAgentModelSelection | undefined }): SandAgentModelSelection | undefined {
  const { state, requestSource } = inputs;
  if (state == null || !state.active || state.arm === "control") return selectSandModelExperimentModel(state, requestSource, undefined);
  const configured = requestSource === SAND_AUTOMATION_REQUEST_SOURCE ? inputs.readConfiguredAutomationsModel() ?? inputs.readConfiguredDefaultModel() : inputs.readConfiguredDefaultModel();
  return selectSandModelExperimentModel(state, requestSource, configured);
}
