import { HookStep, type HookStepValue } from "./hook-step.js";
export const CLAUDE_EVENT_TO_CURSOR_STEP = {
  PreToolUse: HookStep.preToolUse, PermissionRequest: null, PostToolUse: HookStep.postToolUse, UserPromptSubmit: HookStep.beforeSubmitPrompt,
  Stop: HookStep.stop, SubagentStop: HookStep.subagentStop, SessionStart: HookStep.sessionStart, SessionEnd: HookStep.sessionEnd,
  PreCompact: HookStep.preCompact, Notification: null,
} as const;
export const CURSOR_STEP_TO_CLAUDE_EVENT = Object.fromEntries(
  Object.entries(CLAUDE_EVENT_TO_CURSOR_STEP)
    .filter((entry) => entry[1] !== null)
    .map(([event, step]) => [step as HookStepValue, event]),
);
export const CLAUDE_TOOL_TO_CURSOR_TOOL: Readonly<Record<string, string | null>> = {
  Bash: "Shell", Read: "Read", Write: "Write", Edit: "Write", Glob: null,
  Grep: "Grep", WebFetch: "WebFetch", WebSearch: "WebSearch", Task: "Task",
};
export const UNSUPPORTED_CLAUDE_TOOLS = ["Glob"] as const;
export const UNSUPPORTED_CLAUDE_EVENTS = ["Notification", "PermissionRequest"] as const;
