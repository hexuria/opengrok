import type {
  InvocationContext,
  InvocationContext_IdeState_ViewedPullRequest,
} from "../proto/generated/agent/v1/selected_context_pb.js";
import { formatSlackSenderLine } from "./utils/slack-sender-line.js";
import { extractTerminalId } from "../utils/path-matchers.js";

export interface InvocationTextContent {
  readonly type: "text";
  readonly text: string;
}

interface ViewedPullRequestSummaryFile {
  readonly path: string;
  readonly diffFileName?: string;
  readonly status?: unknown;
  readonly diffLines?: unknown;
  readonly diffSizeChars?: unknown;
  readonly diffSizeBytes?: unknown;
  readonly originalSizeChars?: unknown;
  readonly originalSizeBytes?: unknown;
}

interface ViewedPullRequestSummary {
  readonly headRef?: string;
  readonly baseRef?: string;
  readonly totalFiles?: unknown;
  readonly totalDiffLines?: unknown;
  readonly totalDiffSizeChars?: unknown;
  readonly totalDiffSizeBytes?: unknown;
  readonly files?: readonly ViewedPullRequestSummaryFile[];
}

function renderSlackThread(
  slackThread: Extract<InvocationContext["data"], { case: "slackThread" }>["value"],
): string {
  const hasChannelInfo = slackThread.channelName !== undefined && slackThread.channelName.length > 0 ||
    slackThread.channelPurpose !== undefined && slackThread.channelPurpose.length > 0 ||
    slackThread.channelTopic !== undefined && slackThread.channelTopic.length > 0;
  const hasThreadContext = slackThread.thread !== undefined && slackThread.thread.length > 0;
  let slackContextText = "<slack_context>\n";
  if (hasChannelInfo) {
    slackContextText += "<slack_channel>\n";
    if (slackThread.channelName !== undefined && slackThread.channelName.length > 0) {
      slackContextText += `Channel: #${slackThread.channelName}\n`;
    }
    if (slackThread.channelPurpose !== undefined && slackThread.channelPurpose.length > 0) {
      slackContextText += `Channel purpose: ${slackThread.channelPurpose}\n`;
    }
    if (slackThread.channelTopic !== undefined && slackThread.channelTopic.length > 0) {
      slackContextText += `Channel topic: ${slackThread.channelTopic}\n`;
    }
    slackContextText += "</slack_channel>\n";
  }
  const senderLine = formatSlackSenderLine(slackThread.senderName, slackThread.senderId, slackThread.senderType);
  if (hasThreadContext || senderLine !== undefined) {
    slackContextText += "<slack_thread>\n";
    if (hasThreadContext) {
      slackContextText += `The user shared the following Slack thread for additional context
${slackThread.thread}
`;
    }
    if (senderLine !== undefined) {
      slackContextText += `${senderLine}
`;
    }
    slackContextText += "</slack_thread>\n";
  }
  slackContextText += "</slack_context>";
  return slackContextText;
}

function renderMicrosoftTeamsThread(
  teamsThread: Extract<InvocationContext["data"], { case: "microsoftTeamsThread" }>["value"],
): string {
  const hasChannelMetadata = teamsThread.channelName !== undefined && teamsThread.channelName.length > 0 ||
    teamsThread.channelDescription !== undefined && teamsThread.channelDescription.length > 0 ||
    teamsThread.teamName !== undefined && teamsThread.teamName.length > 0 ||
    teamsThread.teamDescription !== undefined && teamsThread.teamDescription.length > 0;
  const hasTeamsThreadContext = teamsThread.thread !== undefined && teamsThread.thread.length > 0;
  let teamsContextText = "<microsoft_teams_context>\n";
  if (hasChannelMetadata) {
    teamsContextText += "<microsoft_teams_channel>\n";
    if (teamsThread.teamName !== undefined && teamsThread.teamName.length > 0) {
      teamsContextText += `Team: ${teamsThread.teamName}\n`;
    }
    if (teamsThread.teamDescription !== undefined && teamsThread.teamDescription.length > 0) {
      teamsContextText += `Team description: ${teamsThread.teamDescription}\n`;
    }
    if (teamsThread.channelName !== undefined && teamsThread.channelName.length > 0) {
      teamsContextText += `Channel: #${teamsThread.channelName}\n`;
    }
    if (teamsThread.channelDescription !== undefined && teamsThread.channelDescription.length > 0) {
      teamsContextText += `Channel description: ${teamsThread.channelDescription}\n`;
    }
    teamsContextText += "</microsoft_teams_channel>\n";
  }
  if (hasTeamsThreadContext) {
    teamsContextText += `<microsoft_teams_thread>
The user shared the following Microsoft Teams thread for additional context
${teamsThread.thread}
</microsoft_teams_thread>
`;
  }
  teamsContextText += "</microsoft_teams_context>";
  return teamsContextText;
}

function renderViewedPullRequest(
  viewedPr: InvocationContext_IdeState_ViewedPullRequest,
): string {
  let currentlyViewedPrSection = `PR #${viewedPr.number}`;
  if (viewedPr.title) {
    currentlyViewedPrSection += `: ${viewedPr.title}`;
  }
  currentlyViewedPrSection += "\n";
  if (viewedPr.url) {
    currentlyViewedPrSection += `- URL: ${viewedPr.url}\n`;
  }
  if (viewedPr.summaryJson) {
    try {
      const summaryForBranch = JSON.parse(viewedPr.summaryJson) as { headRef?: string; baseRef?: string };
      const headRef = summaryForBranch.headRef?.trim();
      const baseRef = summaryForBranch.baseRef?.trim();
      if (headRef) {
        currentlyViewedPrSection += `- Branch: ${headRef}${baseRef ? ` → ${baseRef}` : ""}\n`;
      }
    } catch {
    }
  }
  if (viewedPr.description) {
    const maxDescriptionLength = 500;
    if (viewedPr.description.length > maxDescriptionLength) {
      const truncated = viewedPr.description.slice(0, maxDescriptionLength);
      currentlyViewedPrSection += `- Description: ${truncated}... (truncated, full description in summary.json)\n`;
    } else {
      currentlyViewedPrSection += `- Description: ${viewedPr.description}\n`;
    }
  }
  if (viewedPr.folderPath) {
    currentlyViewedPrSection += `- Some additional details about the PR are available in the folder ${viewedPr.folderPath}\n`;
    currentlyViewedPrSection += "  - Contents:\n";
    currentlyViewedPrSection += "    - all.diff: Complete diff of all files in one file\n";
    currentlyViewedPrSection += "    - diffs/: Individual diff files if you need to read specific files\n";
    currentlyViewedPrSection += "    - summary.json: Metadata about the PR and changed files\n";
    currentlyViewedPrSection += "    - comments.json: Review comments on the PR\n";
    if (viewedPr.summaryJson) {
      try {
        const summary = JSON.parse(viewedPr.summaryJson) as ViewedPullRequestSummary;
        const totalDiffChars = summary.totalDiffSizeChars ?? summary.totalDiffSizeBytes;
        currentlyViewedPrSection += `- Summary: ${summary.totalFiles} files, ${summary.totalDiffLines} lines, ${totalDiffChars} chars\n`;
        currentlyViewedPrSection += "- Files changed:\n";
        for (const file of summary.files || []) {
          const diffFileName = file.diffFileName || `${file.path.replace(/\//g, "__")}.diff`;
          const diffChars = file.diffSizeChars ?? file.diffSizeBytes;
          const originalChars = file.originalSizeChars ?? file.originalSizeBytes;
          currentlyViewedPrSection += `  - ${file.path} (diff: diffs/${diffFileName})\n`;
          currentlyViewedPrSection += `    ${file.status}, ${file.diffLines} diff lines, ${diffChars} diff chars`;
          if (originalChars !== undefined) {
            currentlyViewedPrSection += `, ${originalChars} original chars`;
          }
          currentlyViewedPrSection += "\n";
        }
      } catch {
        currentlyViewedPrSection += "- Read summary.json for file list and diff sizes.\n";
      }
    }
  }
  return currentlyViewedPrSection;
}

function renderIdeState(
  ideState: Extract<InvocationContext["data"], { case: "ideState" }>["value"],
  enableTerminalFiles: boolean,
): string {
  let recentlyViewedFiles = ideState.recentlyViewedFiles;
  let visibleFiles = ideState.visibleFiles;
  if (!enableTerminalFiles) {
    recentlyViewedFiles = recentlyViewedFiles.filter(file => extractTerminalId(file.path) === null);
    visibleFiles = visibleFiles.filter(file => extractTerminalId(file.path) === null);
  }
  let recentlyViewedSection = "";
  if (recentlyViewedFiles.length > 0) {
    recentlyViewedSection = "Recently viewed files (recent at the top, oldest at the bottom):\n";
    const reversedFiles = [...recentlyViewedFiles].reverse();
    for (const file of reversedFiles) {
      recentlyViewedSection += `- ${file.path}`;
      if (file.totalLines !== -1) {
        recentlyViewedSection += ` (total lines: ${file.totalLines})`;
      }
      if (file.activeCommand && enableTerminalFiles) {
        recentlyViewedSection += ` (active command: ${file.activeCommand})`;
      }
      recentlyViewedSection += "\n";
    }
    recentlyViewedSection += "\n";
  }
  let visibleFilesSection = "";
  if (visibleFiles.length === 0) {
    visibleFilesSection = "User currently doesn't have any open files in their IDE.\n";
  } else {
    visibleFilesSection = "Files that are currently open and visible in the user's IDE:\n";
    for (const file of visibleFiles) {
      visibleFilesSection += `- ${file.path}`;
      const hasTotalLines = file.totalLines !== -1;
      if (file.cursorPosition !== undefined) {
        if (hasTotalLines) {
          visibleFilesSection += ` (currently focused file, cursor is on line ${file.cursorPosition.line}, total lines: ${file.totalLines})`;
        } else {
          visibleFilesSection += ` (currently focused file, cursor is on line ${file.cursorPosition.line})`;
        }
      } else if (hasTotalLines) {
        visibleFilesSection += ` (total lines: ${file.totalLines})`;
      }
      if (file.activeCommand && enableTerminalFiles) {
        visibleFilesSection += ` (active command: ${file.activeCommand})`;
      }
      visibleFilesSection += "\n";
    }
  }
  let currentlyViewedPrSection = "";
  const viewedPrs = ideState.currentlyViewedPrs;
  if (viewedPrs && viewedPrs.length > 0) {
    currentlyViewedPrSection = viewedPrs.length === 1
      ? "\nCurrently viewing Pull Request:\n"
      : "\nCurrently viewing Pull Requests:\n";
    for (const viewedPr of viewedPrs) {
      if (viewedPr.number === undefined) {
        continue;
      }
      currentlyViewedPrSection += renderViewedPullRequest(viewedPr);
    }
  }
  return `<open_and_recently_viewed_files>
${recentlyViewedSection}${visibleFilesSection}${currentlyViewedPrSection}
Note: these files may or may not be relevant to the current conversation. Use the read file tool if you need to get the contents of some of them.
</open_and_recently_viewed_files>`;
}

// Extracted from ../packages/agent/dist/context-processing.js as the
// dependency-closed Slack, Microsoft Teams, and IDE invocation branch. Blob
// hydration, GitHub PR rendering, and the parent processSelectedContext
// function remain absent.
export function renderPlatformInvocationContext(
  invocationContext: InvocationContext,
  enableTerminalFiles: boolean,
): InvocationTextContent | undefined {
  if (invocationContext.data.case === "slackThread") {
    return { type: "text", text: renderSlackThread(invocationContext.data.value) };
  }
  if (invocationContext.data.case === "microsoftTeamsThread") {
    return { type: "text", text: renderMicrosoftTeamsThread(invocationContext.data.value) };
  }
  if (invocationContext.data.case === "ideState") {
    return { type: "text", text: renderIdeState(invocationContext.data.value, enableTerminalFiles) };
  }
  return undefined;
}
