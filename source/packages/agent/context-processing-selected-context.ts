interface SelectedContextRule {
  readonly fullPath?: string;
  readonly content?: string;
  readonly plugin?: unknown;
  readonly marketplace?: unknown;
  readonly pluginId?: unknown;
  readonly marketplaceId?: unknown;
}

interface SelectedContextCursorRule {
  readonly rule?: SelectedContextRule;
}

interface SelectedContextSkill {
  readonly fullPath?: string;
  readonly content?: string;
  readonly plugin?: unknown;
  readonly marketplace?: unknown;
  readonly pluginId?: unknown;
  readonly marketplaceId?: unknown;
}

export interface SelectedContextSkillInput {
  readonly cursorRules?: readonly SelectedContextCursorRule[];
  readonly selectedSkills?: readonly SelectedContextSkill[];
}

// Extracted from the selected-context prompt branch of
// ../packages/agent/dist/context-processing.js as an uncomposed leaf.
// The parent processSelectedContext function remains absent.
export function resolveSelectedContextSkillSections(selectedContext: SelectedContextSkillInput): {
  selectedSkills: SelectedContextSkill[];
  regularRules: SelectedContextRule[];
} {
  const validRules = (selectedContext.cursorRules ?? [])
    .map((cursorRule) => cursorRule.rule)
    .filter((rule): rule is SelectedContextRule => rule !== undefined && rule.content !== undefined && rule.content.trim().length > 0);
  const hasNewSkillsField = (selectedContext.selectedSkills?.length ?? 0) > 0;
  const selectedSkills = hasNewSkillsField
    ? (selectedContext.selectedSkills ?? [])
      .filter((skill) => skill.content !== undefined && skill.content.trim().length > 0)
      .map((skill) => ({
        fullPath: skill.fullPath ?? "",
        content: skill.content!,
        plugin: skill.plugin,
        marketplace: skill.marketplace,
        pluginId: skill.pluginId,
        marketplaceId: skill.marketplaceId,
      }))
    : validRules
      .filter((rule) => isSelectedContextSkillFile(rule.fullPath))
      .map((rule) => ({
        fullPath: rule.fullPath ?? "",
        content: rule.content ?? "",
        plugin: rule.plugin,
        marketplace: rule.marketplace,
        pluginId: rule.pluginId,
        marketplaceId: rule.marketplaceId,
      }));
  const regularRules = hasNewSkillsField
    ? validRules
    : validRules.filter((rule) => !isSelectedContextSkillFile(rule.fullPath));
  return { selectedSkills, regularRules };
}

function isSelectedContextSkillFile(fullPath: string | undefined): boolean {
  if (!fullPath) {
    return false;
  }
  const normalizedPath = fullPath.replace(/\\/g, "/");
  return normalizedPath.endsWith("/SKILL.md") || normalizedPath === "SKILL.md";
}
