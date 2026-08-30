import type { SimulatedMsgReason } from "../proto/generated/agent/v1/agent_pb.js";
import type { SelectedContext } from "../proto/generated/agent/v1/selected_context_pb.js";
import { synthesizeDiffTabGitActionPrompt } from "./diff-tab-git-action-prompt.js";
import { synthesizeMultitaskActionPrompt } from "./multitask-action-prompt.js";
import { getTaskToolName, type TaskToolModelInfo } from "./tools/task-tool-name.js";

export interface BuildSimulatedMessagePromptUserContentArgs {
  readonly selectedContext: SelectedContext;
  readonly simulatedMsgReason: SimulatedMsgReason;
  readonly modelInfo?: TaskToolModelInfo | undefined;
  readonly environmentParamForSubagent?: boolean | undefined;
  readonly babysitV2Prompt?: boolean | undefined;
  readonly enablePrCreationForgeGuidance?: boolean | undefined;
}

export interface SimulatedMessagePromptUserContentText {
  readonly type: "text";
  readonly text: string;
}

export function buildSimulatedMessagePromptUserContent({
  selectedContext,
  simulatedMsgReason,
  modelInfo,
  environmentParamForSubagent,
  babysitV2Prompt,
  enablePrCreationForgeGuidance,
}: BuildSimulatedMessagePromptUserContentArgs): SimulatedMessagePromptUserContentText[] {
  const prompts = [
    synthesizeDiffTabGitActionPrompt({
      selectedContext,
      simulatedMsgReason,
      environmentParamForSubagent: environmentParamForSubagent === true,
      babysitV2Prompt: babysitV2Prompt === true,
      enablePrCreationForgeGuidance: enablePrCreationForgeGuidance === true,
    }),
    synthesizeMultitaskActionPrompt(simulatedMsgReason, {
      taskToolName: modelInfo !== undefined ? getTaskToolName(modelInfo) : undefined,
    } as unknown as Parameters<typeof synthesizeMultitaskActionPrompt>[1]),
  ].filter(prompt => prompt !== undefined);
  return prompts.map(prompt => ({ type: "text", text: prompt }));
}
