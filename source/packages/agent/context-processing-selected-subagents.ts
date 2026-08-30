import type { SelectedSubagent } from "../proto/generated/agent/v1/selected_context_pb.js";

export interface SelectedSubagentsTextContent {
  readonly type: "text";
  readonly text: string;
}

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed selected-subagent delegation prompt leaf. The parent
// processSelectedContext function remains absent.
export function renderSelectedSubagentDelegation(
  selectedSubagents: readonly SelectedSubagent[],
): SelectedSubagentsTextContent | undefined {
  if (selectedSubagents.length === 0) {
    return undefined;
  }
  const subagentNames = selectedSubagents.map(subagent => subagent.name).join(", ");
  return {
    type: "text",
    text: `<subagent_delegation_context>
The user has indicated they want you to delegate work to the following subagent(s): ${subagentNames}

To delegate, call the Task tool with the subagent_type parameter. Example:
Task(subagent_type="${selectedSubagents[0]?.name}", prompt="your detailed task description")
</subagent_delegation_context>
`,
  };
}
