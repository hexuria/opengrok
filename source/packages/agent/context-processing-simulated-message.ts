import type { SimulatedMsgReason as SimulatedMsgReasonValue } from "../proto/generated/agent/v1/agent_pb.js";
import type { SelectedContext } from "../proto/generated/agent/v1/selected_context_pb.js";
import { synthesizeDiffTabGitActionPrompt } from "./diff-tab-git-action-prompt.js";
import { synthesizeMultitaskActionPrompt } from "./multitask-action-prompt.js";
import { getTaskToolName, type TaskToolModelInfo } from "./tools/task-tool-name.js";

export interface SimulatedMessagePromptTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface RenderSimulatedMessagePromptArgs {
  readonly selectedContext: SelectedContext;
  readonly simulatedMsgReason: SimulatedMsgReasonValue;
  readonly modelInfo?: TaskToolModelInfo | undefined;
  readonly environmentParamForSubagent?: boolean | undefined;
  readonly babysitV2Prompt?: boolean | undefined;
  readonly enablePrCreationForgeGuidance?: boolean | undefined;
}

// Extracted from ../packages/agent/dist/context-processing.js as an exact
// non-media prompt helper. The parent processSelectedContext function remains
// absent.
export function renderSimulatedMessagePromptUserContent({
  selectedContext,
  simulatedMsgReason,
  modelInfo,
  environmentParamForSubagent,
  babysitV2Prompt,
  enablePrCreationForgeGuidance,
}: RenderSimulatedMessagePromptArgs): SimulatedMessagePromptTextContent[] {
  const prompts = [
    synthesizeDiffTabGitActionPrompt({
      selectedContext,
      simulatedMsgReason,
      environmentParamForSubagent: environmentParamForSubagent === true,
      babysitV2Prompt: babysitV2Prompt === true,
      enablePrCreationForgeGuidance: enablePrCreationForgeGuidance === true,
    }),
    synthesizeMultitaskActionPrompt(
      simulatedMsgReason,
      modelInfo !== undefined ? { taskToolName: getTaskToolName(modelInfo) } : {},
    ),
  ].filter(prompt => prompt !== undefined);
  return prompts.map(prompt => ({
    type: "text",
    text: prompt,
  }));
}
