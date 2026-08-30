import type { SelectedPullRequest } from "../proto/generated/agent/v1/selected_context_pb.js";

const MAX_DESCRIPTION_LENGTH = 500;

interface TextContent {
  readonly type: "text";
  readonly text: string;
}

interface PullRequestSummaryFile {
  readonly path: string;
  readonly diffFileName?: string;
  readonly status: unknown;
  readonly diffLines: unknown;
  readonly diffSizeChars?: unknown;
  readonly diffSizeBytes?: unknown;
  readonly originalSizeChars?: unknown;
  readonly originalSizeBytes?: unknown;
}

interface PullRequestSummary {
  readonly headRef?: string;
  readonly baseRef?: string;
  readonly description?: string;
  readonly totalFiles: unknown;
  readonly totalDiffLines: unknown;
  readonly totalDiffSizeChars?: unknown;
  readonly totalDiffSizeBytes?: unknown;
  readonly files?: PullRequestSummaryFile[];
}

export function buildGitPullRequestsUserContent(
  pullRequests: readonly SelectedPullRequest[],
): TextContent {
  if (pullRequests.length === 0) {
    return {
      type: "text",
      text: "",
    };
  }
  const formattedPRs = pullRequests.map((pullRequest) => formatSinglePullRequest(pullRequest)).join("\n\n");
  const headerText = pullRequests.length === 1 ? "Attached Pull Request:" : "Attached Pull Requests:";
  const text = [
    "<attached_pull_requests>",
    headerText,
    "",
    formattedPRs,
    "</attached_pull_requests>",
  ].join("\n");
  return {
    type: "text",
    text,
  };
}

function formatSinglePullRequest(pullRequest: SelectedPullRequest): string {
  const number = pullRequest.number;
  const title = pullRequest.title ?? "";
  const url = pullRequest.url;
  const folderPath = pullRequest.folderPath;
  const summaryJson = pullRequest.summaryJson;
  const parts: string[] = [];
  parts.push(`PR #${number}${title ? `: ${title}` : ""}`);
  if (url) {
    parts.push(`- URL: ${url}`);
  }
  if (summaryJson) {
    try {
      const summary = JSON.parse(summaryJson) as PullRequestSummary;
      if (summary.headRef?.trim()) {
        parts.push(`- Branch: ${summary.headRef}${summary.baseRef?.trim() ? ` → ${summary.baseRef}` : ""}`);
      }
      if (summary.description?.trim()) {
        const description = summary.description;
        if (description.length > MAX_DESCRIPTION_LENGTH) {
          const truncated = description.slice(0, MAX_DESCRIPTION_LENGTH);
          parts.push(`- Description: ${truncated}... (truncated, full description in summary.json)`);
        } else {
          parts.push(`- Description: ${description}`);
        }
      }
      if (folderPath) {
        parts.push(`- Some additional details about the PR are available in the folder ${folderPath}`);
        parts.push("  - Contents:");
        parts.push("    - all.diff: Complete diff of all files in one file");
        parts.push("    - diffs/: Individual diff files if you need to read specific files");
        parts.push("    - summary.json: Metadata about the PR and changed files");
      }
      const totalDiffChars = summary.totalDiffSizeChars ?? summary.totalDiffSizeBytes;
      parts.push(`- Summary: ${summary.totalFiles} files, ${summary.totalDiffLines} lines, ${totalDiffChars} chars`);
      if (summary.files && summary.files.length > 0) {
        parts.push("- Files changed:");
        for (const file of summary.files) {
          const diffFileName = file.diffFileName || `${file.path.replace(/\//g, "__")}.diff`;
          const diffChars = file.diffSizeChars ?? file.diffSizeBytes;
          const originalChars = file.originalSizeChars ?? file.originalSizeBytes;
          parts.push(`  - ${file.path} (diff: diffs/${diffFileName})`);
          let fileLine = `    ${file.status}, ${file.diffLines} diff lines, ${diffChars} diff chars`;
          if (originalChars !== undefined) {
            fileLine += `, ${originalChars} original chars`;
          }
          parts.push(fileLine);
        }
      }
    } catch {
      if (folderPath) {
        parts.push(`- PR details are available in the folder ${folderPath}`);
        parts.push("  - Read summary.json for file list and diff sizes.");
      }
    }
  } else if (folderPath) {
    parts.push(`- PR details are available in the folder ${folderPath}`);
    parts.push("  - Contents:");
    parts.push("    - all.diff: Complete diff of all files in one file");
    parts.push("    - diffs/: Individual diff files if you need to read specific files");
    parts.push("    - summary.json: Metadata about the PR and changed files");
  }
  return parts.join("\n");
}
