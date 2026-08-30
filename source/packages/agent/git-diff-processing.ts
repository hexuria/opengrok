import {
  GIT_DIFF_INTRO,
  GIT_DIFF_TRUNCATION_NOTICE,
  GIT_DIFF_UNCOMMITTED_INTRO,
  MAX_GIT_DIFF_CHAR_LENGTH,
} from "../constants/git-diff.js";
import {
  DIFF_NO_BUDGET_MESSAGE,
  formatParsedDiffWithTruncation,
} from "./diff-processing.js";

interface SelectedGitDiffContent {
  readonly content?: string;
  readonly fullContentLengthCharCount: number;
}

interface TextContent {
  readonly type: "text";
  readonly text: string;
}

interface ParsedGitDiffFile {
  readonly fileName: string;
  readonly content: string;
}

interface ParsedGitDiff {
  readonly preface: string;
  readonly files: ParsedGitDiffFile[];
}

function buildGitDiffContent(
  content: string | undefined,
  fullContentLengthCharCount: number,
  tagName: string,
  intro: string,
): TextContent {
  let diffContent = content ?? "";
  let wasTruncated = fullContentLengthCharCount > diffContent.length;
  if (diffContent.length > MAX_GIT_DIFF_CHAR_LENGTH) {
    wasTruncated = true;
    diffContent = formatGitDiffWithTruncation(diffContent, MAX_GIT_DIFF_CHAR_LENGTH);
  }
  const formattedDiff = wasTruncated && !diffContent.endsWith(GIT_DIFF_TRUNCATION_NOTICE)
    ? diffContent + GIT_DIFF_TRUNCATION_NOTICE
    : diffContent;
  const text = [
    `<${tagName}>`,
    `  ${intro}${formattedDiff}`,
    `  </${tagName}>`,
  ].join("\n");
  return {
    type: "text",
    text,
  };
}

export function buildGitDiffUncommittedUserContent(gitDiff: SelectedGitDiffContent): TextContent {
  return buildGitDiffContent(
    gitDiff.content,
    gitDiff.fullContentLengthCharCount,
    "git_diff",
    GIT_DIFF_UNCOMMITTED_INTRO,
  );
}

export function buildGitDiffUserContent(gitDiff: SelectedGitDiffContent): TextContent {
  return buildGitDiffContent(
    gitDiff.content,
    gitDiff.fullContentLengthCharCount,
    "git_diff_from_branch_to_main",
    GIT_DIFF_INTRO,
  );
}

function formatGitDiffWithTruncation(diffContent: string, maxCharLength: number): string {
  if (maxCharLength <= 0) {
    return DIFF_NO_BUDGET_MESSAGE;
  }
  if (diffContent.length <= maxCharLength) {
    return diffContent;
  }
  const parsedDiff = parseGitDiffContent(diffContent);
  return formatParsedDiffWithTruncation(parsedDiff, maxCharLength, {
    originalContent: diffContent,
    truncationNotice: GIT_DIFF_TRUNCATION_NOTICE,
  });
}

function parseGitDiffContent(diffContent: string): ParsedGitDiff {
  const diffHeaderRegex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  const fileMatches: Array<{ index: number; fileName: string }> = [];
  let match = diffHeaderRegex.exec(diffContent);
  while (match !== null) {
    const fileName = match[2]?.trim() ?? match[1]?.trim() ?? "unknown file";
    fileMatches.push({ index: match.index ?? 0, fileName });
    match = diffHeaderRegex.exec(diffContent);
  }
  if (fileMatches.length === 0) {
    return {
      preface: diffContent,
      files: [],
    };
  }
  const files: ParsedGitDiffFile[] = [];
  const preface = diffContent.slice(0, fileMatches[0]!.index);
  for (let index = 0; index < fileMatches.length; index += 1) {
    const start = fileMatches[index]?.index ?? diffContent.length;
    const end = index + 1 < fileMatches.length
      ? fileMatches[index + 1]?.index ?? diffContent.length
      : diffContent.length;
    const fileContent = diffContent.slice(start, end);
    files.push({
      fileName: fileMatches[index]?.fileName ?? "unknown file",
      content: fileContent,
    });
  }
  return {
    preface,
    files,
  };
}
