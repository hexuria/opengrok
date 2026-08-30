import grayMatter from "gray-matter";
import { minimatch } from "minimatch";

const SKILL_GLOB_PATTERNS = [
  "**/.cursor/skills/**",
  "**/.cursor/skills-cursor/**",
  "**/.claude/skills/**",
  "**/.codex/skills/**",
  "**/.claude/plugins/**",
  "**/.agents/skills/**",
  "**/SKILL.md",
  "**/.cursor/plugins/cache/**/skills/**",
];

// Extracted from ../packages/agent/dist/prompts/user-info.js as an
// uncomposed owner leaf. The parent user-info prompt remains separate.
export function isSkillPath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/");
  return SKILL_GLOB_PATTERNS.some((pattern) => minimatch(normalizedPath, pattern, { dot: true }));
}

export interface RuleContent {
  readonly content?: string | undefined;
}

// Extracted from ../packages/agent/dist/prompts/user-info.js as an
// uncomposed owner leaf. The parent rule categorization remains separate.
export function hasDisableModelInvocation(rule: RuleContent): boolean {
  if (!rule.content) {
    return false;
  }
  try {
    const parsed = grayMatter(rule.content);
    return parsed.data?.["disable-model-invocation"] === true;
  } catch {
    return false;
  }
}
