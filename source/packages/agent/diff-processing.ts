const DIFF_TRUNCATION_NOTICE = "\n\n[diff truncated due to size]";
export const DIFF_NO_BUDGET_MESSAGE = "[diff omitted due to size constraints]";

interface ParsedDiffFile {
  readonly fileName: string;
  readonly content: string;
}

interface ParsedDiff {
  readonly preface: string;
  readonly files: readonly ParsedDiffFile[];
}

interface DiffTruncationOptions {
  readonly originalContent?: string;
  readonly truncationNotice?: string;
  readonly skipSorting?: boolean;
}

export function formatParsedDiffWithTruncation(
  parsedDiff: ParsedDiff,
  maxCharLength: number,
  options: DiffTruncationOptions = {},
): string {
  const {
    originalContent,
    truncationNotice = DIFF_TRUNCATION_NOTICE,
    skipSorting = false,
  } = options;
  if (maxCharLength <= 0) {
    return DIFF_NO_BUDGET_MESSAGE;
  }
  if (parsedDiff.files.length === 0) {
    const content = originalContent ?? parsedDiff.preface;
    if (content.length <= maxCharLength) {
      return content;
    }
    return truncateWithNotice(content, maxCharLength, truncationNotice);
  }
  const filesToProcess = skipSorting
    ? parsedDiff.files
    : [...parsedDiff.files].sort((a, b) => a.content.length - b.content.length);
  const allFilenames = parsedDiff.files.map(file => file.fileName);
  const includedFilenames = filesToProcess.map(file => file.fileName);
  const includedContents = filesToProcess.map(file => file.content);
  const prefaceLength = parsedDiff.preface.length;
  let totalContentLength = includedContents.reduce((sum, content) => sum + content.length, 0);
  const buildDiffString = (maxCharsForSummary?: number): string => {
    const summary = buildTruncatedFilenameSummary(
      allFilenames,
      includedFilenames,
      maxCharsForSummary,
    );
    return parsedDiff.preface + includedContents.join("") + summary;
  };
  const computeExpectedLength = (): number => {
    const summary = buildTruncatedFilenameSummary(allFilenames, includedFilenames);
    return prefaceLength + totalContentLength + summary.length;
  };
  let left = 0;
  let right = includedContents.length;
  let bestCount = 0;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const testTotalContentLength = includedContents
      .slice(0, mid)
      .reduce((sum, content) => sum + content.length, 0);
    const testIncludedFilenames = includedFilenames.slice(0, mid);
    const testSummary = buildTruncatedFilenameSummary(allFilenames, testIncludedFilenames);
    const testExpectedLength = prefaceLength + testTotalContentLength + testSummary.length;
    if (testExpectedLength <= maxCharLength) {
      bestCount = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  includedContents.splice(bestCount);
  includedFilenames.splice(bestCount);
  totalContentLength = includedContents.reduce((sum, content) => sum + content.length, 0);
  let diffString = buildDiffString();
  if (diffString.length > maxCharLength) {
    const summaryBudget = Math.max(0, maxCharLength - parsedDiff.preface.length);
    diffString = buildDiffString(summaryBudget);
  }
  if (diffString.length > maxCharLength) {
    const content = originalContent ?? diffString;
    return truncateWithNotice(content, maxCharLength, truncationNotice);
  }
  return diffString;
}

function buildTruncatedFilenameSummary(
  allFilenames: readonly string[],
  includedFilenames: readonly string[],
  maxChars?: number,
): string {
  const includedSet = new Set(includedFilenames);
  const excludedFilenames = allFilenames.filter(filename => !includedSet.has(filename));
  if (excludedFilenames.length === 0) {
    return "";
  }
  const header = "\n\nThe following files were also edited, but their diff has been excluded for brevity:\n\n";
  const filenameLineLength = (filename: string): number => `- ${filename}\n`.length;
  const summaryLineLength = (remainingCount: number): number =>
    `\n- ${remainingCount} more filenames (paths not included for brevity)`.length;
  if (maxChars === undefined) {
    const fileLines = excludedFilenames.map(filename => `- ${filename}`).join("\n");
    return header + fileLines;
  }
  let currentLength = header.length;
  const filesThatFit: string[] = [];
  for (const filename of excludedFilenames) {
    const lineLength = filenameLineLength(filename);
    const remainingCount = excludedFilenames.length - filesThatFit.length - 1;
    const needsSummary = remainingCount > 0;
    const summaryLength = needsSummary ? summaryLineLength(remainingCount) : 0;
    if (currentLength + lineLength + summaryLength <= maxChars) {
      filesThatFit.push(filename);
      currentLength += lineLength;
    } else {
      break;
    }
  }
  const remainingCount = excludedFilenames.length - filesThatFit.length;
  if (filesThatFit.length === 0) {
    if (remainingCount > 0) {
      return `${header}- ${remainingCount} files (paths not included for brevity)`;
    }
    return "";
  }
  const fileLines = filesThatFit.map(filename => `- ${filename}`).join("\n");
  let result = header + fileLines;
  if (remainingCount > 0) {
    result += `\n- ${remainingCount} more filenames (paths not included for brevity)`;
  }
  return result;
}

function truncateWithNotice(
  diffContent: string,
  maxCharLength: number,
  truncationNotice = DIFF_TRUNCATION_NOTICE,
): string {
  if (maxCharLength < DIFF_NO_BUDGET_MESSAGE.length) {
    return "";
  }
  if (maxCharLength < truncationNotice.length) {
    return DIFF_NO_BUDGET_MESSAGE;
  }
  const visibleLength = maxCharLength - truncationNotice.length;
  if (visibleLength <= 0) {
    return DIFF_NO_BUDGET_MESSAGE;
  }
  return diffContent.slice(0, visibleLength) + truncationNotice;
}
