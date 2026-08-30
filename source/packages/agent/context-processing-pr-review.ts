import type { SelectedGitPRDiffSelection } from "../proto/generated/agent/v1/selected_context_pb.js";

export interface PrReviewTextContent {
  readonly type: "text";
  readonly text: string;
}

// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed hydrated PR-review diff rendering leaf. Blob hydration, GitHub
// composition, and the parent processSelectedContext function remain absent.
export function renderPrReviewContext(
  hydratedGitPrDiffSelections: readonly SelectedGitPRDiffSelection[],
): PrReviewTextContent | undefined {
  if (hydratedGitPrDiffSelections.length === 0) {
    return undefined;
  }
  const prDiffText = hydratedGitPrDiffSelections.map(selection => {
    const lineRange = selection.startLine === selection.endLine
      ? `line ${selection.startLine}`
      : `lines ${selection.startLine}-${selection.endLine}`;
    let text = `<pr_review_content>
File: ${selection.filePath}
Location: ${lineRange}
PR URL: ${selection.prUrl}`;
    if (selection.diffContent) {
      text += `
Diff Content:
${selection.diffContent}`;
    }
    text += `
</pr_review_content>`;
    return text;
  }).join("\n\n");
  return {
    type: "text",
    text: `<pr_review_context>
The user has attached diffs from a pull request
${prDiffText}
</pr_review_context>`,
  };
}
