/**
 * Cloud task/user-info prompt sections recovered from the immutable UserInfo
 * root. Mac/Windows evidence: host-main.cjs:550057-550057,
 * 550142-550179, 550510-550519, and 555293-555294.
 */
import { Fragment, jsx, jsxs } from "../../prompt-jsx/jsx-runtime.js";
import type { PromptNode } from "../../prompt-jsx/jsx-runtime.js";

const UNKNOWN_REPO_LABEL = "unknown-repo";
const UNKNOWN_BRANCH_NAME = "unknown-branch";

interface CloudTaskGitRepo {
  readonly path?: string | undefined;
  readonly repoPath?: string | undefined;
  readonly branchName?: string | undefined;
  readonly baseBranch?: string | undefined;
  readonly remoteUrl?: string | undefined;
}

interface BranchDisplay {
  readonly repoLabel: string;
  readonly branchName: string;
  readonly baseBranch?: string | undefined;
}

interface BranchDisplayInfo {
  readonly displays: BranchDisplay[];
  readonly hasUnknownBranch: boolean;
}

interface ToolInfo {
  readonly allTools: Record<string, { readonly name?: string | undefined } | undefined>;
}

function parseGitUrl(urlString: string): URL | null {
  try {
    let normalizedUrl = urlString;
    if (urlString.includes("@") && !urlString.startsWith("http")) {
      if (!urlString.startsWith("ssh://")) {
        normalizedUrl = urlString.replace(/^([^@]+)@([^:]+):(.*)/, "ssh://$1@$2/$3");
      }
    }
    return new URL(normalizedUrl);
  } catch {
    return null;
  }
}

function extractRepoNameFromGitUrl(upstreamUrl?: string): string | undefined {
  if (!upstreamUrl) return undefined;
  const normalizedUpstreamUrl = upstreamUrl.replace("https///", "https://").replace("http///", "http://");
  if (normalizedUpstreamUrl.startsWith("gitlab-remote://")) {
    try {
      const url = new URL(normalizedUpstreamUrl);
      const projectId = url.searchParams.get("project");
      if (projectId) {
        if (projectId.includes("/")) return projectId;
        return undefined;
      }
    } catch {
      // Fall through to the ordinary Git URL parser.
    }
  }
  const url = parseGitUrl(normalizedUpstreamUrl);
  if (!url) return undefined;
  const hostname = url.hostname.toLowerCase();
  const pathParts = url.pathname.split("/").filter(part => part.length > 0);
  if (pathParts.length > 0 && pathParts[pathParts.length - 1]!.endsWith(".git")) {
    pathParts[pathParts.length - 1] = pathParts[pathParts.length - 1]!.slice(0, -4);
  }
  const isAzureDevOpsHost = hostname === "dev.azure.com" || hostname === "ssh.dev.azure.com" || hostname.endsWith(".visualstudio.com");
  if (isAzureDevOpsHost) {
    const azurePathParts = [...pathParts];
    if (hostname === "ssh.dev.azure.com" && azurePathParts.length > 0 && azurePathParts[0]!.toLowerCase() === "v3") azurePathParts.shift();
    const filteredAzurePathParts = azurePathParts.filter(part => part.toLowerCase() !== "_git");
    return filteredAzurePathParts.length >= 1 ? filteredAzurePathParts.join("/") : undefined;
  }
  if (hostname.includes("github") || hostname.endsWith(".ghe.com")) return pathParts.length >= 2 ? pathParts.slice(0, 2).join("/") : undefined;
  if (hostname.includes("gitlab")) return pathParts.length >= 1 ? pathParts.join("/") : undefined;
  if (hostname.includes("bitbucket") || hostname.includes("stash")) {
    if (pathParts.length >= 3 && pathParts[0]!.toLowerCase() === "scm") return pathParts.slice(1, 3).join("/");
    if (pathParts.length >= 2) return pathParts.slice(0, 2).join("/");
    return undefined;
  }
  const isGerritHost = hostname.includes("gerrit");
  const hasGerritPath = pathParts.length > 0 && pathParts[0]!.toLowerCase() === "gerrit";
  if (isGerritHost || hasGerritPath) {
    const gerritPathParts = [...pathParts];
    if (hasGerritPath) gerritPathParts.shift();
    if (gerritPathParts.length > 0 && gerritPathParts[0]!.toLowerCase() === "a") gerritPathParts.shift();
    return gerritPathParts.length >= 1 ? gerritPathParts.join("/") : undefined;
  }
  return pathParts.length >= 2 ? pathParts.slice(0, 2).join("/") : undefined;
}

function getPathFromBranchInfo(repo: CloudTaskGitRepo): string | undefined {
  return "path" in repo ? repo.path : repo.repoPath;
}

function branchNameForPrompt(branchName?: string): string {
  const trimmed = branchName?.trim() ?? "";
  return trimmed === "" || trimmed === "HEAD" ? UNKNOWN_BRANCH_NAME : trimmed;
}

function basenameFromPath(pathValue?: string): string | undefined {
  const raw = pathValue?.trim() ?? "";
  if (raw === "") return undefined;
  const parts = raw.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

function repoLabelForPrompt(repo: CloudTaskGitRepo): string {
  return extractRepoNameFromGitUrl(repo.remoteUrl) ?? basenameFromPath(getPathFromBranchInfo(repo)) ?? UNKNOWN_REPO_LABEL;
}

function getBranchDisplayInfo(repos: readonly CloudTaskGitRepo[]): BranchDisplayInfo {
  const displays = repos.map(repo => ({
    repoLabel: repoLabelForPrompt(repo),
    branchName: branchNameForPrompt(repo.branchName),
    baseBranch: "baseBranch" in repo ? branchNameForPrompt(repo.baseBranch) : undefined,
  }));
  return { displays, hasUnknownBranch: displays.some(display => display.branchName === UNKNOWN_BRANCH_NAME) };
}

function getGitRepoBranchDisplayInfo(gitRepos: readonly CloudTaskGitRepo[]): BranchDisplayInfo {
  return getBranchDisplayInfo(gitRepos);
}

function getDesignatedBranchDisplayInfo(designatedBranches: readonly CloudTaskGitRepo[]): BranchDisplayInfo {
  return getBranchDisplayInfo(designatedBranches);
}

function buildRepoPathLookup(gitRepos: readonly CloudTaskGitRepo[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const repo of gitRepos) {
    if (repo.path) lookup.set(repoLabelForPrompt(repo), repo.path);
  }
  return lookup;
}

function PlanningComplexityEstimateGuidanceListItem(): PromptNode {
  return jsx("li", { children: "When planning or scoping work, do not estimate calendar time (e.g. days or weeks of effort). Day/week timelines are a poor fit for autonomous agents. If you need to characterize difficulty, use technical detail instead: which components or subsystems must change, how invasive the edits are, and what dependencies or risks apply." });
}

function StaleBuildGitNotice({ staleBuildGitRefs }: { readonly staleBuildGitRefs?: string | undefined }): PromptNode {
  if (staleBuildGitRefs === undefined) return null;
  return jsxs(Fragment, { children: [
    jsx("h3", { children: "Pre-built snapshot git staleness:" }),
    jsx("ul", { children: [
      jsxs("li", { children: ["This VM booted from a pre-built environment snapshot, reusing the git checkout baked when the snapshot was built.", " ", staleBuildGitRefs === "all_refs" ? "Local refs — including the default branch — may be behind the remote (typically by an hour or two; more if recent builds failed)." : "A best-effort refresh of the run's explicitly-requested starting refs ran at startup, but any other local ref (for example, the default branch, or repos in a multi-repo workspace without an explicit starting ref) may be behind the remote."] }),
      jsx("li", { children: "If your task depends on the latest remote state of a possibly-stale branch (e.g. branching from, rebasing onto, merging, or diffing against the latest default branch), run `git fetch origin <branch-name>` for that branch first." }),
      jsx("li", { children: "If the user references repository content that is not present in the local checkout (for example, a file or skill), treat that reference as evidence that the content may have landed after the build was created. Fetch the relevant remote branch and check its latest state before concluding that the content does not exist." }),
      jsx("li", { children: "Otherwise, do NOT fetch preemptively: the reused checkout is intentional (it makes startup fast) and is fine for most tasks." }),
    ] }),
  ] });
}

export function CloudInstructionsSection({ cloudRuleContent }: { readonly cloudRuleContent: string }): PromptNode {
  return jsxs("section", { title: "cloud_instructions", description: "Instructions pulled from AGENTS.md", children: [jsx("p", { children: "AGENTS.md contents:" }), jsx("br", {}), cloudRuleContent] });
}

export function CloudTaskInstructions({
  gitRepos,
  designatedBranches,
  branchPrefix,
  branchSuffix,
  allowMultipleBranches = false,
  preferCurrentBranchInMultiPrMode = false,
  toolInfo,
  staleBuildGitRefs,
}: {
  readonly gitRepos: readonly CloudTaskGitRepo[];
  readonly designatedBranches?: readonly CloudTaskGitRepo[] | undefined;
  readonly branchPrefix?: string | undefined;
  readonly branchSuffix?: string | undefined;
  readonly allowMultipleBranches?: boolean | undefined;
  readonly preferCurrentBranchInMultiPrMode?: boolean | undefined;
  readonly toolInfo?: ToolInfo | undefined;
  readonly staleBuildGitRefs?: string | undefined;
}): PromptNode {
  const gitRepoBranchInfo = designatedBranches !== undefined && designatedBranches.length > 0
    ? getDesignatedBranchDisplayInfo(designatedBranches)
    : allowMultipleBranches && preferCurrentBranchInMultiPrMode
      ? getGitRepoBranchDisplayInfo(gitRepos)
      : allowMultipleBranches
        ? { displays: [], hasUnknownBranch: false }
        : getGitRepoBranchDisplayInfo(gitRepos);
  const gitRepoBranchDisplays = gitRepoBranchInfo.displays;
  const hasUnknownBranch = gitRepoBranchInfo.hasUnknownBranch;
  const managedPrToolName = toolInfo?.allTools.PR_MANAGEMENT?.name;
  const hasManagedPrTool = managedPrToolName !== undefined;
  const prManagementToolReference = managedPrToolName !== undefined ? `\`${managedPrToolName}\` tool` : "PR management tool";
  const currentBranchFromGitRepos = allowMultipleBranches ? getGitRepoBranchDisplayInfo(gitRepos).displays[0]?.branchName : undefined;
  const branchNameTemplate = branchPrefix !== undefined || branchSuffix !== undefined ? `${branchPrefix ?? ""}<descriptive-name>${branchSuffix ?? ""}` : "<branch-name>";
  const branchCreationCommand = `git checkout -b ${branchNameTemplate}`;
  const isMultiRepo = gitRepos.length > 1;
  const managedPrWriteGuidance = managedPrToolName === undefined ? "" : isMultiRepo ? " Do not use `gh` to create or update pull requests. For `create_pr`, pass `action`, `title`, `body`, `branch_name`, `base_branch`, and `remote_url`. For `update_pr`, pass `action`, `remote_url`, either `branch_name` or `pr_url`, and at least one of `title`, `body`, or `base_branch`." : " Do not use `gh` to create or update pull requests. For `create_pr`, pass `action`, `title`, `body`, `branch_name`, and `base_branch`. For `update_pr`, pass `action`, either `branch_name` or `pr_url`, and at least one of `title`, `body`, or `base_branch`.";
  const repoPathLookup = isMultiRepo ? buildRepoPathLookup(gitRepos) : undefined;
  return jsxs("section", { title: "cloud_task_instructions", children: [
    jsx("p", { children: "As a Cloud Agent, you are helping with GitHub issues and pull requests. Your task is to complete the request described in the `user_query`." }),
    jsx("ul", { children: jsx(PlanningComplexityEstimateGuidanceListItem, {}) }),
    jsx("h2", { children: "Git Development Branch Requirements" }),
    isMultiRepo && allowMultipleBranches && jsx("p", { children: "This workspace contains multiple git repositories. Each branch listed below is associated with a specific repository and local directory. Make sure to run git commands from the correct repository directory." }),
    jsx("p", { children: allowMultipleBranches
      ? preferCurrentBranchInMultiPrMode
        ? `You are currently on the existing branch${currentBranchFromGitRepos !== undefined && currentBranchFromGitRepos !== UNKNOWN_BRANCH_NAME ? ` \`${currentBranchFromGitRepos}\`` : ""}. The user likely wants changes to happen on this branch rather than on a new one. Reuse the current branch by default${hasManagedPrTool ? `, and use the ${prManagementToolReference} to register or update it` : ""} unless the user explicitly asks for separate branch work.`
        : `You are currently on the base branch${currentBranchFromGitRepos !== undefined && currentBranchFromGitRepos !== UNKNOWN_BRANCH_NAME ? ` \`${currentBranchFromGitRepos}\`` : ""}. Create feature branches off of it for your work${hasManagedPrTool ? ", and use it as the default `base_branch` when creating PRs" : ""} unless the user specifies differently. If this agent already has registered PR branches, they are listed here for context:`
      : "You are working on the following feature branches:" }),
    gitRepoBranchDisplays.length > 0
      ? jsx("ul", {
        children: gitRepoBranchDisplays.map(display => jsxs("li", {
          children: [
            allowMultipleBranches && !preferCurrentBranchInMultiPrMode ? `**${display.repoLabel}**: PR branch \`${display.branchName}\`` : `**${display.repoLabel}**: Develop on branch \`${display.branchName}\``,
            isMultiRepo && allowMultipleBranches && repoPathLookup?.get(display.repoLabel) !== undefined && ` (repo directory: \`${repoPathLookup.get(display.repoLabel)}\`)`,
            display.baseBranch !== undefined && display.baseBranch !== UNKNOWN_BRANCH_NAME && ` (base branch: \`${display.baseBranch}\`)`,
          ],
        })),
      })
      : jsx("p", { children: allowMultipleBranches ? preferCurrentBranchInMultiPrMode ? "If the current branch is not yet tracked by PR management, register it before creating any new branch." : `No PR branches are registered yet. Use \`${branchCreationCommand}\` to create a new branch when you need one.` : `No git repository info was provided in \`RequestContext.git_repos\`. Run \`git symbolic-ref --short HEAD\` to determine which branch you should develop on.` }),
    hasUnknownBranch && jsx("p", { children: isMultiRepo && allowMultipleBranches ? "If a branch name is missing or shows as `HEAD`, run `git symbolic-ref --short HEAD` in the corresponding repo directory to confirm the branch you should use." : "If the branch name is missing or shows as `HEAD`, run `git symbolic-ref --short HEAD` in the repo to confirm the branch you should use." }),
    jsx("h3", { children: "Important Instructions:" }),
    allowMultipleBranches
      ? jsxs(Fragment, { children: [
        jsxs("ol", { children: [
          jsxs("li", { children: [preferCurrentBranchInMultiPrMode ? "**REUSE THE CURRENT BRANCH BY DEFAULT**. Make your changes on the current branch unless the user explicitly asks for a separate branch or PR." : branchPrefix !== undefined || branchSuffix !== undefined ? `**CREATE BRANCHES AS NEEDED** using normal git commands like \`${branchCreationCommand}\`. Every new branch name must match the template \`${branchNameTemplate}\`.` : `**CREATE BRANCHES AS NEEDED** using normal git commands like \`${branchCreationCommand}\``, branchPrefix !== undefined && ` Use the prefix \`${branchPrefix}\` for all branch names you create.`, branchSuffix !== undefined && ` Append the suffix \`${branchSuffix}\` to all branch names you create.`, isMultiRepo && " When working across multiple repositories, create branches in each repo as needed.", " Always use lowercase letters in branch names — case-insensitive filesystems (macOS and Windows defaults) cannot hold two branches that differ only in casing."] }),
          jsx("li", { children: "**COMMIT** your work with clear, descriptive commit messages" }),
          jsx("li", { children: "**PUSH** each working branch with normal git push commands" }),
          hasManagedPrTool && jsxs(Fragment, { children: [jsx("li", { children: preferCurrentBranchInMultiPrMode ? `**REGISTER OR UPDATE THE CURRENT BRANCH** using the ${prManagementToolReference}. Always set \`branch_name\` to the current branch. If you create or update a PR for this branch, set \`base_branch\` to the branch this current branch was originally based on, not the current branch itself. Avoid changing the PR title or description unless the user asks you to.${managedPrWriteGuidance}` : `**REGISTER OR CREATE PRS PER BRANCH** using the ${prManagementToolReference}. Always set \`branch_name\`, and provide \`base_branch\` when creating a PR.${managedPrWriteGuidance}` }), jsx("li", { children: "**SEPARATE BRANCHES CAN HAVE SEPARATE PRS**. Do not assume one agent only has one branch or one PR." })] }),
          jsxs("li", { children: ["**ALWAYS** commit and push your changes on each iteration loop as you go from implementing to testing. Before you begin testing, commit and push your changes", hasManagedPrTool ? ", then create the PR (or update the existing PR) for that pre-testing revision. If you make additional changes during or after testing, commit and push them, then update the PR before giving your summary." : "."] }),
          hasManagedPrTool && jsx("li", { children: "**CREATE OR UPDATE** the PR at the end of every turn, before giving your summary, if you have made changes during this turn." }),
        ] }),
        jsx("p", { children: `Remember: the branch list above is contextual, not restrictive. Create, switch${hasManagedPrTool ? ", push, and open PRs on" : ", and push"} whichever branches the task requires.` }),
      ] })
      : jsxs(Fragment, { children: [
        jsxs("ol", { children: [
          jsx("li", { children: "**DEVELOP** all your changes on the designated branch above" }),
          jsx("li", { children: "**COMMIT** your work with clear, descriptive commit messages" }),
          jsx("li", { children: "**PUSH** to the specified branch" }),
          jsx("li", { children: "**CREATE** the branch locally if it doesn't exist yet" }),
          jsx("li", { children: "**NEVER** push to a different branch without explicit instructions from the user." }),
          jsx("li", { children: "Commit and push your changes as you go. Multiple commits with smaller units of work are preffered to one large commit." }),
          jsxs("li", { children: ["**ALWAYS** commit and push your changes on each iteration loop as you go from implementing to testing. Before you begin testing, commit and push your changes", hasManagedPrTool ? ", then create the PR (or update the existing PR) for that pre-testing revision. If you make additional changes during or after testing, commit and push them, then update the PR before giving your summary." : "."] }),
          hasManagedPrTool && jsx("li", { children: "**CREATE OR UPDATE** the PR at the end of every turn, before giving your summary, if you have made changes during this turn." }),
        ] }),
        jsx("p", { children: "Remember: All development and final pushes should go to the branches specified above." }),
      ] }),
    jsx("h2", { children: "Git Operations" }),
    jsx("p", { children: "Follow these practices for git:" }),
    jsx(StaleBuildGitNotice as unknown as (props: Record<string, unknown>) => PromptNode, { staleBuildGitRefs }),
    jsx("h3", { children: "For git push:" }),
    jsx("ul", { children: [jsx("li", { children: "Always use `git push -u origin <branch-name>`" }), jsx("li", { children: "Only if push fails due to network errors retry up to 4 times with exponential backoff (4s, 8s, 16s, 32s)" })] }),
    jsx("h3", { children: "For git fetch/pull:" }),
    jsx("ul", { children: [jsx("li", { children: "Prefer fetching specific branches: `git fetch origin <branch-name>`" }), jsx("li", { children: "If network failures occur, retry up to 4 times with exponential backoff (4s, 8s, 16s, 32s)" }), jsx("li", { children: "For pulls use: `git pull origin <branch-name>`" })] }),
  ] });
}
