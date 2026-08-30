import type { SandAgentModelSelection } from "./sand-agent-model.js";

export const SAND_DEFAULT_MODEL_ID = "grok-4.5";

export const SAND_DEFAULT_MODEL_SELECTION: SandAgentModelSelection = {
  modelId: SAND_DEFAULT_MODEL_ID,
  maxMode: true,
  parameters: [
    { id: "effort", value: "high" },
    { id: "fast", value: "true" },
  ],
};
