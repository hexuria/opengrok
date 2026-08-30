import type { SelectedGitCommit } from "../proto/generated/agent/v1/selected_context_pb.js";

const GIT_COMMIT_APPROXIMATE_MAX_TOKENS_PER_COMMIT = 8_000;
const GIT_COMMIT_CHARS_PER_TOKEN = 4;
const MAX_GIT_COMMIT_CHAR_LENGTH =
  GIT_COMMIT_APPROXIMATE_MAX_TOKENS_PER_COMMIT * GIT_COMMIT_CHARS_PER_TOKEN;
const GIT_COMMIT_DIFF_TRUNCATION_NOTICE =
  "\n\n[commit diff truncated due to size; run `git show <sha>` locally for the full output]";

interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export function buildGitCommitsUserContent(gitCommits: readonly SelectedGitCommit[]): TextContent {
  if (gitCommits.length === 0) {
    return {
      type: "text",
      text: "",
    };
  }
  const formattedCommits = gitCommits.map((commit) => formatSingleCommit(commit)).join("\n\n");
  const text = [
    "<git_commits>",
    `The following git commit${gitCommits.length > 1 ? "s have" : " has"} been manually attached:`,
    "",
    formattedCommits,
    "</git_commits>",
  ].join("\n");
  return {
    type: "text",
    text,
  };
}

function formatSingleCommit(commit: SelectedGitCommit): string {
  const sha = commit.sha ?? "unknown";
  const message = commit.message ?? "";
  const description = commit.description;
  const diff = commit.diff ?? "";
  const headerLength = `Commit: ${sha}\nMessage: ${message}\n`.length
    + (description ? `Description:\n${description}\n`.length : 0)
    + "\nDiff:\n".length;
  const availableCharsForDiff = Math.max(0, MAX_GIT_COMMIT_CHAR_LENGTH - headerLength);
  const truncatedDiff = diff.length > availableCharsForDiff
    ? diff.slice(0, availableCharsForDiff - GIT_COMMIT_DIFF_TRUNCATION_NOTICE.length)
      + GIT_COMMIT_DIFF_TRUNCATION_NOTICE
    : diff;
  const parts = [`Commit: ${sha}`, `Message: ${message}`];
  if (description?.trim()) {
    parts.push(`Description:\n${description}`);
  }
  if (truncatedDiff) {
    parts.push(`\nDiff:\n${truncatedDiff}`);
  }
  return parts.join("\n");
}
