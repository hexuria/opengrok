import { CLOUD_AGENT_ARTIFACTS_DIR } from "../../constants/cloud-agent.js";
import { Fragment, jsx, jsxs } from "../../prompt-jsx/jsx-runtime.js";
import { renderContent } from "../../prompt-jsx/render.js";
import { CURSOR_DYNAMIC_TOOLS_NAMESPACE } from "../../agent-exec/mcp.js";
import { noRepositoryAccessBullets } from "./cloud/no-repository-access.js";

interface PromptArtifactProps {
  readonly env?: {
    readonly artifactsFolder?: string | undefined;
  } | undefined;
}

function normalizePromptArtifactsDir(artifactsDir: string): string {
  if (artifactsDir.endsWith("/") || artifactsDir.endsWith("\\")) {
    return artifactsDir;
  }
  return artifactsDir.includes("\\") && !artifactsDir.includes("/") ? `${artifactsDir}\\` : `${artifactsDir}/`;
}

export function resolvePromptArtifactsDir(props: PromptArtifactProps): string {
  const reported = props.env?.artifactsFolder?.trim();
  const artifactsDir = reported !== undefined && reported.length > 0 ? reported : CLOUD_AGENT_ARTIFACTS_DIR;
  return normalizePromptArtifactsDir(artifactsDir);
}

interface ComputerUseToolInfo {
  readonly allTools: Record<string, { readonly name: string } | undefined>;
}

interface ComputerUsePromptProps {
  readonly subagentType?: { readonly type?: { readonly case?: string | undefined } | undefined } | undefined;
  readonly toolInfo: ComputerUseToolInfo;
}

function getRequiredToolName(allTools: ComputerUseToolInfo["allTools"], toolId: string): string {
  const tool = allTools[toolId];
  if (!tool) throw new Error(`Required tool ${toolId} not found in allTools`);
  return tool.name;
}

export function ComputerUseInstructionsSection({ props }: { readonly props: ComputerUsePromptProps }) {
  const isComputerUseSubagent = props.subagentType?.type?.case === "computerUse";
  const reflectToolName = isComputerUseSubagent ? props.toolInfo.allTools.REFLECT?.name : undefined;
  return jsxs("section", { title: "computer_use", children: [jsx("p", { children: "You have access to the `computer` tool which allows you to interact with the desktop." }), jsx("h2", { children: "When to Use Computer-Use" }), isComputerUseSubagent ? jsxs("p", { children: ["Use the `computer` tool to interact with the desktop and browser. NEVER use the `computer` tool to run (non-terminal-UI-dependent) shell commands, use the `", getRequiredToolName(props.toolInfo.allTools, "SHELL"), "` tool instead."] }) : jsxs(Fragment, { children: [jsx("p", { children: "Use the `computer` tool when you need to:" }), jsxs("ul", { children: [jsx("li", { children: "Manually test built applications / websites and UI changes" }), jsx("li", { children: "Verify that UI changes are working correctly" }), jsx("li", { children: "Interact with built applications / websites" }), jsx("li", { children: "Capture screenshots for visual verification" })] })] }), jsx("h2", { children: "Tool Usage" }), jsx("p", { children: "The `computer` tool accepts a list of actions to execute sequentially. Each action will be performed in order, and a screenshot will be captured after all actions complete." }), jsx("p", { children: "Available actions include:" }), jsxs("ul", { children: [jsx("li", { children: "`mouse_move`: Move mouse to coordinates" }), jsx("li", { children: "`left_click`: Click at coordinates or on an element" }), jsx("li", { children: "`left_click_drag`: Drag from one point to another" }), jsx("li", { children: "`right_click`, `middle_click`: Right/middle click" }), jsx("li", { children: "`scroll`: Scroll page or element" }), jsx("li", { children: "`type`: Type text at current focus. When typing multi-line text, unescaped newlines (\\n) and carriage returns (\\r) will be converted to Enter key presses." }), jsx("li", { children: '`key`: Press a keyboard key or key combination. Supports xdotool-style syntax: "ctrl+a", "super+Tab"' }), jsx("li", { children: "`wait`: Wait for time. Useful when waiting for content to appear / disappear (seconds)" }), jsx("li", { children: "`screenshot`: Capture a screenshot (automatically captured after actions)" })] }), reflectToolName !== undefined && jsxs(Fragment, { children: [jsxs("p", { children: ["Additionally, the `", reflectToolName, "` action is available as its own tool:"] }), jsx("ul", { children: jsxs("li", { children: ["`", reflectToolName, "`: Use `", reflectToolName, "` when your actions are not having the desired effect. For example, if clicking a button or scrolling is not working as expected, use the `", reflectToolName, "` tool to reflect on the current state and plan an improved approach. The `", reflectToolName, "` tool is expensive, so use it sparingly. Always include the `next_steps` field in your `", reflectToolName, "` tool calls."] }) })] }), jsx("h2", { children: "Typing Best Practices" }), jsxs("ul", { children: [jsx("li", { children: 'IMPORTANT: Before typing into ANY text field that may contain existing text, ALWAYS clear it first by using `key` with "Control+a" (or "Meta+a" on Mac) followed by `key` with "Backspace". This ensures predictable state.' }), jsx("li", { children: "NEVER type or clear text after a click action returned an error - the element may not be focused." }), jsx("li", { children: "If typing doesn't appear, verify the target element is focused by clicking it first." })] }), jsx("h2", { children: "Best Practices" }), jsxs("ul", { children: [jsx("li", { children: "Wait for elements to appear before interacting with them" }), jsx("li", { children: "Test key user flows and edge cases" }), jsx("li", { children: "Provide evidence (screenshots) when demonstrating that your work" }), jsx("li", { children: "If a click action fails due to page changes during execution, evaluate the new screenshot and retry the action at the updated coordinates." })] }), jsx("h2", { children: "Evidence for Testing" }), jsxs("p", { children: ["The `computer` tool returns a `screenshot_path` field indicating where the screenshot was saved.", " ", isComputerUseSubagent && "Use this exact path in your img tags when referencing screenshots."] }), jsx("p", { children: "Always include screenshot(s) in your response to demonstrate your work." })] });
}

const NO_FORCE_PUSH_OR_AMEND_COMMITS_NOTE = "Do not force push or amend commits unless explictly instructed to do so.";

const keyedJsx = (type: string, props: Parameters<typeof jsx>[1], _key: string) => jsx(type, props);
const keyedJsxs = (type: string, props: Parameters<typeof jsxs>[1], _key: string) => jsxs(type, props);

interface GitInstructionsProps {
  readonly toolInfo: ComputerUseToolInfo;
  readonly shouldShowTestingInstructions?: boolean | undefined;
  readonly suppressCreatedPrMention?: boolean | undefined;
  readonly canMarkPrReady?: boolean | undefined;
}

function NoRepositoryAccessInstructions() {
  const [mainBullet, redirectBullet] = noRepositoryAccessBullets();
  return [
    jsx("li", { children: mainBullet }, "no-repository-access"),
    jsx("li", { children: redirectBullet }, "no-repository-access-redirect"),
  ];
}

function GitInstructions({ toolInfo, shouldShowTestingInstructions, suppressCreatedPrMention = false, canMarkPrReady = false }: GitInstructionsProps) {
  const prToolName = toolInfo.allTools.PR_MANAGEMENT?.name;
  const hasPrTool = prToolName !== undefined;
  return [
    keyedJsxs("li", { children: ["You are responsible for managing all git operations", !hasPrTool && " outside of PRs/MRs", ". When you have completed changes to the codebase and are ready to submit them, you MUST run `git add` to stage your changes, `git commit` to commit them with a descriptive message, and `git push` to push them to the remote repository."] }, "manage-git-operations"),
    keyedJsx("li", { children: "The git client on this repository path already has `user.name` and `user.email` configured. Use that existing git config for commits, and do not override it unless the user explicitly asks you to." }, "git-config"),
    keyedJsx("li", { children: "When commiting, create a new commit for each logical change. Do not batch commits unless explictly instructed to do so." }, "commit-per-logical-change"),
    keyedJsx("li", { children: NO_FORCE_PUSH_OR_AMEND_COMMITS_NOTE }, "no-force-push"),
    keyedJsx("li", { children: "Do not leave the current git branch unless the user explicitly asks you to do so." }, "no-leave-branch"),
    keyedJsxs("li", { children: ["Do not merge pull requests or enable auto-merge (for example, `gh pr merge`, including the `--auto` flag)", !canMarkPrReady && ", and do not mark pull requests as ready for review or otherwise change a pull request's merge state", ". Only do ", canMarkPrReady ? "this" : "any of the above", " if the user explicitly instructs you to do so."] }, "no-merge-pr"),
    hasPrTool ? keyedJsxs("li", { children: ["You can create or update pull requests using the ", prToolName, " tool. Use it to create PRs after pushing your changes, or to update PR titles and descriptions. At the end of every turn, before giving your summary, create or update the PR if you have made changes to the branch. PRs are created as draft by default unless the user specifies otherwise.", canMarkPrReady && " When the PR is ready for human review, mark it ready by calling update_pr with draft set to false.", " ", "Before creating a PR, check for a PR template (e.g. PULL_REQUEST_TEMPLATE.md, .github/PULL_REQUEST_TEMPLATE.md, or PULL_REQUEST_TEMPLATE/*.md) and use it to populate the body if one exists", !suppressCreatedPrMention && ". You should not mention the created PR to the user unless explicitly asked to", shouldShowTestingInstructions ? ". If you captured relevant artifacts (images/videos), include them in the PR body using HTML img/video tags with absolute file paths (do NOT worry about making the artifact file publicly accessible or adding it to the repo, just reference the path as-is and the tool will handle the rest)." : "."] }, "pr-management-tool") : keyedJsx("li", { children: "This remote environment will handle PRs/MRs automatically. Do not attempt to create, update, or merge PRs/MRs yourself unless the user explicitly asks you to do so." }, "env-handles-prs"),
  ];
}

export function GitOrNoRepositoryInstructions({ isRepoless, gitInstructionsProps }: { readonly isRepoless?: boolean | undefined; readonly gitInstructionsProps: GitInstructionsProps }) {
  return isRepoless === true ? NoRepositoryAccessInstructions() : GitInstructions(gitInstructionsProps);
}

const REQUEST_CONTEXT_COMPLETENESS_KEYS = [
  "rules",
  "env",
  "repositoryInfo",
  "customSubagents",
  "agentSkills",
  "gitRepos",
  "gitStatus",
  "mcp",
  "mcpFileSystem",
] as const;

type RequestContextCompleteness = {
  readonly rules: boolean;
  readonly env: boolean;
  readonly repositoryInfo: boolean;
  readonly customSubagents: boolean;
  readonly agentSkills: boolean;
  readonly gitRepos: boolean;
  readonly gitStatus: boolean;
  readonly mcp: boolean;
  readonly mcpFileSystem: boolean;
};

export function getRequestContextCompleteness(requestContext: Record<string, unknown>): RequestContextCompleteness {
  return {
    rules: requestContext.rulesInfoComplete !== false,
    env: requestContext.envInfoComplete !== false,
    repositoryInfo: requestContext.repositoryInfoComplete !== false,
    customSubagents: requestContext.customSubagentsInfoComplete !== false,
    agentSkills: requestContext.agentSkillsInfoComplete !== false,
    gitRepos: requestContext.gitRepoInfoComplete !== false,
    gitStatus: requestContext.gitStatusInfoComplete !== false,
    mcp: requestContext.mcpInfoComplete !== false,
    mcpFileSystem: requestContext.mcpFileSystemInfoComplete !== false,
  };
}

function isRequestContextComplete(completeness: RequestContextCompleteness): boolean {
  return REQUEST_CONTEXT_COMPLETENESS_KEYS.every(key => completeness[key]);
}

function requestContextCompletenessScore(completeness: RequestContextCompleteness): number {
  return REQUEST_CONTEXT_COMPLETENESS_KEYS.filter(key => completeness[key]).length;
}

function requestContextCompletenessIsStrictlyMoreComplete(
  previous: RequestContextCompleteness,
  current: RequestContextCompleteness,
): boolean {
  const neverRegressed = REQUEST_CONTEXT_COMPLETENESS_KEYS.every(key => previous[key] === false || current[key] === true);
  return neverRegressed && requestContextCompletenessScore(current) > requestContextCompletenessScore(previous);
}

export function parseRequestContextCompletenessMetadata(value: unknown): RequestContextCompleteness | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const parsed: any = {};
  for (const key of REQUEST_CONTEXT_COMPLETENESS_KEYS) {
    const item = record[key];
    if (typeof item !== "boolean") return undefined;
    parsed[key] = item;
  }
  return parsed as RequestContextCompleteness;
}

export function shouldRerenderUserInfoForRequestContextRecovery(params: {
  readonly previousCompleteness?: RequestContextCompleteness | undefined;
  readonly currentCompleteness: RequestContextCompleteness;
}): boolean {
  if (params.previousCompleteness === undefined || isRequestContextComplete(params.previousCompleteness)) return false;
  return requestContextCompletenessIsStrictlyMoreComplete(params.previousCompleteness, params.currentCompleteness);
}

export function parseUserInfoSummarizationEpochMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function shouldRerenderUserInfoAfterSummarization(params: {
  readonly previousEpoch?: number | undefined;
  readonly currentEpoch: number;
}): boolean {
  return params.previousEpoch !== undefined && params.currentEpoch > params.previousEpoch;
}

function AvailableSubagentModelsSection({ description }: any): any {
  return jsx("section", { title: "available_subagent_models", children: jsx("p", { children: description }) });
}

function AvailableSubagentTypesSection({ description }: any): any {
  return jsx("section", { title: "available_subagent_types", children: jsx("p", { children: description }) });
}

export function userInfoMatchesAvailableSubagentModels(content: string, description: string | undefined): boolean {
  if (description === undefined) return !content.includes("<available_subagent_models>");
  return content.includes(renderContent(jsx(AvailableSubagentModelsSection, { description })));
}

export function userInfoMatchesAvailableSubagentTypes(content: string, description: string | undefined): boolean {
  if (description === undefined) return !content.includes("<available_subagent_types>");
  return content.includes(renderContent(jsx(AvailableSubagentTypesSection, { description })));
}

export function userInfoMatchesDynamicToolSnapshot(
  content: string,
  mcpMetaToolOptions: {
    readonly enabled?: boolean | undefined;
    readonly mcpDescriptors: readonly { readonly serverIdentifier: string }[];
    readonly snapshotToolNames?: { readonly useDynamicToolNamespaces: boolean } | undefined;
  } | undefined,
): boolean {
  const usesDynamicToolNamespaces = mcpMetaToolOptions?.enabled === true && mcpMetaToolOptions.snapshotToolNames?.useDynamicToolNamespaces === true;
  const expectsDynamicToolNamespaces = usesDynamicToolNamespaces && (mcpMetaToolOptions?.mcpDescriptors.length ?? 0) > 0;
  const hasDynamicToolNamespaces = content.includes("<dynamic_tool_namespaces>");
  if (expectsDynamicToolNamespaces !== hasDynamicToolNamespaces) return false;
  if (!expectsDynamicToolNamespaces || mcpMetaToolOptions === undefined) return true;
  const cursorDescriptor = mcpMetaToolOptions.mcpDescriptors.find(descriptor => descriptor.serverIdentifier === CURSOR_DYNAMIC_TOOLS_NAMESPACE);
  const priorHasCursorNamespace = content.includes(`<namespace name="${CURSOR_DYNAMIC_TOOLS_NAMESPACE}"`);
  if (cursorDescriptor === undefined) return !priorHasCursorNamespace;
  return priorHasCursorNamespace;
}
