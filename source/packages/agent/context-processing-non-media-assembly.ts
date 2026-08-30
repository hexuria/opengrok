import type { SimulatedMsgReason as SimulatedMsgReasonValue } from "../proto/generated/agent/v1/agent_pb.js";
import type {
  SelectedContext,
  SelectedGitPRDiffSelection,
  SelectedPullRequest,
} from "../proto/generated/agent/v1/selected_context_pb.js";
import { buildGitCommitsUserContent } from "./git-commit-processing.js";
import { buildGitDiffUncommittedUserContent, buildGitDiffUserContent } from "./git-diff-processing.js";
import { buildGitPullRequestsUserContent } from "./git-pr-processing.js";
import { renderConsoleLogsContext } from "./context-processing-console-logs.js";
import { renderSelectedCursorCommands } from "./context-processing-cursor-commands.js";
import { renderPrReviewContext } from "./context-processing-pr-review.js";
import { renderRecentAgentsContext } from "./context-processing-recent-agents.js";
import { renderSelectedBrowsersContext } from "./context-processing-selected-browsers.js";
import { renderSelectedSubagentDelegation } from "./context-processing-selected-subagents.js";
import { renderSimulatedMessagePromptUserContent } from "./context-processing-simulated-message.js";
import { renderSelectedUIElementsContext } from "./context-processing-ui-elements.js";
import type { TaskToolModelInfo } from "./tools/task-tool-name.js";

interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface AppendNonMediaSelectedContextContentArgs {
  readonly userContent: TextContent[];
  readonly selectedContext: SelectedContext;
  readonly hydratedSelectedPullRequests: readonly SelectedPullRequest[];
  readonly hydratedGitPrDiffSelections: readonly SelectedGitPRDiffSelection[];
  readonly extraContextsToInclude: readonly string[];
  readonly isComposerMatterhorn: boolean;
  readonly isRawTrainingSlug: boolean;
  readonly simulatedMsgReason: SimulatedMsgReasonValue;
  readonly modelInfo?: TaskToolModelInfo | undefined;
  readonly environmentParamForSubagent: boolean;
  readonly babysitV2Prompt: boolean;
  readonly enablePrCreationForgeGuidance: boolean;
}

// Extracted from ../packages/agent/dist/context-processing.js as the exact
// post-enrichment non-media append sequence. External-link scraping,
// attachment/media output, and the parent processSelectedContext dispatcher
// remain absent by design.
export function appendNonMediaSelectedContextContent({
  userContent,
  selectedContext,
  hydratedSelectedPullRequests,
  hydratedGitPrDiffSelections,
  extraContextsToInclude,
  isComposerMatterhorn,
  isRawTrainingSlug,
  simulatedMsgReason,
  modelInfo,
  environmentParamForSubagent,
  babysitV2Prompt,
  enablePrCreationForgeGuidance,
}: AppendNonMediaSelectedContextContentArgs): void {
  if (selectedContext.cursorCommands.length > 0) {
    const commandsText = renderSelectedCursorCommands(selectedContext.cursorCommands);
    if (commandsText !== undefined) {
      userContent.push(commandsText);
    }
  }
  if (selectedContext.gitDiff) {
    userContent.push(buildGitDiffUncommittedUserContent(selectedContext.gitDiff));
  }
  if (selectedContext.gitDiffFromBranchToMain) {
    userContent.push(buildGitDiffUserContent(selectedContext.gitDiffFromBranchToMain));
  }
  if (selectedContext.gitCommits.length > 0) {
    userContent.push(buildGitCommitsUserContent(selectedContext.gitCommits));
  }
  if (hydratedSelectedPullRequests.length > 0) {
    userContent.push(buildGitPullRequestsUserContent(hydratedSelectedPullRequests));
  }
  const recentAgentsText = renderRecentAgentsContext({
    recentAgents: selectedContext.recentAgentsContext?.recentAgents ?? [],
    isComposerMatterhorn,
    isRawTrainingSlug,
  });
  if (recentAgentsText !== undefined) {
    userContent.push(recentAgentsText);
  }
  const selectedSubagentsText = renderSelectedSubagentDelegation(selectedContext.selectedSubagents);
  if (selectedSubagentsText !== undefined) {
    userContent.push(selectedSubagentsText);
  }
  const prReviewText = renderPrReviewContext(hydratedGitPrDiffSelections);
  if (prReviewText !== undefined) {
    userContent.push(prReviewText);
  }
  const consoleLogsText = renderConsoleLogsContext(selectedContext.consoleLogs);
  if (consoleLogsText !== undefined) {
    userContent.push(consoleLogsText);
  }
  const uiElementsText = renderSelectedUIElementsContext(selectedContext.uiElements);
  if (uiElementsText !== undefined) {
    userContent.push(uiElementsText);
  }
  const browsersText = renderSelectedBrowsersContext(selectedContext.selectedBrowsers);
  if (browsersText !== undefined) {
    userContent.push(browsersText);
  }
  userContent.push(...renderSimulatedMessagePromptUserContent({
    selectedContext,
    simulatedMsgReason,
    modelInfo,
    environmentParamForSubagent,
    babysitV2Prompt,
    enablePrCreationForgeGuidance,
  }));
  for (const extraContext of extraContextsToInclude) {
    userContent.push({
      type: "text",
      text: extraContext,
    });
  }
}
