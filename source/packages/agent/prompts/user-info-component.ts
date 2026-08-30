import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.js";
import type { BackgroundComposerSource } from "../../proto/generated/aiserver/v1/background_composer_pb.js";
import type { AgentSkill } from "../../proto/generated/agent/v1/agent_skills_pb.js";
import type { CursorRule } from "../../proto/generated/agent/v1/cursor_rules_pb.js";
import type { GitRepoInfo, RequestContextEnv } from "../../proto/generated/agent/v1/request_context_exec_pb.js";
import type { McpDescriptor, McpFileSystemOptions, McpInstructions } from "../../proto/generated/agent/v1/mcp_pb.js";
import { jsx as promptJsx, jsxs as promptJsxs, Fragment } from "../../prompt-jsx/jsx-runtime.js";
import type { PromptNode, PromptProps } from "../../prompt-jsx/jsx-runtime.js";
import { renderContent } from "../../prompt-jsx/render.js";
import { AgentType } from "../utils/agent-config.js";
import { materializeAutomationMemoryInstruction } from "./bugbot/automations.js";
import { isNamedAgentHomePromptSession } from "./cloud-meta-agent/index.js";
import { getComposer2CloudTestingSectionElements, getComposer2CloudTestingSectionsPlacement } from "./composer2-cloud-testing-sections.js";
import { CloudInstructionsSection, CloudTaskInstructions } from "./user-info-cloud-sections.js";
import { UserIntentSection, HooksAdditionalContextSection, AutomationInstructionsSection, MetaAgentProjectNotesDirectorySection, AvailableSubagentModelsSection, AvailableSubagentTypesSection } from "./user-info-auxiliary-sections.js";
import { AgentTranscriptsSection } from "./user-info-transcripts.js";
import { GitStatusSection } from "./user-info-git-status.js";
import { buildAvailableSkillsPromptSection } from "./user-info-available-skills.js";
import { McpInstructionsSection } from "./user-info-mcp-instructions.js";
import { McpMetaToolInstructions } from "./user-info-mcp-meta-instructions.js";
import { McpMetaToolServersSection, filterProjectWorkspaceMutationMcpDescriptors } from "./user-info-mcp-catalog.js";
import { resolveMetaAgentNotesDirectory } from "./user-info-notes.js";
import { UserInfoSection } from "./user-info-section.js";
import { getFriendlyDateForTimeZone } from "./user-info-date.js";
import { buildRulesPromptSection } from "./user-info-composer2-rules.js";
import { categorizeCursorRules } from "./user-info-rule-categorization.js";
import { getDsv3McpFileSystemInstructions } from "../utils/mcp-file-system.js";

const jsx = (type: unknown, props: PromptProps) => promptJsx(type as never, props);
const jsxs = (type: unknown, props: PromptProps) => promptJsxs(type as never, props);

interface UserInfoToolInfo {
  readonly allTools?: Record<string, { readonly name?: string | undefined } | undefined>;
  readonly availableSubagentTypesDescription?: string | undefined;
  readonly availableSubagentModelsDescription?: string | undefined;
  readonly [key: string]: unknown;
}

interface UserInfoModelInfo {
  readonly modelName?: string | undefined;
  readonly promptVersion?: string | undefined;
  readonly isComposerMatterhorn?: boolean | undefined;
  readonly isRawTrainingSlug?: boolean | undefined;
  readonly isGrok45ProductPrompt?: boolean | undefined;
  readonly isComposer2?: boolean | undefined;
  readonly isComposer15?: boolean | undefined;
  readonly isGpt56?: boolean | undefined;
  readonly [key: string]: unknown;
}

interface UserInfoDisplayOptions {
  readonly includeOnlyUserInfoAndGitStatus?: boolean | undefined;
  readonly displayTodaysDate?: boolean | undefined;
  readonly displayGitRepoStatusLine?: boolean | undefined;
  readonly displayGitStatus?: boolean | undefined;
  readonly excludeAgentTranscripts?: boolean | undefined;
  readonly displayCursorRules?: boolean | undefined;
  readonly displaySkills?: boolean | undefined;
  readonly computerUseSubagentSurface?: boolean | undefined;
  readonly agentType?: AgentType | undefined;
}

interface UserInfoFeatureFlags {
  readonly dropCustomPromptContext?: boolean | undefined;
  readonly shiftDsv3McpFilesInstructionsToUserMsg?: boolean | undefined;
  readonly backgroundComposerMultiPrs?: boolean | undefined;
  readonly cloudAgentStaleBuildGitRefs?: string | undefined;
  readonly enableAgentChatLinks?: boolean | undefined;
  readonly protectLoopSkillDescription?: boolean | undefined;
  readonly prCreationForgeGuidance?: boolean | undefined;
  readonly enableAntiAskQuestionUserRule?: boolean | undefined;
  readonly enableMCPFileSystem?: boolean | undefined;
  readonly enableTahomaUserRuleIntervention?: boolean | undefined;
  readonly enableVegaFrontendUserRuleIntervention?: boolean | undefined;
  readonly enableComposer2CustomUserRules?: boolean | undefined;
  readonly enableMatterhornPromptTweaks?: boolean | undefined;
  readonly enableGrepBroadGlobGuard?: boolean | undefined;
  readonly grokCloudTestingInSystemPrompt?: boolean | undefined;
  readonly [key: string]: unknown;
}

interface UserInfoMcpMetaToolOptions {
  readonly enabled: boolean;
  readonly mcpDescriptors: readonly McpDescriptor[];
  readonly snapshotToolNames?: {
    readonly discoveryToolName?: string | undefined;
    readonly invocationToolName?: string | undefined;
    readonly useDynamicToolNamespaces?: boolean | undefined;
    readonly fetchMcpResourceToolName?: string | undefined;
    readonly listMcpResourcesToolName?: string | undefined;
  } | undefined;
}

export interface UserInfoProps {
  readonly cursorRules: CursorRule[];
  readonly agentSkills?: AgentSkill[] | undefined;
  readonly env?: RequestContextEnv | undefined;
  readonly dsv3?: boolean | undefined;
  readonly mode?: AgentMode | undefined;
  readonly gitRepos?: GitRepoInfo[] | undefined;
  readonly gitRepoInfoComplete?: boolean | undefined;
  readonly terminalsFolder?: string | undefined;
  readonly agentSharedNotesFolder?: string | undefined;
  readonly agentConversationNotesFolder?: string | undefined;
  readonly metaAgentNotesEnabled?: boolean | undefined;
  readonly notesSessionId?: string | undefined;
  readonly featureFlags?: UserInfoFeatureFlags | undefined;
  readonly modelInfo?: UserInfoModelInfo | undefined;
  readonly displayOptions?: UserInfoDisplayOptions | undefined;
  readonly toolInfo?: UserInfoToolInfo | undefined;
  readonly backgroundAgentSource?: BackgroundComposerSource | undefined;
  readonly agentType?: AgentType | undefined;
  readonly cloudRule?: string | undefined;
  readonly mcpInstructions?: readonly McpInstructions[] | undefined;
  readonly mcpMetaToolOptions?: UserInfoMcpMetaToolOptions | undefined;
  readonly mcpFileSystemOptions?: McpFileSystemOptions | undefined;
  readonly mcpInfoComplete?: boolean | undefined;
  readonly enableFilterEditToolsInAskMode?: boolean | undefined;
  readonly isRootProject?: boolean | undefined;
  readonly userIntentSummary?: string | undefined;
  readonly hooksAdditionalContext?: string | undefined;
  readonly automationInstructions?: string | undefined;
  readonly namedAgentSelfDocumentBlock?: string | undefined;
  readonly agentTranscriptsFolder?: string | undefined;
  readonly enableComposer2IntelligentTestingPromptSection?: boolean | undefined;
  readonly agentTokenLimit?: number | undefined;
  readonly isSlackV1_5?: boolean | undefined;
  readonly enableCloudTesting?: boolean | undefined;
  readonly priorUserInfoCloudTestingSectionsPlacement?: string | undefined;
  readonly namedAgentSessionKind?: string | undefined;
  readonly isCloudMetaAgentParent?: boolean | undefined;
  readonly subagentType?: { readonly type?: { readonly case?: string | undefined } | undefined } | undefined;
  readonly useLocalAgentPrompting?: boolean | undefined;
  readonly omitCloudWorkerProcedure?: boolean | undefined;
  readonly designatedBranches?: readonly { readonly path?: string | undefined; readonly repoPath?: string | undefined; readonly branchName?: string | undefined; readonly baseBranch?: string | undefined; readonly remoteUrl?: string | undefined }[] | undefined;
  readonly branchPrefix?: string | undefined;
  readonly branchSuffix?: string | undefined;
  readonly preferCurrentBranchInMultiPrMode?: boolean | undefined;
  readonly browserTools?: readonly string[] | undefined;
  readonly isRepoless?: boolean | undefined;
  readonly skipMcpInstructions?: boolean | undefined;
}

function UserInfoComponent({ props }: { readonly props: UserInfoProps }): PromptNode {
  const dropCustomPromptContext = props.featureFlags?.dropCustomPromptContext === true;
  const gitRepos = props.gitRepos ?? [];
  const hasGitRepos = gitRepos.length > 0;
  const gitRepoInfoComplete = props.gitRepoInfoComplete;
  const workspacePaths = props.env?.workspacePaths ?? [];
  const { globalRules, agentRequestableRules, userRules, skills } = categorizeCursorRules(props.cursorRules, workspacePaths, props.displayOptions?.agentType);
  const readToolName = props.toolInfo?.allTools?.READ?.name;
  const awaitToolName = props.toolInfo?.allTools?.AWAIT?.name;
  const shellToolName = props.toolInfo?.allTools?.SHELL?.name;
  const grepToolName = props.toolInfo?.allTools?.GREP?.name;
  const { section: rulesSection } = buildRulesPromptSection(props as Parameters<typeof buildRulesPromptSection>[0], {
    categorizedRules: { globalRules, agentRequestableRules, userRules, skills },
    readToolName,
    awaitToolName,
    shellToolName,
    grepToolName,
  } as never);
  const { section: availableSkillsSection } = buildAvailableSkillsPromptSection(props, { skills, readToolName });
  const todaysDate = getFriendlyDateForTimeZone(props.env?.timeZone);
  const cloudRuleContent = props.cloudRule?.trim() ?? "";
  const disableMcpForRawMatterhorn = props.modelInfo?.isComposerMatterhorn === true && props.modelInfo.isRawTrainingSlug === true;
  const mcpEntries = disableMcpForRawMatterhorn ? [] : (props.mcpInstructions ?? []).filter(i => typeof i?.instructions === "string" && i.instructions.trim().length > 0);
  const shouldFilterEditToolsInAskMode = props.mode === AgentMode.ASK && (props.enableFilterEditToolsInAskMode ?? true);
  const shouldRestrictProjectWorkspace = props.mode === AgentMode.PROJECT || props.isRootProject === true;
  const mcpMetaToolOptions = shouldRestrictProjectWorkspace && props.mcpMetaToolOptions !== undefined
    ? { ...props.mcpMetaToolOptions, mcpDescriptors: filterProjectWorkspaceMutationMcpDescriptors(props.mcpMetaToolOptions.mcpDescriptors) }
    : props.mcpMetaToolOptions;
  const shouldShowMcpMetaToolSnapshot = mcpMetaToolOptions?.enabled === true && mcpMetaToolOptions.mcpDescriptors.length > 0 && !disableMcpForRawMatterhorn && !shouldFilterEditToolsInAskMode;
  const dsv3McpMetaFullInstructionsBlock = props.dsv3 === true && shouldShowMcpMetaToolSnapshot && mcpMetaToolOptions !== undefined
    ? McpMetaToolInstructions(mcpMetaToolOptions.mcpDescriptors, {
      discoveryToolName: mcpMetaToolOptions.snapshotToolNames?.discoveryToolName ?? "GetMcpTools",
      invocationToolName: mcpMetaToolOptions.snapshotToolNames?.invocationToolName ?? "CallMcpTool",
      useDynamicToolNamespaces: mcpMetaToolOptions.snapshotToolNames?.useDynamicToolNamespaces ?? false,
      ...(mcpMetaToolOptions.snapshotToolNames?.fetchMcpResourceToolName ? { fetchMcpResourceToolName: mcpMetaToolOptions.snapshotToolNames.fetchMcpResourceToolName } : mcpMetaToolOptions.snapshotToolNames?.useDynamicToolNamespaces ? {} : { fetchMcpResourceToolName: "FetchMcpResource" }),
      ...(mcpMetaToolOptions.snapshotToolNames?.listMcpResourcesToolName ? { listMcpResourcesToolName: mcpMetaToolOptions.snapshotToolNames.listMcpResourcesToolName } : {}),
    })
    : "";
  const shouldShiftDsv3McpFilesInstructionsToUserMsg = props.featureFlags?.shiftDsv3McpFilesInstructionsToUserMsg === true;
  const mcpInstructionsForUserMsg = props.dsv3 === true && shouldShiftDsv3McpFilesInstructionsToUserMsg && !disableMcpForRawMatterhorn
    ? getDsv3McpFileSystemInstructions({
      mode: props.mode,
      enableFilterEditToolsInAskMode: props.enableFilterEditToolsInAskMode,
      mcpFileSystemOptions: props.mcpFileSystemOptions,
      mcpMetaToolOptions: mcpMetaToolOptions ? { enabled: mcpMetaToolOptions.enabled, mcpDescriptors: mcpMetaToolOptions.mcpDescriptors } as never : undefined,
      featureFlags: props.featureFlags,
      modelInfo: props.modelInfo,
    })
    : "";
  const mcpInstructionsBlock = mcpInstructionsForUserMsg.length > 0 ? `\n\n${mcpInstructionsForUserMsg}` : "";
  const gitReposWithStatus = gitRepos.filter(repo => !!repo.status);
  const userIntentContent = props.userIntentSummary?.trim() ?? "";
  const includeOnlyUserInfoAndGitStatus = props.displayOptions?.includeOnlyUserInfoAndGitStatus === true;
  const displayTodaysDate = props.displayOptions?.displayTodaysDate !== false;
  const displayGitRepoStatusLine = props.displayOptions?.displayGitRepoStatusLine !== false;
  const useLocalAgentPrompting = props.useLocalAgentPrompting === true;
  const isNamedAgentHome = isNamedAgentHomePromptSession(props);
  const resolvedAgentType = useLocalAgentPrompting ? AgentType.IDE : props.agentType ?? props.displayOptions?.agentType;
  const initialWorkingDirectory = props.env?.processWorkingDirectory?.trim() || undefined;
  const shouldRenderCloudTaskInstructions = props.designatedBranches !== undefined && props.omitCloudWorkerProcedure !== true && !useLocalAgentPrompting && !isNamedAgentHome && props.displayOptions?.computerUseSubagentSurface !== true;
  const metaAgentNotesDirectory = resolveMetaAgentNotesDirectory(props);
  if (includeOnlyUserInfoAndGitStatus) {
    return jsxs(Fragment, { children: [
      props.toolInfo?.availableSubagentTypesDescription !== undefined && jsx(AvailableSubagentTypesSection, { description: props.toolInfo.availableSubagentTypesDescription }),
      props.toolInfo?.availableSubagentModelsDescription !== undefined && jsx(AvailableSubagentModelsSection, { description: props.toolInfo.availableSubagentModelsDescription }),
      props.env !== undefined && jsx(UserInfoSection, { env: props.env, dsv3: props.dsv3, mode: props.mode, hasGitRepos, gitRepoInfoComplete, gitRepos, todaysDate, terminalsFolder: props.terminalsFolder, agentSharedNotesFolder: props.agentSharedNotesFolder, agentConversationNotesFolder: props.agentConversationNotesFolder, metaAgentNotesDirectory, metaAgentNotesEnabled: props.metaAgentNotesEnabled, displayTodaysDate, displayGitRepoStatusLine }),
      metaAgentNotesDirectory !== undefined && jsx(MetaAgentProjectNotesDirectorySection, { notesDirectory: metaAgentNotesDirectory }),
      props.displayOptions?.displayGitStatus !== false && gitReposWithStatus.length > 0 && jsx(GitStatusSection, { gitRepos, gitReposWithStatus, initialWorkingDirectory, agentType: resolvedAgentType, toolInfo: props.toolInfo }),
    ] });
  }
  const computerUseSubagentSurface = props.displayOptions?.computerUseSubagentSurface === true;
  const composer2CloudTestingSections = !computerUseSubagentSurface && props.omitCloudWorkerProcedure !== true && getComposer2CloudTestingSectionsPlacement(props as never) === "user_info" ? getComposer2CloudTestingSectionElements(props as never) : undefined;
  const automationInstructions = props.automationInstructions === undefined ? undefined : materializeAutomationMemoryInstruction(props.automationInstructions, props.env?.mountedAgentStores ?? []);
  return jsxs(Fragment, { children: [
    props.env !== undefined && jsx(UserInfoSection, { env: props.env, dsv3: props.dsv3, mode: props.mode, hasGitRepos, gitRepoInfoComplete, gitRepos, todaysDate, terminalsFolder: props.terminalsFolder, agentSharedNotesFolder: props.agentSharedNotesFolder, agentConversationNotesFolder: props.agentConversationNotesFolder, metaAgentNotesDirectory, metaAgentNotesEnabled: props.metaAgentNotesEnabled, displayTodaysDate, displayGitRepoStatusLine }),
    props.namedAgentSelfDocumentBlock !== undefined && jsx("p", { children: props.namedAgentSelfDocumentBlock }),
    metaAgentNotesDirectory !== undefined && jsx(MetaAgentProjectNotesDirectorySection, { notesDirectory: metaAgentNotesDirectory }),
    userIntentContent.length > 0 && jsx(UserIntentSection, { content: userIntentContent }),
    props.displayOptions?.displayGitStatus !== false && gitReposWithStatus.length > 0 && jsx(GitStatusSection, { gitRepos, gitReposWithStatus, initialWorkingDirectory, agentType: resolvedAgentType, toolInfo: props.toolInfo }),
    composer2CloudTestingSections?.gitAndSubmission,
    !props.displayOptions?.excludeAgentTranscripts && props.env?.agentTranscriptsFolder && props.displayOptions?.agentType !== AgentType.BACKGROUND && jsx(AgentTranscriptsSection, { agentTranscriptsFolder: props.env.agentTranscriptsFolder, agentType: props.displayOptions?.agentType, enableAgentChatLinks: props.featureFlags?.enableAgentChatLinks !== false }),
    !computerUseSubagentSurface && !dropCustomPromptContext && rulesSection,
    !computerUseSubagentSurface && props.toolInfo?.availableSubagentTypesDescription !== undefined && jsx(AvailableSubagentTypesSection, { description: props.toolInfo.availableSubagentTypesDescription }),
    !computerUseSubagentSurface && props.toolInfo?.availableSubagentModelsDescription !== undefined && jsx(AvailableSubagentModelsSection, { description: props.toolInfo.availableSubagentModelsDescription }),
    !computerUseSubagentSurface && !dropCustomPromptContext && availableSkillsSection,
    !computerUseSubagentSurface && cloudRuleContent.length > 0 && jsx(CloudInstructionsSection, { cloudRuleContent }),
    composer2CloudTestingSections?.testing,
    composer2CloudTestingSections?.computerUse,
    shouldRenderCloudTaskInstructions && jsx(CloudTaskInstructions, { gitRepos, designatedBranches: props.designatedBranches, branchPrefix: props.branchPrefix, branchSuffix: props.branchSuffix, preferCurrentBranchInMultiPrMode: props.preferCurrentBranchInMultiPrMode, allowMultipleBranches: props.featureFlags?.backgroundComposerMultiPrs ?? false, toolInfo: props.toolInfo, staleBuildGitRefs: props.featureFlags?.cloudAgentStaleBuildGitRefs }),
    !computerUseSubagentSurface && !dropCustomPromptContext && mcpInstructionsBlock,
    !computerUseSubagentSurface && !dropCustomPromptContext && dsv3McpMetaFullInstructionsBlock.length > 0 && dsv3McpMetaFullInstructionsBlock,
    !computerUseSubagentSurface && !dropCustomPromptContext && shouldShowMcpMetaToolSnapshot && props.dsv3 !== true && mcpMetaToolOptions !== undefined && jsx(McpMetaToolServersSection, { mcpMetaToolOptions, mcpInfoComplete: props.mcpInfoComplete }),
    !computerUseSubagentSurface && !dropCustomPromptContext && !props.skipMcpInstructions && mcpEntries.length > 0 && jsx(McpInstructionsSection, { mcpEntries }),
    props.hooksAdditionalContext && props.hooksAdditionalContext.trim().length > 0 && jsx(HooksAdditionalContextSection, { content: props.hooksAdditionalContext }),
    automationInstructions !== undefined && automationInstructions.trim().length > 0 && jsx(AutomationInstructionsSection, { content: automationInstructions }),
  ] });
}

export function UserInfo(props: UserInfoProps): string {
  return renderContent(jsx(UserInfoComponent, { props }));
}
