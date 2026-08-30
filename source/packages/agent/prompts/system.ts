import { isAutomationsPlatformCommunicationToolName } from "../automations/platform-communication-tools.js";

interface ExtractedToolInfo {
  readonly hasAnyEditTools: boolean;
  readonly allTools: Record<string, unknown>;
  readonly automationsCommunicationToolNames: string[];
  readonly availableSubagentModelsDescription: unknown;
  readonly availableSubagentTypesDescription: unknown;
}

export function extractToolInfo(toolSetHandle: {
  getAllTools(): readonly Record<string, any>[];
  getStaticTools(): readonly Record<string, any>[];
  getDescriptionProps(): { allTools: Record<string, unknown> };
  hasTool(identifier: string): boolean;
}): ExtractedToolInfo {
  const availableTools = toolSetHandle.getAllTools();
  const promptVisibleTools = toolSetHandle.getStaticTools();
  const descriptionProps = toolSetHandle.getDescriptionProps();
  const automationsCommunicationToolNames: string[] = [];
  let availableSubagentModelsDescription: unknown;
  let availableSubagentTypesDescription: unknown;
  for (const tool of availableTools) {
    if (tool.toolIdentifier === "PLATFORM_ACTION" && isAutomationsPlatformCommunicationToolName(tool.name)) {
      automationsCommunicationToolNames.push(tool.name);
    }
    if (tool.toolIdentifier === "TASK" && "descriptionTokenPartsGenerator" in tool) {
      const tokenParts = tool.descriptionTokenPartsGenerator?.(descriptionProps, { promptVisible: promptVisibleTools.includes(tool) });
      availableSubagentModelsDescription = tokenParts?.availableSubagentModelsDescriptionText;
      availableSubagentTypesDescription = tokenParts?.availableSubagentTypesDescriptionText;
    }
  }
  return {
    hasAnyEditTools: toolSetHandle.hasTool("WRITE") || toolSetHandle.hasTool("STR_REPLACE") || toolSetHandle.hasTool("APPLY_PATCH"),
    allTools: descriptionProps.allTools,
    automationsCommunicationToolNames,
    availableSubagentModelsDescription,
    availableSubagentTypesDescription,
  };
}
