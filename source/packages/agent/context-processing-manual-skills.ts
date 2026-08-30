import grayMatter from "gray-matter";

type GrayMatterParser = (content: string) => { content: string };
const parseGrayMatter = grayMatter as GrayMatterParser;

const MAX_RULE_LENGTH = 1e5;

export interface ManuallyAttachedSkill {
  readonly fullPath: string;
  readonly content: string;
}

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed manual-skill rendering leaf. The parent processSelectedContext
// function remains absent.
export function renderManuallyAttachedSkillsSection(
  selectedSkills: readonly ManuallyAttachedSkill[],
): string | undefined {
  if (selectedSkills.length === 0) {
    return undefined;
  }
  const prefix = `<manually_attached_skills>
The user has manually attached the following skills to their message.
These skills contain specific instructions or workflows that the user wants you to follow for this request.
Only read the files if needed, the full skill content is inlined here.
`;
  const suffix = `</manually_attached_skills>`;
  const skillsText = selectedSkills.map((skill) => renderManuallyAttachedSkillEntry(skill)).join("\n\n---\n\n");
  return `${prefix}
${skillsText}
${suffix}

`;
}

function renderManuallyAttachedSkillEntry(skill: ManuallyAttachedSkill): string {
  const fullPath = skill.fullPath;
  const normalizedPath = fullPath.replace(/\\/g, "/");
  const pathParts = normalizedPath.split("/");
  const skillMdIndex = pathParts.indexOf("SKILL.md");
  const skillName = skillMdIndex > 0 ? pathParts[skillMdIndex - 1] : "Skill";
  const parsed = parseGrayMatter(skill.content);
  const content = parsed.content.trim().slice(0, MAX_RULE_LENGTH);
  return `Skill Name: ${skillName}
Path: ${fullPath}
SKILL.md content:
${content}`;
}
