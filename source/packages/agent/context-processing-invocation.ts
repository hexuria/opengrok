export interface GithubPrInvocationContext {
  readonly title: string;
  readonly description: string;
  readonly comments: string;
  readonly ciFailures?: string;
}

// Extracted from the GitHub PR branch of
// ../packages/agent/dist/context-processing.js as an uncomposed leaf.
// The parent processSelectedContext function remains absent.
export function renderGithubPrInvocationContext(pr: GithubPrInvocationContext): string {
  return `<github_pr_context>
Here is the context of the Pull Request you are working on:
PR Title: ${pr.title}${pr.description !== "" ? `
PR Description:
${pr.description}` : ""}${pr.comments !== "" ? `
Recent PR Comments/Reviews:
${pr.comments}` : ""}${pr.ciFailures !== undefined && pr.ciFailures !== "" ? `
Possibly Relevant CI Failures:
${pr.ciFailures}` : ""}
</github_pr_context>`;
}
