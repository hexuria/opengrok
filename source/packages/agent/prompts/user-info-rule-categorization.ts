import { CursorRuleSource, type CursorRule } from "../../proto/generated/agent/v1/cursor_rules_pb.js";
import { filterByAgentEnvironment } from "../utils/environment-filtering.js";
import { isFileScopedCursorRule } from "../utils/cursor-rule-matching.js";
import { AgentType } from "../utils/agent-config.js";
import { hasDisableModelInvocation, isSkillPath } from "./user-info-rule-helpers.js";

export interface CategorizedCursorRules {
  readonly globalRules: CursorRule[];
  readonly agentRequestableRules: CursorRule[];
  readonly userRules: CursorRule[];
  readonly skills: CursorRule[];
}

// Extracted from ../packages/agent/dist/prompts/user-info.js as an
// uncomposed owner leaf. Prompt composition remains separate.
export function categorizeCursorRules(
  cursorRules: CursorRule[],
  workspacePaths: readonly string[] = [],
  agentType?: AgentType,
): CategorizedCursorRules {
  const filteredRules = filterByAgentEnvironment(cursorRules, agentType);
  const globalRules: CursorRule[] = [];
  const agentRequestableRules: CursorRule[] = [];
  const userRules: CursorRule[] = [];
  const skills: CursorRule[] = [];
  for (const rule of filteredRules) {
    const mdcPath = rule.fullPath;
    if (isSkillPath(mdcPath)) {
      if (rule.type?.type.case === "global") {
        globalRules.push(rule);
      } else if (!hasDisableModelInvocation(rule)) {
        skills.push(rule);
      }
      continue;
    }
    if (rule.source === CursorRuleSource.USER) {
      userRules.push(rule);
      continue;
    }
    if (rule.source === CursorRuleSource.TEAM) {
      globalRules.push(rule);
      continue;
    }
    if (rule.type?.type.case === "manuallyAttached") {
      continue;
    }
    if (rule.type?.type.case !== "global") {
      agentRequestableRules.push(rule);
      continue;
    }
    if (isFileScopedCursorRule(rule, workspacePaths)) {
      agentRequestableRules.push(rule);
    } else {
      globalRules.push(rule);
    }
  }
  return { globalRules, agentRequestableRules, userRules, skills };
}
