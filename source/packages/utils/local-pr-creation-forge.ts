export const LOCAL_PR_CREATION_FORGE_RULE_PATH = "cursor://internal/local-pr-creation-forge";
export const LOCAL_PR_CREATION_FORGE_GUIDANCE_HEADER = "Preferred pull request host:";
export const LEGACY_LOCAL_PR_CREATION_FORGE_GUIDANCE_HEADER = "Pull request forge (Creation Provider):";
export const FORGE_CLI_GLOSSARY = [
  "Cursor can open new pull requests on either:",
  "- GitHub, with the `gh` CLI (`gh pr create`)",
  "- Cursor Origin (Cursor's own pull-request host — not the git remote named `origin`), with the `origin` CLI (`origin pr create`)",
  "Prefer `gh` or `origin` over `gt`. If you use `gt`, you MUST pass `--github` or `--origin` for the intended host.",
].join("\n");

export function shouldRerenderUserInfoForLocalPrCreationForge(args: { forgeRuleContent?: string; userInfoContent: string }): boolean {
  if (args.forgeRuleContent === undefined || args.forgeRuleContent.length === 0) return [LOCAL_PR_CREATION_FORGE_GUIDANCE_HEADER, LEGACY_LOCAL_PR_CREATION_FORGE_GUIDANCE_HEADER].some((header) => args.userInfoContent.includes(`<user_rule>${header}`));
  return !args.userInfoContent.includes(`<user_rule>${args.forgeRuleContent}</user_rule>`);
}
