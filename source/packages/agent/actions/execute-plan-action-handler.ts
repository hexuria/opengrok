import grayMatter from "gray-matter";
import { randomUUID } from "node:crypto";
import {
  AgentMode,
  ExecutePlanInfo,
  PlanRegistryEntry,
  ProjectDetails,
  SimulatedMsgReason,
  UserMessage,
} from "../../proto/generated/agent/v1/agent_pb.js";
import { TodoItem, TodoStatus } from "../../proto/generated/agent/v1/todo_tool_pb.js";
import { SelectedCodeSelection, SelectedContext } from "../../proto/generated/agent/v1/selected_context_pb.js";
import { Position, Range } from "../../proto/generated/agent/v1/utils_pb.js";
import { fromRedactedRequestContext } from "../../redacted-protos/generated/agent/v1/request_context_exec_redacted.js";
import { fromRedactedCoreMessage, toRedactedCoreMessages } from "../../redaction/core-message.js";
import { createRedactedString } from "../../redaction/factory.js";
import { DataClassification, PrivacyCapability } from "../../redaction/classification.js";
import { createLogger } from "../../context/logger.js";
import { createSpan } from "../../context/otel.js";
import { Updates } from "../../agent-core/interaction-updates.js";
import { toRedactedInteractionUpdate } from "../../redacted-protos/generated/agent/v1/agent_redacted.js";
import { toRedactedTodoItem } from "../../redacted-protos/generated/agent/v1/todo_tool_redacted.js";
import { FileOperationLockManager } from "../tools/core/file-operation-lock-manager.js";
import { extractToolInfo } from "../prompts/system.js";
import { getBrowserToolNames } from "../common.js";
import { getAllRules } from "./common.js";
import { buildRequestContextOptions, buildUserInfoAgentNotesProps } from "./meta-agent-notes.js";
import { resolveRequestContext } from "../utils/request-context.js";
import { isProjectWorkspaceConversation } from "../configs/project-workspace-mcp-tools.js";
import { resolveProjectConversationContext, shouldOmitCloudWorkerProcedure } from "../utils/project-conversation.js";
import { getNamedAgentSessionPromptContext, isNamedAgentHomePromptSession } from "../prompts/cloud-meta-agent/index.js";
import { AgentType } from "../utils/agent-config.js";
import { getComposer2CloudTestingSectionsPlacement } from "../prompts/composer2-cloud-testing-sections.js";
import { UserInfo } from "../prompts/user-info-component.js";
import { withToolSetMcpSnapshot } from "../utils/mcp-meta-tool.js";
import { getMcpMetaToolOptionsWithCustomUserTools } from "../utils/mcp-custom-user-tools.js";
import { getRequestContextCompleteness, shouldRerenderUserInfoAfterSummarization, shouldRerenderUserInfoForRequestContextRecovery, parseRequestContextCompletenessMetadata, parseUserInfoSummarizationEpochMetadata, userInfoMatchesAvailableSubagentModels, userInfoMatchesAvailableSubagentTypes, userInfoMatchesDynamicToolSnapshot } from "../prompts/shared.js";
import { getConversationId, getRequestId } from "../utils/request-id.js";
import { getAgentEventTracker } from "../utils/event-tracking.js";
import { stringToTodoStatus } from "../tools/core/todo/common.js";
import { getFirstUserInfoCloudTestingSectionsPlacement } from "../prompts/user-info-preparation.js";
import { resolvePlanFilePath as resolvePlanFilePathHelper } from "./execute-plan-plan-file.js";
import { AbstractUserMessageActionHandler } from "./user-message-action/abstract-user-message-action-handler.js";

type Any = any;

const logger64 = createLogger("@anysphere/agent:execute-plan");

function userMessagePlainText(message: Any): string | undefined {
  const content = message.content;
  if (typeof content === "string") return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content.filter((part: Any) => part.type === "text").map((part: Any) => part.text).join("\n");
  return text.length > 0 ? text : undefined;
}

function getRequestContextCompletenessAny(requestContext: Any): Any {
  return getRequestContextCompleteness(requestContext);
}

export class ExecutePlanActionHandler extends AbstractUserMessageActionHandler {
  shouldRerenderUserInfo(priorMessages: readonly Any[], stateHandler: Any, options: Any): boolean {
    if (priorMessages.length === 0) return false;
    const firstMsg = priorMessages[0];
    if (firstMsg.role !== "user") return false;
    const plainFirst = fromRedactedCoreMessage(firstMsg, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    const contentStr = userMessagePlainText(plainFirst);
    if (contentStr?.includes("<user_info>") !== true) return false;
    return stateHandler.hasAgentTypeChangedFromPersistedState() ||
      !userInfoMatchesAvailableSubagentModels(contentStr, options.availableSubagentModelsDescription) ||
      !userInfoMatchesAvailableSubagentTypes(contentStr, options.availableSubagentTypesDescription) ||
      !userInfoMatchesDynamicToolSnapshot(contentStr, options.mcpMetaToolOptions);
  }

  getFirstUserInfoRequestContextCompleteness(priorMessages: readonly Any[]): Any {
    const firstMsg = priorMessages[0];
    if (firstMsg?.role !== "user") return undefined;
    return parseRequestContextCompletenessMetadata(firstMsg.providerOptions?.cursor?.requestContextCompleteness);
  }

  getFirstUserInfoSummarizationEpoch(priorMessages: readonly Any[]): Any {
    const firstMsg = priorMessages[0];
    if (firstMsg?.role !== "user") return undefined;
    return parseUserInfoSummarizationEpochMetadata(firstMsg.providerOptions?.cursor?.userInfoSummarizationEpoch);
  }

  getFirstUserInfoOmitCloudWorkerProcedure(priorMessages: readonly Any[]): boolean {
    return priorMessages[0]?.providerOptions?.cursor?.omitCloudWorkerProcedure === true;
  }

  async resolvePlanFilePath(ctx: Any, requestContext: Any, action: Any, planFileContent: string): Promise<Any> {
    const planFileResourceAccessor: Any = this.resourceAccessor;
    const planFileAction: Any = action;
    return resolvePlanFilePathHelper(ctx, requestContext, planFileResourceAccessor, planFileAction, planFileContent);
  }

  async initializeConversation(ctx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any): Promise<Any> {
    const configAny: Any = this.config;
    const { requestContext, provenance: requestContextProvenance } = await resolveRequestContext({
      parentCtx: ctx,
      ...(action.requestContext ? { maybeRequestContext: fromRedactedRequestContext(action.requestContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined) } : {}),
      resources: this.resourceAccessor,
      options: buildRequestContextOptions(configAny),
    });
    const unredResolvedPlanContent = action.planFileContent?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) ?? (stateHandler.plan ? (await stateHandler.plan.get(ctx)).plan.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) : undefined);
    let planMarksProject = false;
    try {
      planMarksProject = unredResolvedPlanContent !== undefined && grayMatter(unredResolvedPlanContent).data.isProject === true;
    } catch {
    }
    let isRootProject = configAny.agentType === AgentType.IDE && await isProjectWorkspaceConversation(ctx, stateHandler);
    isRootProject ||= configAny.agentType === AgentType.IDE && planMarksProject;
    const executionMode = action.executionMode !== undefined && action.executionMode !== AgentMode.UNSPECIFIED ? action.executionMode : AgentMode.AGENT;
    const projectConversationContext = await resolveProjectConversationContext(ctx, stateHandler);
    const omitCloudWorkerProcedure = shouldOmitCloudWorkerProcedure({
      gateEnabled: configAny.featureFlags?.projectRootCoordinatorPrompt === true,
      agentType: configAny.agentType,
      mode: executionMode,
      useLocalAgentPrompting: configAny.useLocalAgentPrompting === true,
      isNamedAgentSession: getNamedAgentSessionPromptContext(configAny) !== undefined || isNamedAgentHomePromptSession(configAny),
      isRootProject: projectConversationContext.hasProjectBoundary ? projectConversationContext.isRootProject : planMarksProject,
    });
    const rules = getAllRules(requestContext, configAny.nonFileRules, configAny.featureFlags);
    const mergedMcpTools = this.mergeRequestContextTools(mcpTools, requestContext.tools);
    const toolSetHandle = configAny.toolsGenerator({
      resourceAccessor: this.resourceAccessor,
      stateHandler,
      agentSessionId: configAny.agentSessionId,
      mcpTools: mergedMcpTools,
      repositoryInfos: requestContext.repositoryInfo,
      blobStore: stateHandler.getBlobStore(),
      mode: executionMode,
      loggingContext: ctx,
      requestContext,
      fileOperationLockManager: new FileOperationLockManager(),
      smartModeClassifierMode: configAny.smartModeClassifierMode,
      smartModeClassifierShadowMode: configAny.smartModeClassifierShadowMode,
      autoRejectFirstAskQuestion: configAny.autoRejectFirstAskQuestion,
    });
    const toolInfo: Any = extractToolInfo(toolSetHandle);
    const priorMessages = rootPromptExecutor.getMessages().filter((message: Any) => message.role !== "system");
    const hasExistingNonSystemMessages = priorMessages.length > 0;
    const firstUserInfoRequestContextCompleteness = this.getFirstUserInfoRequestContextCompleteness(priorMessages);
    const requestContextCompleteness = getRequestContextCompletenessAny(requestContext);
    const userInfoMcpMetaToolOptions = withToolSetMcpSnapshot(getMcpMetaToolOptionsWithCustomUserTools(requestContext.mcpMetaToolOptions, mergedMcpTools), toolSetHandle);
    const needsUserInfoRerender = this.shouldRerenderUserInfo(priorMessages, stateHandler, {
      availableSubagentModelsDescription: toolInfo.availableSubagentModelsDescription,
      availableSubagentTypesDescription: toolInfo.availableSubagentTypesDescription,
      mcpMetaToolOptions: userInfoMcpMetaToolOptions,
    });
    const needsRequestContextRecoveryRerender = configAny.featureFlags?.rerenderUserInfoOnRequestContextRecovery === true && shouldRerenderUserInfoForRequestContextRecovery({ previousCompleteness: firstUserInfoRequestContextCompleteness, currentCompleteness: requestContextCompleteness });
    const currentSummarizationEpoch = stateHandler.summaryArchives.length;
    const needsSummarizationRerender = configAny.featureFlags?.rerenderUserInfoOnSummarization === true && shouldRerenderUserInfoAfterSummarization({ previousEpoch: this.getFirstUserInfoSummarizationEpoch(priorMessages), currentEpoch: currentSummarizationEpoch });
    const priorUserInfoCloudTestingSectionsPlacement = getFirstUserInfoCloudTestingSectionsPlacement(priorMessages);
    const userInfoCloudTestingSectionsPlacement = getComposer2CloudTestingSectionsPlacement({
      modelInfo: configAny.modelInfo,
      enableComposer2IntelligentTestingPromptSection: configAny.enableComposer2IntelligentTestingPromptSection,
      backgroundAgentSource: configAny.backgroundAgentSource,
      agentType: configAny.agentType,
      enableCloudTesting: configAny.enableCloudTesting,
      featureFlags: configAny.featureFlags,
      namedAgentSessionKind: configAny.namedAgentSessionKind,
      isCloudMetaAgentParent: configAny.isCloudMetaAgentParent,
      priorUserInfoCloudTestingSectionsPlacement,
    });
    const needsCloudTestingPlacementRerender = priorUserInfoCloudTestingSectionsPlacement === "system_prompt" && userInfoCloudTestingSectionsPlacement === "user_info";
    const needsOmitCloudWorkerProcedureRerender = hasExistingNonSystemMessages && this.getFirstUserInfoOmitCloudWorkerProcedure(priorMessages) !== omitCloudWorkerProcedure;
    const newMessages: Any[] = [{
      role: "system",
      content: configAny.systemPromptGenerator({ requestContext, cursorRules: rules, env: requestContext.env, cloudRule: requestContext.cloudRule ?? undefined, mode: executionMode, omitCloudWorkerProcedure, priorUserInfoCloudTestingSectionsPlacement }, toolSetHandle),
    }];
    let didReplaceUserInfo = false;
    if ((!hasExistingNonSystemMessages || needsUserInfoRerender || needsRequestContextRecoveryRerender || needsSummarizationRerender || needsCloudTestingPlacementRerender || needsOmitCloudWorkerProcedureRerender) && !configAny.userInfoDisplayOptions?.disable) {
      didReplaceUserInfo = hasExistingNonSystemMessages;
      if (didReplaceUserInfo) {
        const reasons: string[] = [];
        if (needsUserInfoRerender) reasons.push("agent_type_change");
        if (needsRequestContextRecoveryRerender) reasons.push("request_context_recovery");
        if (needsSummarizationRerender) reasons.push("summarization_epoch_advanced");
        if (needsCloudTestingPlacementRerender) reasons.push("cloud_testing_placement_recovery");
        if (needsOmitCloudWorkerProcedureRerender) reasons.push("omit_cloud_worker_procedure_change");
        logger64.info(ctx, "agent.user_info.rerendered", { reasons });
      }
      newMessages.push({
        role: "user",
        content: UserInfo({
          cursorRules: rules,
          agentSkills: requestContext.agentSkills,
          env: requestContext.env,
          cloudRule: requestContext.cloudRule ?? undefined,
          gitRepos: requestContext.gitRepos,
          gitRepoInfoComplete: requestContext.gitRepoInfoComplete,
          isRootProject,
          omitCloudWorkerProcedure,
          dsv3: stateHandler.isDsv3(),
          displayOptions: configAny.userInfoDisplayOptions,
          mcpInfoComplete: requestContext.mcpInfoComplete,
          mcpInstructions: requestContext.mcpInstructions,
          mcpFileSystemOptions: requestContext.mcpFileSystemOptions,
          mcpMetaToolOptions: userInfoMcpMetaToolOptions,
          userIntentSummary: requestContext.userIntentSummary,
          featureFlags: configAny.featureFlags,
          enableFilterEditToolsInAskMode: configAny.enableFilterEditToolsInAskMode,
          skipMcpInstructions: (requestContext.mcpFileSystemOptions?.enabled ?? false) || (userInfoMcpMetaToolOptions?.enabled ?? false),
          hooksAdditionalContext: requestContext.hooksAdditionalContext,
          automationInstructions: configAny.automationInstructions,
          ...(configAny.enableTerminalFiles !== false ? { terminalsFolder: requestContext.env?.terminalsFolder } : {}),
          ...buildUserInfoAgentNotesProps(configAny, executionMode, requestContext.env),
          designatedBranches: configAny.designatedBranches,
          branchPrefix: configAny.branchPrefix,
          branchSuffix: configAny.branchSuffix,
          preferCurrentBranchInMultiPrMode: configAny.preferCurrentBranchInMultiPrMode,
          toolInfo,
          browserTools: getBrowserToolNames(mcpTools),
          agentType: configAny.agentType,
          backgroundAgentSource: configAny.backgroundAgentSource,
          isSlackV1_5: configAny.isSlackV1_5,
          namedAgentSessionKind: configAny.namedAgentSessionKind,
          enableCloudTesting: configAny.enableCloudTesting,
          useLocalAgentPrompting: configAny.useLocalAgentPrompting,
          isRepoless: configAny.isRepoless,
          modelInfo: configAny.modelInfo,
          agentTokenLimit: configAny.agentTokenLimit,
          enableComposer2IntelligentTestingPromptSection: configAny.enableComposer2IntelligentTestingPromptSection,
          priorUserInfoCloudTestingSectionsPlacement,
        }),
        providerOptions: { cursor: { requestContextCompleteness, userInfoSummarizationEpoch: currentSummarizationEpoch, omitCloudWorkerProcedure, ...(userInfoCloudTestingSectionsPlacement !== undefined ? { composer2CloudTestingSectionsPlacement: userInfoCloudTestingSectionsPlacement } : {}) } },
      });
    }
    const effectivePriorMessages = didReplaceUserInfo ? priorMessages.slice(1) : priorMessages;
    rootPromptExecutor.clearMessages();
    rootPromptExecutor.appendMessages(toRedactedCoreMessages(newMessages, stateHandler.getPrivacyMode()));
    rootPromptExecutor.appendMessages(effectivePriorMessages);
    if (!unredResolvedPlanContent) throw new Error("No plan content available for ExecutePlanAction (missing state and planFileContent)");
    if (stateHandler.todos.length === 0) {
      try {
        const frontmatter = grayMatter(unredResolvedPlanContent).data;
        const rawTodos = Array.isArray(frontmatter.phases) ? frontmatter.phases.flatMap((phase: Any) => phase.todos ?? []) : Array.isArray(frontmatter.todos) ? frontmatter.todos : [];
        const validStatuses = new Set(["pending", "in_progress", "completed", "cancelled"]);
        const todoItems = rawTodos.filter((todo: Any) => todo.id && todo.content).map((todo: Any) => new TodoItem({ id: todo.id, content: todo.content, status: validStatuses.has(todo.status ?? "") ? stringToTodoStatus(todo.status) : TodoStatus.PENDING, createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()), dependencies: todo.dependencies ?? [] }));
        if (todoItems.length > 0) stateHandler.setTodos(todoItems.map((todo: Any) => toRedactedTodoItem(todo, stateHandler.getPrivacyMode())));
      } catch {
      }
    }
    const { planFilePath, recreatedPlanFilePath, shouldUpsertPlanRegistryEntry, availability: planFileAvailability } = await this.resolvePlanFilePath(ctx, requestContext, action, unredResolvedPlanContent);
    if (requestContext.env?.artifactsFolder !== undefined && action.planId && planFilePath && shouldUpsertPlanRegistryEntry) stateHandler.upsertPlanEntry(new PlanRegistryEntry({ id: action.planId, path: planFilePath }));
    const resolvedPlanContent = createRedactedString(unredResolvedPlanContent, DataClassification.CODE, "plan", action._privacyMode);
    if (stateHandler.plan) stateHandler.setPlan(undefined);
    const planTitle = resolvedPlanContent.safeTransform((content: string) => content.match(/^#\s*(.+)$/m)?.[1]?.trim() ?? "Plan");
    const planFileNote = planFileAvailability === "unavailable" ? "\n\nThe plan file is not available on disk in this environment. The attached plan content above is complete, so work from it directly and do not try to read the plan from a file." : recreatedPlanFilePath !== undefined ? `\n\nThe plan has been moved to ${recreatedPlanFilePath}` : "";
    const planInstruction = planTitle.safeTransform((title: string) => `${title}\n\nImplement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.${planFileNote}\n\nTo-do's from the plan have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the to-dos.`);
    const planFileContent = resolvedPlanContent.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED);
    const endLine = Math.max(1, resolvedPlanContent.split("\n").length);
    const selectedPlanPath = (planFileAvailability === "unavailable" ? undefined : planFilePath) ?? action.planFileUri?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) ?? "cursor-plan://plan.md";
    const selectedContext = new SelectedContext({ codeSelections: [new SelectedCodeSelection({ content: planFileContent, path: selectedPlanPath, range: new Range({ start: new Position({ line: 1, column: 0 }), end: new Position({ line: endLine, column: 0 }) }) })] });
    const messageId = action.kickoffMessageId ?? randomUUID();
    const userMessage = new UserMessage({ text: planInstruction.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED), messageId, selectedContext, mode: executionMode, ...(isRootProject ? { projectDetails: new ProjectDetails() } : {}), isSimulatedMsg: true, simulatedMsgReason: SimulatedMsgReason.PLAN_EXECUTION, ...(action.planId !== undefined && action.planId.length > 0 ? { executePlanInfo: new ExecutePlanInfo({ planId: action.planId, planTitle: planTitle.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) }) } : {}) });
    await this.interactionListener.sendUpdate(ctx, toRedactedInteractionUpdate(Updates.userMessageAppended(userMessage), stateHandler.getPrivacyMode()));
    const turn = await stateHandler.createAgentTurn(ctx, userMessage, requestContext, configAny, this.resourceAccessor);
    stateHandler.setMode(executionMode);
    return { turn, mergedMcpTools, requestContext, requestContextProvenance };
  }

  async handle(parentCtx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    const configAny: Any = this.config;
    using span = createSpan(parentCtx.withName("ExecutePlanActionHandler.handle"));
    const ctx = span.ctx;
    const { turn, mergedMcpTools, requestContext } = await this.initializeConversation(ctx, action, rootPromptExecutor, stateHandler, mcpTools);
    const planExecutionStartTime = performance.now();
    const initialTurnCount = stateHandler.turns.length;
    const initialTodos = await Promise.all(stateHandler.todos.map((todoRef: Any) => todoRef.get(ctx)));
    const initialTodoIds = initialTodos.map((todo: Any) => todo.id);
    await this.runTurnLoop(ctx, rootPromptExecutor, stateHandler, turn, configAny.toolsGenerator, mergedMcpTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    const finalTodos = await Promise.all(stateHandler.todos.map((todoRef: Any) => todoRef.get(ctx)));
    const finalStatusByTodoId = new Map(finalTodos.map((todo: Any) => [todo.id, todo.status]));
    getAgentEventTracker(ctx).trackPlanModeModelFinished(ctx, { durationInMode: Math.max(0, performance.now() - planExecutionStartTime), todosProposed: initialTodoIds.length, todosCompleted: initialTodoIds.filter((todoId: string) => finalStatusByTodoId.get(todoId) === TodoStatus.COMPLETED).length, userMessagesDuringExecution: Math.max(0, stateHandler.turns.length - initialTurnCount), modelName: configAny.modelId, requestId: getRequestId(ctx), conversationId: getConversationId(ctx), planId: action.planId });
    return await stateHandler.computeNewStructure(ctx);
  }

  async handleSingleStep(parentCtx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    const configAny: Any = this.config;
    using span = createSpan(parentCtx.withName("ExecutePlanActionHandler.handleSingleStep"));
    const ctx = span.ctx;
    const { turn, mergedMcpTools, requestContext } = await this.initializeConversation(ctx, action, rootPromptExecutor, stateHandler, mcpTools);
    const { hasToolCall } = await this.runSingleStep(ctx, rootPromptExecutor, stateHandler, turn, configAny.toolsGenerator, mergedMcpTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    return { state: await stateHandler.computeNewStructure(ctx), hasToolCall };
  }

  async handleModelStep(parentCtx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    const configAny: Any = this.config;
    using span = createSpan(parentCtx.withName("ExecutePlanActionHandler.handleModelStep"));
    const ctx = span.ctx;
    const { turn, mergedMcpTools, requestContext, requestContextProvenance } = await this.initializeConversation(ctx, action, rootPromptExecutor, stateHandler, mcpTools);
    const { toolCallDescriptors, splitStepData } = await this.runModelStep(ctx, rootPromptExecutor, stateHandler, turn, configAny.toolsGenerator, mergedMcpTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    return { state: await stateHandler.computeNewStructure(ctx), toolCallDescriptors, splitStepData: { ...splitStepData, requestContextProvenance } };
  }
}
