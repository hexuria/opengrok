import path from "node:path";

import type { AgentSkill } from "../../proto/generated/agent/v1/agent_skills_pb.js";
import type { CursorRule } from "../../proto/generated/agent/v1/cursor_rules_pb.js";
import type { PromptNode } from "../../prompt-jsx/jsx-runtime.js";
import { getFirstNonEmptyLine } from "../utils/common.js";
import { AgentType } from "../utils/agent-config.js";
import { filterByAgentEnvironment } from "../utils/environment-filtering.js";
import { normalizeToUnixPath } from "../../utils/path-utils.js";
import { BudgetedAgentSkillsSection } from "./agent-skills-section.js";
import { categorizeCursorRules } from "./user-info-rule-categorization.js";

interface AvailableSkillsPromptProps {
  readonly env?: { readonly workspacePaths?: readonly string[] | undefined } | undefined;
  readonly cursorRules: CursorRule[];
  readonly displayOptions?: {
    readonly agentType?: AgentType | undefined;
    readonly computerUseSubagentSurface?: boolean | undefined;
    readonly displaySkills?: boolean | undefined;
    readonly displayCursorRules?: boolean | undefined;
  } | undefined;
  readonly agentSkills?: AgentSkill[] | undefined;
  readonly featureFlags?: { readonly protectLoopSkillDescription?: boolean | undefined } | undefined;
  readonly agentTokenLimit?: number | undefined;
  readonly modelInfo?: { readonly isGpt56?: boolean | undefined } | undefined;
}

interface AvailableSkillsPromptOverrides {
  readonly skills?: CursorRule[] | undefined;
  readonly readToolName?: string | undefined;
}

const COMPUTER_USE_SKILL_PATTERN = /computer[-_ ]use|\bcua\b/i;
const SKILL_DIR_SEGMENTS = [
  [".cursor", "skills"],
  [".cursor", "skills-cursor"],
  [".agents", "skills"],
  [".claude", "skills"],
  [".codex", "skills"],
] as const;
const SEP = "/";

function normalizePath(value: string): string {
  const normalized = path.posix.normalize(normalizeToUnixPath(value));
  if (normalized === SEP) {
    return SEP;
  }
  return normalized.replace(/\/+$/, "");
}

function isPathWithinDir(pathValue: string, dir: string): boolean {
  const normalizedDir = normalizePath(dir);
  if (normalizedDir === SEP) {
    return pathValue.startsWith(SEP);
  }
  return pathValue === normalizedDir || pathValue.startsWith(`${normalizedDir}/`);
}

function getSkillScopeRoot(skillPath: string): string {
  const normalizedPath = normalizeToUnixPath(skillPath);
  const segments = path.posix.normalize(path.posix.dirname(normalizedPath)).split(SEP);
  for (let index = segments.length - 2; index >= 0; index--) {
    for (const [configDir, subDir] of SKILL_DIR_SEGMENTS) {
      if (segments[index] === configDir && segments[index + 1] === subDir) {
        const parentSegments = segments.slice(0, index);
        if (parentSegments.length === 0 || parentSegments.length === 1 && parentSegments[0] === "") {
          return SEP;
        }
        return parentSegments.join(SEP);
      }
    }
  }
  return path.posix.normalize(path.posix.dirname(normalizedPath));
}

function isFileScopedSkill(skill: AgentSkill, workspacePaths: readonly string[]): boolean {
  const globs = skill.globs ?? [];
  if (globs.length > 0) {
    return true;
  }
  if (!skill.fullPath) {
    return false;
  }
  const scopeRoot = normalizePath(getSkillScopeRoot(skill.fullPath));
  const normalizedWorkspaceRoots = workspacePaths.map(normalizePath);
  const containingWorkspaceRoot = normalizedWorkspaceRoots.find((workspaceRoot) => isPathWithinDir(scopeRoot, workspaceRoot));
  if (!containingWorkspaceRoot) {
    return false;
  }
  return scopeRoot !== containingWorkspaceRoot;
}

function isComputerUseGuidedSkill(skill: { readonly fullPath?: string | undefined; readonly description?: string | undefined }): boolean {
  return COMPUTER_USE_SKILL_PATTERN.test(`${skill.fullPath ?? ""}\n${skill.description ?? ""}`);
}

function getRuleDir(mdcPath: string): string {
  const normalizedPath = normalizeToUnixPath(mdcPath);
  const literalRuleDir = normalizeToUnixPath(path.posix.dirname(normalizedPath));
  const segments = literalRuleDir.split(SEP);
  for (let index = segments.length - 2; index >= 0; index--) {
    if (segments[index] === ".cursor" && segments[index + 1] === "rules") {
      const parentSegments = segments.slice(0, index);
      if (parentSegments.length === 0) {
        return SEP;
      }
      return parentSegments.join(SEP);
    }
  }
  return literalRuleDir;
}

function getAgentRequestableRuleDescription(rule: CursorRule, ruleDir: string): string | undefined {
  if (rule.type?.type.case === "fileGlobbed") {
    const globPattern = rule.type.type.value.globs.join(", ");
    return `${getFirstNonEmptyLine(rule.content ?? "")}, glob pattern(s) for applicable files: ${globPattern}`;
  }
  if (rule.type?.type.case === "agentFetched") {
    return rule.type.type.value.description;
  }
  if (rule.type?.type.case === "global") {
    return `${getFirstNonEmptyLine(rule.content ?? "")}, applicable for all files within ${ruleDir}`;
  }
  return undefined;
}

function toLegacySkillCatalogItems(skills: readonly CursorRule[]) {
  return skills.map((rule) => {
    const ruleDir = getRuleDir(rule.fullPath);
    return {
      fullPath: rule.fullPath,
      description: getAgentRequestableRuleDescription(rule, ruleDir),
    };
  });
}

export function buildAvailableSkillsPromptSection(
  props: AvailableSkillsPromptProps,
  overrides?: AvailableSkillsPromptOverrides,
): {
  readonly section?: PromptNode;
  readonly skillCount: number;
  readonly renderedEstimatedTokens?: number;
  readonly uncappedEstimatedTokens?: number;
  readonly omittedSkillCount?: number;
  readonly strategy?: "under_budget" | "shortened_descriptions" | "dropped_descriptions" | "omitted_skills";
} {
  const workspacePaths = props.env?.workspacePaths ?? [];
  const skills = overrides?.skills ?? categorizeCursorRules(props.cursorRules, workspacePaths, props.displayOptions?.agentType).skills;
  const computerUseSubagentSurface = props.displayOptions?.computerUseSubagentSurface === true;
  const agentSkillsFromProto = filterByAgentEnvironment(props.agentSkills ?? [], props.displayOptions?.agentType)
    .filter((skill) => !skill.disableModelInvocation && !isFileScopedSkill(skill, workspacePaths));
  const useAgentSkillsProto = (props.agentSkills?.length ?? 0) > 0;
  const filteredAgentSkillsFromProto = computerUseSubagentSurface
    ? agentSkillsFromProto.filter((skill) => isComputerUseGuidedSkill(skill))
    : agentSkillsFromProto;
  const filteredLegacySkills = computerUseSubagentSurface
    ? skills.filter((skill) => isComputerUseGuidedSkill({
      fullPath: skill.fullPath,
      description: getAgentRequestableRuleDescription(skill, getRuleDir(skill.fullPath)),
    }))
    : skills;
  const availableSkillCount = useAgentSkillsProto ? filteredAgentSkillsFromProto.length : filteredLegacySkills.length;
  const shouldRenderSection = availableSkillCount > 0 && (
    computerUseSubagentSurface || props.displayOptions?.displaySkills === true && props.displayOptions?.displayCursorRules !== false
  );
  if (!shouldRenderSection) {
    return { skillCount: 0 };
  }
  const protectLoopSkill = props.featureFlags?.protectLoopSkillDescription === true;
  const budgetedSection = useAgentSkillsProto
    ? BudgetedAgentSkillsSection({
      skillItems: filteredAgentSkillsFromProto.map((skill) => ({
        fullPath: skill.fullPath,
        description: skill.description || undefined,
      })),
      agentTokenLimit: props.agentTokenLimit,
      readToolName: overrides?.readToolName,
      isGpt56: props.modelInfo?.isGpt56 === true,
      protectLoopSkill,
    })
    : BudgetedAgentSkillsSection({
      skillItems: toLegacySkillCatalogItems(filteredLegacySkills),
      agentTokenLimit: props.agentTokenLimit,
      readToolName: overrides?.readToolName,
      isGpt56: props.modelInfo?.isGpt56 === true,
      protectLoopSkill,
    });
  return {
    section: budgetedSection.section,
    skillCount: budgetedSection.skillCount,
    renderedEstimatedTokens: budgetedSection.renderedEstimatedTokens,
    uncappedEstimatedTokens: budgetedSection.uncappedEstimatedTokens,
    omittedSkillCount: budgetedSection.omittedSkillCount,
    strategy: budgetedSection.strategy,
  };
}
