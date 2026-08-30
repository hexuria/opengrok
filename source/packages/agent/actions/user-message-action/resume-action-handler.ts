import { AgentConversationTurnHandle } from "../../state.js";
import { InteractionHandler } from "../../interaction-handler.js";
import { FileOperationLockManager } from "../../tools/core/file-operation-lock-manager.js";
import { appendToolCallIdTagsToToolResults, shouldTagToolCallIdsForCurrentContext } from "../../tools/tool-call-id-tagging.js";
import { extractToolMetadataMap, getDirectDynamicToolNames, getExecutableTools } from "../../tools/core.js";
import { executeDeferredToolCall } from "../../tool-stream-executor.js";
import { PrivacyCapability } from "../../../redaction/classification.js";
import { toRedactedCoreMessages } from "../../../redaction/core-message.js";
import { fromRedactedRequestContext } from "../../../redacted-protos/generated/agent/v1/request_context_exec_redacted.js";
import { toUnredactedInteractionListener } from "../../../agent-core/redacted-interaction-listener.js";
import { createSpan } from "../../../context/otel.js";
import type { Context } from "../../../context/core.js";
import { getInvocationId } from "../../utils/invocation-id.js";
import { getRequestContext, resolveRequestContext } from "../../utils/request-context.js";
import { buildRequestContextOptions } from "../meta-agent-notes.js";
import {
  collectPendingToolAdmission,
  createPendingToolContractMismatchResult,
  readPendingToolExecutionContracts,
  resolveDescriptorForPendingToolCall,
  validatePendingToolContractIdentity,
} from "../../pending-tool-call-contract.js";
import { AbstractUserMessageActionHandler } from "./abstract-user-message-action-handler.js";

type Any = any;

export class ResumeActionHandler extends AbstractUserMessageActionHandler {
  async executePendingToolCalls(ctx: Context, stateHandler: Any, mergedMcpTools: Any, requestContext: Any, invocationId: string): Promise<boolean> {
    const pendingMessages = stateHandler.getRawPendingMessages();
    if (pendingMessages.length === 0 || stateHandler.turns.length === 0) return false;
    const lastTurnRef = stateHandler.turns[stateHandler.turns.length - 1];
    const candidateTurn: Any = await lastTurnRef.get(ctx);
    if (!(candidateTurn instanceof AgentConversationTurnHandle)) throw new Error("Expected last turn to be an agent turn");
    const turn: Any = candidateTurn;
    const interactionHandler = new InteractionHandler(
      toUnredactedInteractionListener(this.interactionListener, stateHandler.getPrivacyMode()),
      turn,
      invocationId,
      undefined,
      this.config.thinkingStyle,
      this.config.featureFlags?.nalLoopDetection === true,
    );
    const mode = (await turn.userMessage.get(ctx)).mode;
    const fileOperationLockManager = new FileOperationLockManager();
    const toolSetHandle = this.config.toolsGenerator({
      resourceAccessor: this.resourceAccessor,
      stateHandler,
      agentSessionId: this.config.agentSessionId,
      mcpTools: mergedMcpTools,
      repositoryInfos: requestContext.repositoryInfo,
      blobStore: stateHandler.getBlobStore(),
      mode,
      loggingContext: ctx,
      requestContext,
      fileOperationLockManager,
      smartModeClassifierMode: this.config.smartModeClassifierMode,
      smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
      autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
    });
    const messages = pendingMessages.map((message: Any) => JSON.parse(message.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)));
    const lastMessage = messages.at(-1);
    if (lastMessage === undefined || lastMessage.role !== "assistant") throw new Error("No assistant message to resume from");
    const contracts = readPendingToolExecutionContracts(lastMessage);
    const { allowedToolNames, admittedEffectiveToolNames } = collectPendingToolAdmission({ contracts: contracts.values() });
    const modelVisibleTools = toolSetHandle.getStaticTools();
    const scopedModelVisibleTools = allowedToolNames === undefined ? modelVisibleTools : modelVisibleTools.filter((tool: Any) => allowedToolNames.has(tool.name) || admittedEffectiveToolNames.has(tool.name));
    const toolExecutionSet = toolSetHandle.getToolExecutionSet(scopedModelVisibleTools);
    const executableTools = getExecutableTools(toolExecutionSet);
    const directDynamicToolNames = getDirectDynamicToolNames(toolExecutionSet);
    const toolMap: Record<string, Any> = {};
    for (const tool of executableTools) toolMap[tool.name] = tool;
    const renderProps = { allTools: extractToolMetadataMap(executableTools), blobStore: stateHandler.getBlobStore() };
    const toolPromises: Promise<Any>[] = [];
    if (Array.isArray(lastMessage.content)) {
      for (const content of lastMessage.content) {
        if (content.type !== "tool-call") continue;
        const contract = contracts.get(content.toolCallId);
        const descriptor = resolveDescriptorForPendingToolCall({ toolCallId: content.toolCallId, toolName: content.toolName, args: content.args, contract, toolExecutionSet });
        const effectiveToolName = descriptor.effectiveNativeToolCall?.toolName ?? descriptor.toolName;
        const tool = toolMap[effectiveToolName];
        if (contract !== undefined && tool !== undefined) {
          const validation = validatePendingToolContractIdentity({ contract, tool, descriptor, directDynamicToolNames });
          if (!validation.ok) {
            toolPromises.push(Promise.resolve(createPendingToolContractMismatchResult(descriptor, validation.reason)));
            continue;
          }
        }
        const conflictNoticesEnabled = this.config.featureFlags?.enableAgentStoreConflictNotices === true;
        toolPromises.push(executeDeferredToolCall(ctx, descriptor, toolMap, interactionHandler, {
          repositoryInfos: requestContext.repositoryInfo,
          stateHandler,
          workspacePaths: requestContext.env?.workspacePaths,
          enableHookAdditionalContext: this.config.featureFlags?.enableHookAdditionalContext === true,
          enableAgentStoreConflictNoticeCollector: conflictNoticesEnabled,
          enableAgentStoreConflictNotices: conflictNoticesEnabled,
          writeBarrierTimeoutMs: this.resolveWriteBarrierTimeoutMs(),
          onWriteBarrier: this.config.recordAgentStoreWriteBarrier,
        }, async () => {}, renderProps, undefined, undefined, directDynamicToolNames));
      }
    }
    const toolResults = await Promise.all(toolPromises);
    messages.push(...toolResults);
    if (shouldTagToolCallIdsForCurrentContext(ctx)) appendToolCallIdTagsToToolResults(messages);
    turn.appendPromptMessages(toRedactedCoreMessages(messages, stateHandler.getPrivacyMode()));
    return true;
  }

  async handle(parentCtx: Context, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    using span = createSpan(parentCtx.withName("ResumeActionHandler.handle"));
    const ctx = span.ctx;
    const invocationId = getInvocationId(ctx);
    span.span.setAttribute("invocationId", invocationId);
    const requestContext = await getRequestContext(ctx, action.requestContext ? fromRedactedRequestContext(action.requestContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined) : undefined, this.resourceAccessor, buildRequestContextOptions(this.config));
    const mergedMcpTools = this.mergeRequestContextTools(mcpTools, requestContext.tools);
    await this.executePendingToolCalls(ctx, stateHandler, mergedMcpTools, requestContext, invocationId);
    if (stateHandler.turns.length === 0) return await stateHandler.computeNewStructure(ctx);
    const lastTurnRef = stateHandler.turns[stateHandler.turns.length - 1];
    const candidateTurn: Any = await lastTurnRef.get(ctx);
    if (!(candidateTurn instanceof AgentConversationTurnHandle)) throw new Error("Expected last turn to be an agent turn");
    const turn: Any = candidateTurn;
    await this.runTurnLoop(ctx, rootPromptExecutor, stateHandler, turn, this.config.toolsGenerator, mergedMcpTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    return await stateHandler.computeNewStructure(ctx);
  }

  async setupResumeStep(ctx: Context, action: Any, stateHandler: Any, mcpTools: Any): Promise<Any> {
    const invocationId = getInvocationId(ctx);
    const { requestContext, provenance: requestContextProvenance } = await resolveRequestContext({
      parentCtx: ctx,
      resources: this.resourceAccessor,
      options: buildRequestContextOptions(this.config),
      ...(action.requestContext ? { maybeRequestContext: fromRedactedRequestContext(action.requestContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined) } : {}),
    });
    const mergedMcpTools = this.mergeRequestContextTools(mcpTools, requestContext.tools);
    await this.executePendingToolCalls(ctx, stateHandler, mergedMcpTools, requestContext, invocationId);
    if (stateHandler.turns.length === 0) return { noTurns: true };
    const lastTurnRef = stateHandler.turns[stateHandler.turns.length - 1];
    const turn: Any = await lastTurnRef.get(ctx);
    if (!(turn instanceof AgentConversationTurnHandle)) throw new Error("Expected last turn to be an agent turn");
    return { turn, mergedMcpTools, requestContext, requestContextProvenance };
  }

  async handleSingleStep(parentCtx: Context, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    using span = createSpan(parentCtx.withName("ResumeActionHandler.handleSingleStep"));
    const ctx = span.ctx;
    span.span.setAttribute("invocationId", getInvocationId(ctx));
    const setup = await this.setupResumeStep(ctx, action, stateHandler, mcpTools);
    if ("noTurns" in setup) return { state: await stateHandler.computeNewStructure(ctx), hasToolCall: false };
    const { turn, mergedMcpTools, requestContext } = setup;
    const { hasToolCall } = await this.runSingleStep(ctx, rootPromptExecutor, stateHandler, turn, this.config.toolsGenerator, mergedMcpTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    return { state: await stateHandler.computeNewStructure(ctx), hasToolCall };
  }

  async handleModelStep(parentCtx: Context, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    using span = createSpan(parentCtx.withName("ResumeActionHandler.handleModelStep"));
    const ctx = span.ctx;
    span.span.setAttribute("invocationId", getInvocationId(ctx));
    const setup = await this.setupResumeStep(ctx, action, stateHandler, mcpTools);
    if ("noTurns" in setup) return { state: await stateHandler.computeNewStructure(ctx), toolCallDescriptors: [], splitStepData: { modelResponseMessages: [] } };
    const { turn, mergedMcpTools, requestContext, requestContextProvenance } = setup;
    const { toolCallDescriptors, splitStepData } = await this.runModelStep(ctx, rootPromptExecutor, stateHandler, turn, this.config.toolsGenerator, mergedMcpTools, requestContext.repositoryInfo, requestContext, onStateUpdate);
    return { state: await stateHandler.computeNewStructure(ctx), toolCallDescriptors, splitStepData: { ...splitStepData, requestContextProvenance } };
  }
}
