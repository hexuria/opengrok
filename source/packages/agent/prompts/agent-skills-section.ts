import { Fragment, jsx, jsxs } from "../../prompt-jsx/jsx-runtime.js";
import type { PromptNode, PromptProps } from "../../prompt-jsx/jsx-runtime.js";
import { applySkillCatalogBudget } from "./skill-catalog-budget.js";

interface AgentSkillItem {
  readonly fullPath: string;
  readonly description?: string | undefined;
}

interface AgentSkillsSectionLayoutProps {
  readonly skillItems: PromptNode[];
  readonly omittedNotice?: PromptNode | undefined;
  readonly hasOmittedSkills: boolean;
  readonly hasListedSkills?: boolean | undefined;
  readonly raw?: boolean | undefined;
  readonly readToolName?: string | undefined;
  readonly isGpt56?: boolean | undefined;
}

interface BudgetedAgentSkillsSectionProps {
  readonly skillItems: readonly AgentSkillItem[];
  readonly agentTokenLimit?: number | undefined;
  readonly raw?: boolean | undefined;
  readonly readToolName?: string | undefined;
  readonly isGpt56?: boolean | undefined;
  readonly protectLoopSkill?: boolean | undefined;
}

function AgentSkillsSectionLayout({
  skillItems,
  omittedNotice,
  hasOmittedSkills,
  hasListedSkills = skillItems.length > 0,
  raw,
  readToolName,
  isGpt56,
}: AgentSkillsSectionLayoutProps): PromptNode {
  const skillsDescription = readToolName
    ? `Skills the agent can use. Use the ${readToolName} tool with the provided absolute path to fetch full contents.`
    : "Skills the agent can use. Fetch full contents from the provided absolute path.";
  if (raw) {
    return jsxs("section", {
      title: "agent_skills",
      description: skillsDescription,
      children: [skillItems, omittedNotice],
    });
  }
  return jsxs("section", {
    title: "agent_skills",
    children: [
      isGpt56
        ? jsxs(Fragment, {
          children: [
            jsxs("p", {
              children: [
                "When the user names a skill, use it faithfully as part of the current task.",
                readToolName
                  ? ` Read the skill file using the ${readToolName} tool before following its instructions.`
                  : " Read the skill file before following its instructions.",
                " ",
                "The user's instructions take precedence over skill guidance, and an invoked skill takes precedence over autonomous judgment where they do not conflict.",
              ],
            }),
            jsxs("p", {
              children: [
                "Tell the user in `commentary` when a skill causes a material action or pause. Before using a skill the user did not name, briefly explain why it is relevant and keep its use within the task's scope. Mention material effects in the final response, but do not cite skills you merely inspected.",
                " ",
                !hasListedSkills && hasOmittedSkills
                  ? "No skills are listed below, but additional skills may exist in the directories shown in the skills section if a later task specifically requires discovering more skills."
                  : hasOmittedSkills
                    ? "Use the skills listed below. If a later task specifically requires discovering more skills, additional skills may exist in the directories shown in the skills section."
                    : "Only use skills listed below.",
              ],
            }),
          ],
        })
        : jsxs("p", {
          children: [
            "When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.",
            readToolName
              ? ` To use a skill, read the skill file at the provided absolute path using the ${readToolName} tool, then follow the instructions within.`
              : " To use a skill, read the skill file at the provided absolute path, then follow the instructions within.",
            " ",
            "When a skill is relevant, read and follow it IMMEDIATELY as your first action. NEVER just announce or mention a skill without actually reading and following it.",
            " ",
            !hasListedSkills && hasOmittedSkills
              ? "No skills are listed below, but additional skills may exist in the directories shown in the skills section if a later task specifically requires discovering more skills."
              : hasOmittedSkills
                ? "Use the skills listed below. If a later task specifically requires discovering more skills, additional skills may exist in the directories shown in the skills section."
                : "Only use skills listed below.",
          ],
        }),
      jsx("br", {}),
      jsxs("section", {
        title: "available_skills",
        description: skillsDescription,
        children: [skillItems, omittedNotice],
      }),
      jsx("br", {}),
    ],
  });
}

function renderAgentSkillItems(skills: readonly AgentSkillItem[]): PromptNode[] {
  return skills.map((skill) => jsx("x", {
    tag: "agent_skill",
    fullPath: skill.fullPath,
    children: skill.description || undefined,
  }));
}

function OmittedSkillsNotice({
  directories,
  omittedCount,
}: {
  readonly directories: readonly string[];
  readonly omittedCount: number;
}): PromptNode {
  return jsx("p", {
    children: `Additional skills omitted from this initial list (${omittedCount}). Directories containing omitted skills: ${directories.join(", ")}.`,
  });
}

const AgentSkillsSectionLayoutPrompt = AgentSkillsSectionLayout as unknown as (
  props: PromptProps,
) => PromptNode;
const OmittedSkillsNoticePrompt = OmittedSkillsNotice as unknown as (
  props: PromptProps,
) => PromptNode;

export function BudgetedAgentSkillsSection({
  skillItems,
  agentTokenLimit,
  raw,
  readToolName,
  isGpt56,
  protectLoopSkill,
}: BudgetedAgentSkillsSectionProps) {
  const budgetResult = applySkillCatalogBudget({
    skills: skillItems,
    agentTokenLimit,
    protectLoopSkill,
    renderSection: (skills, omittedNotice) => jsx(AgentSkillsSectionLayoutPrompt, {
      skillItems: renderAgentSkillItems(skills),
      omittedNotice,
      hasOmittedSkills: omittedNotice !== undefined,
      raw,
      readToolName,
      isGpt56,
    }),
    renderOmittedNotice: (directories, omittedCount) => jsx(OmittedSkillsNoticePrompt, {
      directories,
      omittedCount,
    }),
  });
  return {
    section: budgetResult.section,
    skillCount: budgetResult.retainedCount,
    renderedEstimatedTokens: budgetResult.renderedEstimatedTokens,
    uncappedEstimatedTokens: budgetResult.uncappedEstimatedTokens,
    omittedSkillCount: budgetResult.omittedCount,
    strategy: budgetResult.strategy,
  };
}
