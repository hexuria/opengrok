/**
 * Composer Git-rule injection gate recovered from the immutable host artifact.
 * Mac/Windows evidence: host-main.cjs:553675-553690.
 */
import { AgentType } from "../utils/agent-config.js";

interface ComposerGitRuleModelInfo {
  readonly isComposerMatterhorn?: boolean | undefined;
  readonly isRawTrainingSlug?: boolean | undefined;
  readonly promptVersion?: string | undefined;
  readonly isComposer2?: boolean | undefined;
  readonly isComposer15?: boolean | undefined;
}

export function shouldInjectComposerGitUserRules(
  modelInfo: ComposerGitRuleModelInfo | undefined,
  agentType?: AgentType | undefined,
): boolean {
  if (modelInfo === undefined) return false;
  if (modelInfo.isComposerMatterhorn === true && modelInfo.isRawTrainingSlug === true) return false;
  const isComposerWithoutShellGithubTools = modelInfo.promptVersion === "cursor-0226" ||
    modelInfo.isComposerMatterhorn === true ||
    modelInfo.isComposer2 === true ||
    modelInfo.isComposer15 === true;
  if (!isComposerWithoutShellGithubTools) return false;
  if (agentType === AgentType.BACKGROUND) return false;
  return true;
}
