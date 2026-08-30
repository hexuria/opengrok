import { randomUUID } from "node:crypto";
import {
  AgentMode,
  SimulatedMsgReason,
  UserMessage,
} from "../../proto/generated/agent/v1/agent_pb.js";
import { SelectedContext } from "../../proto/generated/agent/v1/selected_context_pb.js";
import { Updates } from "../../agent-core/interaction-updates.js";
import { RedactedUpdates } from "../../agent-core/redacted-interaction-updates.js";
import { createSpan } from "../../context/otel.js";
import { createLogger } from "../../context/logger.js";
import { PrivacyCapability } from "../../redaction/classification.js";
import { toRedactedCoreMessages } from "../../redaction/core-message.js";
import { fromRedactedBackgroundTaskCompletionAction, toRedactedInteractionUpdate } from "../../redacted-protos/generated/agent/v1/agent_redacted.js";
import { fromRedactedRepositoryIndexingInfo } from "../../redacted-protos/generated/agent/v1/repo_redacted.js";
import { fromRedactedRequestContext } from "../../redacted-protos/generated/agent/v1/request_context_exec_redacted.js";
import { fromRedactedSelectedContext } from "../../redacted-protos/generated/agent/v1/selected_context_redacted.js";
import { AgentType } from "../utils/agent-config.js";
import { AgentConversationTurnHandle } from "../state.js";
import { buildRequestContextOptions } from "./meta-agent-notes.js";
import { getRedactedRequestContext } from "../utils/request-context.js";
import { isProjectSendMessageEnabled } from "../../constants/project-send-message.js";
import { resolveProjectConversationContext } from "../utils/project-conversation.js";
import { renderIncomingMessageIdTag } from "../state.js";
import {
  formatBackgroundCompletions,
  formatMetaParentBackgroundCompletions,
  getBackgroundTaskCompletionMetadata,
  getBackgroundTaskCompletionThreadId,
  isShellOutputCompletion,
  summarizeBackgroundTaskCompletions,
} from "./background-task-completion.js";
import { AbstractUserMessageActionHandler } from "./user-message-action/abstract-user-message-action-handler.js";

type Any = any;
const logger = createLogger("@anysphere/agent");

function logBackgroundTaskCompletionOutcome(ctx: Any, outcome: string, summary: Any, extra: Any): void {
  logger.info(ctx, "agent.background_task_completion", { event: "agent.background_task_completion", outcome, ...summary, ...extra });
}

export class BackgroundTaskCompletionActionHandler extends AbstractUserMessageActionHandler {
  async prepareFollowupTurn(ctx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any): Promise<Any> {
    const completionAction = fromRedactedBackgroundTaskCompletionAction(action, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined);
    for (const completion of completionAction.completions) stateHandler.recordSubagentRunCompletion(completion);
    const isMetaParentAgent = this.config.featureFlags?.glassMetaParentAgent === true;
    if (this.config.featureFlags?.disableBackgroundTaskFollowUp && !isMetaParentAgent) {
      logBackgroundTaskCompletionOutcome(ctx, "skipped_disabled", summarizeBackgroundTaskCompletions(completionAction.completions), { is_meta_parent: isMetaParentAgent });
      return { kind: "skip", ctx, state: await stateHandler.computeNewStructure(ctx) };
    }
    const completions = this.config.featureFlags?.enableBackgroundTaskProgress ? completionAction.completions : completionAction.completions.filter((completion: Any) => !isShellOutputCompletion(completion));
    const summary = summarizeBackgroundTaskCompletions(completions);
    if (completions.length === 0) {
      logBackgroundTaskCompletionOutcome(ctx, "skipped_empty", summary, { is_meta_parent: isMetaParentAgent });
      return { kind: "skip", ctx, state: await stateHandler.computeNewStructure(ctx) };
    }
    const lastTurnRef = stateHandler.turns.at(-1);
    let sourceUserMessage: Any;
    if (lastTurnRef) {
      const lastTurn = await lastTurnRef.get(ctx);
      if (lastTurn instanceof AgentConversationTurnHandle) sourceUserMessage = await lastTurn.userMessage.get(ctx);
    }
    const requestContext = await getRedactedRequestContext(ctx, undefined, this.resourceAccessor, buildRequestContextOptions(this.config));
    const unredactedRequestContext = fromRedactedRequestContext(requestContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined);
    const mergedMcpTools = this.mergeRequestContextTools(mcpTools, requestContext.tools);
    const repositoryInfos = requestContext.repositoryInfo.map((info: Any) => fromRedactedRepositoryIndexingInfo(info, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined));
    const followUpMode = stateHandler.mode ?? sourceUserMessage?.mode ?? AgentMode.AGENT;
    const formatOpts: Any = {
      timeZone: unredactedRequestContext.env?.timeZone,
      includeTimestamp: this.config.featureFlags?.userMessageTimestamps === true && !stateHandler.isDsv3(),
      parentModelInfo: this.config.modelInfo,
      enableAgentChatLinks: this.config.featureFlags?.enableAgentChatLinks !== false,
      hideAsyncSubagentTaskNotifications: this.config.featureFlags?.hideAsyncSubagentTaskNotifications === true,
      includeCloudSubagentViewLinks: this.config.agentType === AgentType.IDE || this.config.useLocalAgentPrompting === true,
    };
    if (!stateHandler.isRootProjectConversation) stateHandler.isRootProjectConversation = (await resolveProjectConversationContext(ctx, stateHandler)).isRootProject;
    const sendMessageEnabled = isProjectSendMessageEnabled(stateHandler);
    const perCompletionMessages = completions.map((completion: Any) => {
      const completionMessage = isMetaParentAgent ? formatMetaParentBackgroundCompletions([completion], formatOpts) : formatBackgroundCompletions([completion], formatOpts);
      const messageId = randomUUID();
      const incomingMessageIdTag = sendMessageEnabled ? renderIncomingMessageIdTag(messageId) : undefined;
      return {
        completionMessage,
        completionPromptMessage: incomingMessageIdTag === undefined ? completionMessage : `${incomingMessageIdTag}\n${completionMessage}`,
        completionMetadata: getBackgroundTaskCompletionMetadata([completion]),
        completionThreadId: getBackgroundTaskCompletionThreadId([completion], stateHandler),
        messageId,
      };
    });
    logBackgroundTaskCompletionOutcome(ctx, "ran_followup", summary, { is_meta_parent: isMetaParentAgent, has_source_user_message: sourceUserMessage !== undefined });
    let latestTurn: Any;
    for (const { completionMessage, completionPromptMessage, completionMetadata, completionThreadId, messageId } of perCompletionMessages) {
      const syntheticUserMessage = new UserMessage({
        text: completionMessage,
        messageId,
        selectedContext: sourceUserMessage?.selectedContext ? fromRedactedSelectedContext(sourceUserMessage.selectedContext, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined) : new SelectedContext(),
        mode: followUpMode,
        isSimulatedMsg: true,
        simulatedMsgReason: SimulatedMsgReason.BACKGROUND_TASK_COMPLETION,
        ...(completionMetadata !== undefined ? { simulatedMessageMetadata: completionMetadata } : {}),
      });
      if (completionThreadId !== undefined && completionThreadId.length > 0) syntheticUserMessage.threadId = completionThreadId;
      await this.interactionListener.sendUpdate(ctx, toRedactedInteractionUpdate(Updates.userMessageAppended(syntheticUserMessage), stateHandler.getPrivacyMode()));
      latestTurn = await stateHandler.createAgentTurn(ctx, syntheticUserMessage, unredactedRequestContext, this.config, this.resourceAccessor);
      rootPromptExecutor.appendMessages(toRedactedCoreMessages([{ role: "user", content: completionPromptMessage }], stateHandler.getPrivacyMode()));
    }
    if (latestTurn === undefined) return { kind: "skip", ctx, state: await stateHandler.computeNewStructure(ctx) };
    return { kind: "ready", ctx, latestTurn, mergedMcpTools, repositoryInfos, requestContext: unredactedRequestContext };
  }

  async handle(parentCtx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    using span = createSpan(parentCtx.withName("handleBackgroundTaskCompletionAction"));
    const followup = await this.prepareFollowupTurn(span.ctx, action, rootPromptExecutor, stateHandler, mcpTools);
    if (followup.kind === "ready") await this.runTurnLoop(followup.ctx, rootPromptExecutor, stateHandler, followup.latestTurn, this.config.toolsGenerator, followup.mergedMcpTools, followup.repositoryInfos, followup.requestContext, onStateUpdate);
    return await stateHandler.computeNewStructure(followup.ctx);
  }

  async handleSingleStep(ctx: Any, _action: Any, _rootPromptExecutor: Any, stateHandler: Any, _mcpTools: Any, _onStateUpdate: Any): Promise<Any> {
    return { state: await stateHandler.computeNewStructure(ctx), hasToolCall: false };
  }

  async handleModelStep(parentCtx: Any, action: Any, rootPromptExecutor: Any, stateHandler: Any, mcpTools: Any, onStateUpdate: Any): Promise<Any> {
    using span = createSpan(parentCtx.withName("handleBackgroundTaskCompletionModelStep"));
    const followup = await this.prepareFollowupTurn(span.ctx, action, rootPromptExecutor, stateHandler, mcpTools);
    if (followup.kind === "skip") return { state: followup.state, toolCallDescriptors: [], splitStepData: { modelResponseMessages: [] } };
    const { toolCallDescriptors, splitStepData } = await this.runModelStep(followup.ctx, rootPromptExecutor, stateHandler, followup.latestTurn, this.config.toolsGenerator, followup.mergedMcpTools, followup.repositoryInfos, followup.requestContext, onStateUpdate);
    return { state: await stateHandler.computeNewStructure(followup.ctx), toolCallDescriptors, splitStepData };
  }
}
