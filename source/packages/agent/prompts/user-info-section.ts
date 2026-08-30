/**
 * User information prompt section recovered from the immutable host artifact.
 * Mac/Windows evidence: src/app/dist/host/host-main.cjs:554778-554788.
 * Region SHA-256: ff004b0dc41d8e72985f60ab6566dda8bb6b816216b186824f694dac20589818
 */
import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.js";
import type { GitRepoInfo, RequestContextEnv } from "../../proto/generated/agent/v1/request_context_exec_pb.js";
import { jsx, jsxs, Fragment } from "../../prompt-jsx/jsx-runtime.js";
import type { PromptNode } from "../../prompt-jsx/jsx-runtime.js";
import { isWorktreesPath } from "../../utils/path-utils.js";
import { MountedAgentStoresSection } from "./user-info-mounted-stores.js";

export interface UserInfoSectionProps {
  readonly env: RequestContextEnv;
  readonly dsv3?: boolean | undefined;
  readonly mode?: AgentMode | undefined;
  readonly hasGitRepos: boolean;
  readonly gitRepoInfoComplete?: boolean | undefined;
  readonly gitRepos: readonly GitRepoInfo[];
  readonly todaysDate?: string | undefined;
  readonly terminalsFolder?: string | undefined;
  readonly agentSharedNotesFolder?: string | undefined;
  readonly agentConversationNotesFolder?: string | undefined;
  readonly metaAgentNotesDirectory?: string | undefined;
  readonly metaAgentNotesEnabled?: boolean | undefined;
  readonly displayTodaysDate: boolean;
  readonly displayGitRepoStatusLine: boolean;
}

export function UserInfoSection({
  env,
  dsv3,
  mode,
  hasGitRepos,
  gitRepoInfoComplete,
  gitRepos,
  todaysDate,
  terminalsFolder,
  agentSharedNotesFolder,
  agentConversationNotesFolder,
  metaAgentNotesDirectory,
  metaAgentNotesEnabled,
  displayTodaysDate,
  displayGitRepoStatusLine,
}: UserInfoSectionProps): PromptNode {
  const knownRepoText = hasGitRepos
    ? gitRepos.length > 1
      ? `at:\n${gitRepos.map(r => `- ${r.path}`).join("\n")}`
      : `at ${gitRepos[0]!.path}`
    : "";
  const gitRepoStatusText = gitRepoInfoComplete === false
    ? hasGitRepos
      ? `Yes (potentially incomplete while git repository detection is still warming), currently found ${knownRepoText}`
      : "Unknown (git repository detection still warming)"
    : hasGitRepos
      ? `Yes, ${knownRepoText}`
      : "No";
  const shouldShowNonPrimaryWorktreeWarning = !hasGitRepos && gitRepoInfoComplete !== false;
  const mountedAgentStores = env.mountedAgentStores ?? [];
  if (dsv3) {
    const shouldShowAgentNotesPaths = mode === AgentMode.PROJECT || metaAgentNotesEnabled === true;
    return jsxs("section", {
      title: "user_info",
      children: [
        jsxs("p", { children: ["OS Version: ", env.osVersion] }),
        jsxs("p", { children: ["Shell: ", env.shell ?? "bash"] }),
        env.workspacePaths.length > 1
          ? jsxs("p", { children: ["Workspace Paths:", jsx("br", {}), env.workspacePaths.map(p => `- ${p}`).join("\n")] })
          : env.workspacePaths.length === 1
            ? jsxs("p", {
              children: [
                "Workspace Path: ",
                env.workspacePaths[0]!,
                isWorktreesPath(env.workspacePaths[0]!) && jsxs(Fragment, {
                  children: [jsx("br", {}), "You are operating in a Cursor worktree, do not edit files outside of it unless explicitly asked to do so by the user."],
                }),
                shouldShowNonPrimaryWorktreeWarning && jsxs(Fragment, {
                  children: [jsx("br", {}), "If editing a git workspace within your current directory, do not search or edit non-primary worktrees unless the user explicitly requests you to do so."],
                }),
                shouldShowNonPrimaryWorktreeWarning && env.isWorkingDirHomeDir === true && jsxs(Fragment, {
                  children: [jsx("br", {}), "This applies especially to Cursor-managed worktrees in ~/.cursor/worktrees."],
                }),
              ],
            })
            : jsx("p", { children: "Workspace Path: unknown" }),
        displayGitRepoStatusLine && jsxs("p", { children: ["Is directory a git repo: ", gitRepoStatusText] }),
        terminalsFolder && jsxs("p", { children: ["Terminals folder: ", terminalsFolder] }),
        mountedAgentStores.length > 0 && jsx(MountedAgentStoresSection as unknown as (props: Record<string, unknown>) => PromptNode, { stores: mountedAgentStores }),
        displayTodaysDate && jsxs("p", { children: ["Today's date: ", todaysDate] }),
        shouldShowAgentNotesPaths && metaAgentNotesEnabled !== true && agentSharedNotesFolder && jsxs("p", { children: ["Agent shared notes folder: ", agentSharedNotesFolder] }),
        shouldShowAgentNotesPaths && (metaAgentNotesEnabled === true ? metaAgentNotesDirectory : agentConversationNotesFolder) && jsx("p", { children: metaAgentNotesEnabled === true ? `Meta-agent notes folder: ${metaAgentNotesDirectory}` : `Agent conversation notes folder: ${agentConversationNotesFolder}` }),
        jsx("p", { children: "Note: Prefer using absolute paths over relative paths as tool call args when possible." }),
      ],
    });
  }
  return jsxs("section", {
    title: "user_info",
    children: [
      jsxs("p", { children: ["OS Version: ", env.osVersion] }),
      jsxs("p", { children: ["Shell: ", env.shell ?? "bash"] }),
      env.workspacePaths.length > 1
        ? jsxs("p", { children: ["Workspace Paths:", jsx("br", {}), env.workspacePaths.map(p => `- ${p}`).join("\n")] })
        : env.workspacePaths.length === 1
          ? jsxs("p", {
            children: [
              "Workspace Path: ",
              env.workspacePaths[0]!,
              isWorktreesPath(env.workspacePaths[0]!) && jsxs(Fragment, {
                children: [jsx("br", {}), "You are operating in a Cursor worktree, do not edit files outside of it unless explicitly asked to do so by the user."],
              }),
              shouldShowNonPrimaryWorktreeWarning && jsxs(Fragment, {
                children: [jsx("br", {}), "If editing a git workspace within your current directory, do not search or edit non-primary worktrees unless the user explicitly requests you to do so."],
              }),
              shouldShowNonPrimaryWorktreeWarning && env.isWorkingDirHomeDir === true && jsxs(Fragment, {
                children: [jsx("br", {}), "This applies especially to Cursor-managed worktrees in ~/.cursor/worktrees."],
              }),
            ],
          })
          : jsx("p", { children: "Workspace Path: unknown" }),
      displayGitRepoStatusLine && jsxs("p", { children: ["Is directory a git repo: ", gitRepoStatusText] }),
      displayTodaysDate && jsxs("p", { children: ["Today's date: ", todaysDate] }),
      terminalsFolder && jsxs("p", { children: ["Terminals folder: ", terminalsFolder] }),
      mountedAgentStores.length > 0 && jsx(MountedAgentStoresSection as unknown as (props: Record<string, unknown>) => PromptNode, { stores: mountedAgentStores }),
      agentSharedNotesFolder && metaAgentNotesEnabled !== true && jsxs("p", { children: ["Agent shared notes folder: ", agentSharedNotesFolder] }),
      (metaAgentNotesEnabled === true ? metaAgentNotesDirectory : agentConversationNotesFolder) && jsx("p", { children: metaAgentNotesEnabled === true ? `Meta-agent notes folder: ${metaAgentNotesDirectory}` : `Agent conversation notes folder: ${agentConversationNotesFolder}` }),
    ],
  });
}
