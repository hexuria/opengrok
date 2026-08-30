import { AgentMode } from "../../../../proto/generated/agent/v1/agent_pb.js";
import { ToolCallRejectedError } from "../../common.js";

const MARKDOWN_SUFFIXES = [".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdx"];
const MANAGED_CANVAS_REGEX = /(?:^|\/)\.cursor\/projects\/[^/]+\/canvases\/[^/]+\.canvas\.tsx$/i;

export function isMarkdownEditPath(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  return MARKDOWN_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

export function isManagedCanvasEditPath(path: string): boolean {
  return MANAGED_CANVAS_REGEX.test(path.trim().replace(/\\/g, "/"));
}

export function isPlanModeAllowedEditPath(path: string): boolean {
  return isMarkdownEditPath(path) || isManagedCanvasEditPath(path);
}

export const PLAN_MODE_NON_MARKDOWN_EDIT_ERROR = "Cannot edit non markdown files in plan mode";

export interface PlanModeState {
  readonly mode: AgentMode;
}

export function assertPlanModeAllowsFileEdit(path: string, stateHandler: PlanModeState): void {
  if (stateHandler.mode !== AgentMode.PLAN || isPlanModeAllowedEditPath(path)) return;
  throw new ToolCallRejectedError(PLAN_MODE_NON_MARKDOWN_EDIT_ERROR);
}
