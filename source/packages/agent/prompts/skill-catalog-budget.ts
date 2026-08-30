import { renderContent } from "../../prompt-jsx/render.js";
import type { PromptNode } from "../../prompt-jsx/jsx-runtime.js";
import { estimateStringTokenCount } from "../utils/token-estimate.js";

// Extracted from ../packages/agent/dist/prompts/skill-catalog-budget.js.
// Metrics and the composing catalog section remain separate modules.
interface SkillCatalogItem {
  readonly fullPath: string;
  readonly description?: string | undefined;
}

interface ApplySkillCatalogBudgetInput {
  readonly skills: readonly SkillCatalogItem[];
  readonly agentTokenLimit?: number | undefined;
  readonly renderSection: (
    skills: readonly SkillCatalogItem[],
    omittedNotice?: PromptNode,
  ) => PromptNode;
  readonly renderOmittedNotice?:
    | ((directories: readonly string[], omittedCount: number) => PromptNode)
    | undefined;
  readonly protectLoopSkill?: boolean | undefined;
}

interface SkillCatalogBudgetResult {
  readonly section: PromptNode;
  readonly skillItems: readonly SkillCatalogItem[];
  readonly retainedCount: number;
  readonly omittedCount: number;
  readonly omittedDirectories: readonly string[];
  readonly renderedEstimatedTokens: number;
  readonly uncappedEstimatedTokens: number;
  readonly strategy:
    | "under_budget"
    | "shortened_descriptions"
    | "dropped_descriptions"
    | "omitted_skills";
}

interface TruncatedDescriptionsResult {
  readonly section: PromptNode;
  readonly skillItems: readonly SkillCatalogItem[];
  readonly renderedEstimatedTokens: number;
}

const INITIAL_SKILL_CATALOG_CONTEXT_FRACTION = 0.02;
const FALLBACK_AGENT_TOKEN_LIMIT = 2e5;
const TRUNCATED_DESCRIPTION_SUFFIX = "...";
const MIN_TRUNCATED_DESCRIPTION_LENGTH = 24;
const MAX_TRUNCATED_DESCRIPTION_LENGTH = 480;
const SHORT_DESCRIPTION_PATH_ONLY_THRESHOLD = 80;
const MAX_OMITTED_DIRECTORY_COUNT = 5;
const PROTECTED_SKILL_NAMES = new Set(["canvas", "env-setup"]);
const LOOP_PROTECTED_SKILL_NAMES = new Set(["loop"]);

export function applySkillCatalogBudget({
  skills,
  agentTokenLimit,
  renderSection,
  renderOmittedNotice,
  protectLoopSkill,
}: ApplySkillCatalogBudgetInput): SkillCatalogBudgetResult {
  const uncappedSection = renderSection(skills);
  const uncappedEstimatedTokens = estimateStringTokenCount(renderContent(uncappedSection));
  const isProtected = protectLoopSkill === true
    ? (skill: SkillCatalogItem) =>
      isProtectedSkill(skill) || LOOP_PROTECTED_SKILL_NAMES.has(getSkillName(skill.fullPath))
    : isProtectedSkill;
  const effectiveTokenLimit = agentTokenLimit !== undefined && agentTokenLimit > 0
    ? agentTokenLimit
    : FALLBACK_AGENT_TOKEN_LIMIT;
  const budgetTokens = Math.floor(effectiveTokenLimit * INITIAL_SKILL_CATALOG_CONTEXT_FRACTION);
  if (uncappedEstimatedTokens <= budgetTokens) {
    return {
      section: uncappedSection,
      skillItems: skills,
      retainedCount: skills.length,
      omittedCount: 0,
      omittedDirectories: [],
      renderedEstimatedTokens: uncappedEstimatedTokens,
      uncappedEstimatedTokens,
      strategy: "under_budget",
    };
  }
  const truncatedDescriptions = truncateDescriptionsToFit({
    skills,
    budgetTokens,
    renderSection,
    isProtected,
  });
  if (truncatedDescriptions !== undefined) {
    return {
      section: truncatedDescriptions.section,
      skillItems: truncatedDescriptions.skillItems,
      retainedCount: truncatedDescriptions.skillItems.length,
      omittedCount: 0,
      omittedDirectories: [],
      renderedEstimatedTokens: truncatedDescriptions.renderedEstimatedTokens,
      uncappedEstimatedTokens,
      strategy: "shortened_descriptions",
    };
  }
  const pathOnlySkills = skills.map((skill) => isProtected(skill)
    ? skill
    : { fullPath: skill.fullPath, description: undefined });
  const pathOnlySection = renderSection(pathOnlySkills);
  const pathOnlyEstimatedTokens = estimateStringTokenCount(renderContent(pathOnlySection));
  if (pathOnlyEstimatedTokens <= budgetTokens) {
    return {
      section: pathOnlySection,
      skillItems: pathOnlySkills,
      retainedCount: pathOnlySkills.length,
      omittedCount: 0,
      omittedDirectories: [],
      renderedEstimatedTokens: pathOnlyEstimatedTokens,
      uncappedEstimatedTokens,
      strategy: "dropped_descriptions",
    };
  }
  return omitSkillsToFit({
    pathOnlySkills,
    allSkills: skills,
    budgetTokens,
    uncappedEstimatedTokens,
    renderSection,
    renderOmittedNotice,
    isProtected,
  });
}

function truncateDescriptionsToFit({
  skills,
  budgetTokens,
  renderSection,
  isProtected,
}: {
  readonly skills: readonly SkillCatalogItem[];
  readonly budgetTokens: number;
  readonly renderSection: ApplySkillCatalogBudgetInput["renderSection"];
  readonly isProtected: (skill: SkillCatalogItem) => boolean;
}): TruncatedDescriptionsResult | undefined {
  const maxDescriptionLength = skills.reduce((longest, skill) => {
    if (isProtected(skill)) {
      return longest;
    }
    return Math.max(longest, skill.description?.length ?? 0);
  }, 0);
  if (maxDescriptionLength <= SHORT_DESCRIPTION_PATH_ONLY_THRESHOLD) {
    return undefined;
  }
  let bestFit: TruncatedDescriptionsResult | undefined;
  let lowerBound = MIN_TRUNCATED_DESCRIPTION_LENGTH;
  let upperBound = Math.min(maxDescriptionLength - 1, MAX_TRUNCATED_DESCRIPTION_LENGTH);
  while (lowerBound <= upperBound) {
    const midpoint = Math.floor((lowerBound + upperBound) / 2);
    const candidate = skills.map((skill) => isProtected(skill)
      ? skill
      : {
        fullPath: skill.fullPath,
        description: truncateDescription(skill.description, midpoint),
      });
    const section = renderSection(candidate);
    const renderedEstimatedTokens = estimateStringTokenCount(renderContent(section));
    if (renderedEstimatedTokens <= budgetTokens) {
      bestFit = { section, skillItems: candidate, renderedEstimatedTokens };
      lowerBound = midpoint + 1;
    } else {
      upperBound = midpoint - 1;
    }
  }
  return bestFit;
}

function omitSkillsToFit({
  pathOnlySkills,
  allSkills,
  budgetTokens,
  uncappedEstimatedTokens,
  renderSection,
  renderOmittedNotice,
  isProtected,
}: {
  readonly pathOnlySkills: readonly SkillCatalogItem[];
  readonly allSkills: readonly SkillCatalogItem[];
  readonly budgetTokens: number;
  readonly uncappedEstimatedTokens: number;
  readonly renderSection: ApplySkillCatalogBudgetInput["renderSection"];
  readonly renderOmittedNotice: ApplySkillCatalogBudgetInput["renderOmittedNotice"];
  readonly isProtected: (skill: SkillCatalogItem) => boolean;
}): SkillCatalogBudgetResult {
  const droppableIndices: number[] = [];
  for (let i = 0; i < allSkills.length; i++) {
    if (!isProtected(allSkills[i]!)) {
      droppableIndices.push(i);
    }
  }
  for (let retainedDroppableCount = droppableIndices.length; retainedDroppableCount >= 0; retainedDroppableCount--) {
    const retainedDroppable = new Set(droppableIndices.slice(0, retainedDroppableCount));
    const retainedSkills: SkillCatalogItem[] = [];
    const omittedSkills: SkillCatalogItem[] = [];
    for (let i = 0; i < allSkills.length; i++) {
      if (isProtected(allSkills[i]!) || retainedDroppable.has(i)) {
        retainedSkills.push(pathOnlySkills[i]!);
      } else {
        omittedSkills.push(allSkills[i]!);
      }
    }
    const omittedDirectories = getOmittedSkillDirectories(omittedSkills);
    const cappedDirectories = omittedDirectories.slice(0, MAX_OMITTED_DIRECTORY_COUNT);
    const omittedNotice = renderOmittedNotice !== undefined && omittedSkills.length > 0
      ? renderOmittedNotice(cappedDirectories, omittedSkills.length)
      : undefined;
    const section = renderSection(retainedSkills, omittedNotice);
    const renderedEstimatedTokens = estimateStringTokenCount(renderContent(section));
    if (renderedEstimatedTokens <= budgetTokens || retainedDroppableCount === 0) {
      return {
        section,
        skillItems: retainedSkills,
        retainedCount: retainedSkills.length,
        omittedCount: omittedSkills.length,
        omittedDirectories: cappedDirectories,
        renderedEstimatedTokens,
        uncappedEstimatedTokens,
        strategy: "omitted_skills",
      };
    }
  }
  throw new Error("omitSkillsToFit: loop ended without returning");
}

function getSkillName(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, "/").split("/");
  const last = parts[parts.length - 1] ?? "";
  if (last === "SKILL.md" && parts.length >= 2) {
    return parts[parts.length - 2] ?? "";
  }
  return last;
}

function isProtectedSkill(skill: SkillCatalogItem): boolean {
  return PROTECTED_SKILL_NAMES.has(getSkillName(skill.fullPath));
}

function truncateDescription(description: string | undefined, maxLength: number): string | undefined {
  if (description === undefined || description.length <= maxLength) {
    return description;
  }
  const contentLength = Math.max(0, maxLength - TRUNCATED_DESCRIPTION_SUFFIX.length);
  return `${description.slice(0, contentLength).trimEnd()}${TRUNCATED_DESCRIPTION_SUFFIX}`;
}

function getOmittedSkillDirectories(skills: readonly SkillCatalogItem[]): string[] {
  const directories = new Set<string>();
  for (const skill of skills) {
    directories.add(getSkillDirectoryHint(skill.fullPath));
  }
  return [...directories];
}

function getSkillDirectoryHint(fullPath: string): string {
  const normalizedPath = fullPath.replace(/\\/g, "/");
  const skillPathMarkers = [
    "/.cursor/skills/",
    "/.cursor/skills-cursor/",
    "/.agents/skills/",
    "/.claude/skills/",
    "/.codex/skills/",
    "/.claude/plugins/",
  ];
  for (const marker of skillPathMarkers) {
    const markerIndex = normalizedPath.indexOf(marker);
    if (markerIndex !== -1) {
      return normalizedPath.slice(0, markerIndex + marker.length - 1);
    }
  }
  const pluginSkillsMarker = "/.cursor/plugins/cache/";
  const pluginSkillsIndex = normalizedPath.indexOf(pluginSkillsMarker);
  if (pluginSkillsIndex !== -1) {
    const skillsIndex = normalizedPath.indexOf("/skills/", pluginSkillsIndex);
    if (skillsIndex !== -1) {
      return normalizedPath.slice(0, skillsIndex + "/skills".length);
    }
  }
  const lastSlashIndex = normalizedPath.lastIndexOf("/");
  return lastSlashIndex === -1 ? normalizedPath : normalizedPath.slice(0, lastSlashIndex);
}
