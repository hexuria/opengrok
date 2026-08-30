export const SAND_SUMMARIZATION_MODEL_ID = "gemini-2.5-flash";
export const SAND_COMPUTER_USE_SUBAGENT_MODEL_ID = "claude-opus-4-8";

export interface SandAgentModelParameter { readonly id: string; readonly value: string; }
export interface SandAgentModelSelection { readonly modelId: string; readonly maxMode: boolean; readonly parameters: readonly SandAgentModelParameter[]; }

export const SAND_COMPUTER_USE_MODEL_SELECTION: SandAgentModelSelection = {
  modelId: SAND_COMPUTER_USE_SUBAGENT_MODEL_ID,
  maxMode: false,
  parameters: [{ id: "thinking", value: "false" }, { id: "effort", value: "low" }]
};

export function isSandAgentModelSelection(value: unknown): value is SandAgentModelSelection {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.modelId === "string" && record.modelId.length > 0 && typeof record.maxMode === "boolean" && Array.isArray(record.parameters) && record.parameters.every((parameter) => {
    if (typeof parameter !== "object" || parameter == null || Array.isArray(parameter)) return false;
    const item = parameter as Record<string, unknown>;
    return typeof item.id === "string" && item.id.length > 0 && typeof item.value === "string";
  });
}

export function resolveComputerUseModelSelection(args: { readonly storedModel?: SandAgentModelSelection; readonly overrideModel?: SandAgentModelSelection }): SandAgentModelSelection | undefined {
  return args.overrideModel ?? args.storedModel;
}
