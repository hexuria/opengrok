// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed selected-context leaf. The parent processSelectedContext
// function remains absent.
export function getSkillIdFromPath(fullPath: string): string {
  const normalizedPath = fullPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const withoutSkillSuffix = normalizedPath.replace(/\/SKILL\.md$/i, "");
  const pathParts = withoutSkillSuffix.split("/").filter(Boolean);
  return pathParts[pathParts.length - 1] ?? "Skill";
}
