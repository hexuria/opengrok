import { isCodexPromptVersion } from "./common.js";

export interface TaskToolModelInfo {
  readonly isComposer1?: boolean | undefined;
  readonly isComposer15?: boolean | undefined;
  readonly promptVersion: string;
}

export function getTaskToolName(parentModelInfo: TaskToolModelInfo): string {
  const isComposer = parentModelInfo.isComposer1 || parentModelInfo.isComposer15;
  if (isComposer) return "mcp_task";
  if (isCodexPromptVersion(parentModelInfo.promptVersion)) return "Subagent";
  return "Task";
}
