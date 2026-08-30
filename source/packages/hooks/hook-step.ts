export const HookStep = {
  beforeShellExecution: "beforeShellExecution", beforeMCPExecution: "beforeMCPExecution", afterShellExecution: "afterShellExecution", afterMCPExecution: "afterMCPExecution",
  beforeReadFile: "beforeReadFile", afterFileEdit: "afterFileEdit", beforeTabFileRead: "beforeTabFileRead", afterTabFileEdit: "afterTabFileEdit",
  stop: "stop", beforeSubmitPrompt: "beforeSubmitPrompt", afterAgentResponse: "afterAgentResponse", afterAgentThought: "afterAgentThought",
  sessionStart: "sessionStart", sessionEnd: "sessionEnd", preCompact: "preCompact", subagentStart: "subagentStart", subagentStop: "subagentStop",
  preToolUse: "preToolUse", postToolUse: "postToolUse", postToolUseFailure: "postToolUseFailure", workspaceOpen: "workspaceOpen",
} as const;
export type HookStepValue = typeof HookStep[keyof typeof HookStep];
