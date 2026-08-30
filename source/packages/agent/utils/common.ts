export function getFilenameWithoutExtension(filePath: string): string {
  const lastSeparator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const filename = lastSeparator >= 0 ? filePath.substring(lastSeparator + 1) : filePath;
  if (filename.toLowerCase().endsWith(".mdc")) {
    return filename.substring(0, filename.length - 4);
  }
  return filename;
}

export function getFirstNonEmptyLine(content: string): string {
  const lines = content.split("\n");
  return lines.find((line) => line.trim().length > 0) ?? "";
}

export function getContextUsageInfo(tokenDetails: {
  maxTokens: number;
  usedTokens: number;
}): {
  contextWindowSize: number;
  contextTokens: number;
  contextUsagePercent: number;
} {
  const contextWindowSize = tokenDetails.maxTokens;
  const contextTokens = tokenDetails.usedTokens;
  const contextUsagePercent = contextWindowSize > 0
    ? (contextTokens / contextWindowSize) * 100
    : 0;
  return { contextWindowSize, contextTokens, contextUsagePercent };
}

export function getSkillSourceFromPath(fullPath: string): "builtin" | "plugin" | "claude" | "workspace" | "unknown" {
  const normalizedPath = fullPath.replace(/\\/g, "/");
  if (normalizedPath.includes("/.cursor/skills-cursor/")) {
    return "builtin";
  }
  if (
    normalizedPath.includes("/.cursor/plugins/") ||
    normalizedPath.includes("/.claude/plugins/")
  ) {
    return "plugin";
  }
  if (normalizedPath.includes("/.claude/skills/")) {
    return "claude";
  }
  if (
    normalizedPath.includes("/.cursor/skills/") ||
    normalizedPath.includes("/.agents/skills/")
  ) {
    return "workspace";
  }
  return "unknown";
}

export function isHookStepConfigured(
  configuredSteps: readonly string[] | undefined,
  step: string,
): boolean {
  if (configuredSteps === undefined) {
    return false;
  }
  return configuredSteps.includes(step);
}
