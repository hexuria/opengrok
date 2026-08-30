import { BackgroundSummarizationMode, DISABLED_BACKGROUND_SUMMARIZATION_PROPS } from "../agent-summarization/background-summarization.js";
import { flushPostTurnEndedWork } from "../agent-core/interaction-listener.js";
import { DeferredInteractionResponseError } from "../agent-core/interaction-queries.js";
import { Updates } from "../agent-core/interaction-updates.js";
import { PrivacyCapability } from "../redaction/classification.js";
import { PrivacyMode } from "../redaction/privacy-mode.js";
import { withLogAttributes, createSpan } from "../context/index.js";
import { createHistogram } from "../metrics/index.js";
import { fromRedactedConversationStateStructure, toRedactedInteractionUpdate } from "../redacted-protos/generated/agent/v1/agent_redacted.js";
import { createRedactedConversationTokenDetails } from "../redacted-protos/generated/agent/v1/agent_redacted.js";
import { RedactedPromptToolExecutor } from "./tool-stream-executor.js";
import { ConversationStateHandle } from "./state.js";
import { SummarizationOrchestrator } from "./summarization-orchestrator.js";
import { estimateTokenCount } from "./self-summary/token-estimate.js";
import { drainPendingWritesOnRunStreamError } from "./abort-drain.js";
import { buildRunStreamStateHandleOptions, shouldTrackAgentTypeChange, createRunStreamStateUpdateWithFlush } from "./run-stream-lifecycle.js";
import { conversationGroupIdKey, conversationIdKey, bubbleRetryableTaskErrorsKey } from "./utils/request-id.js";
import { normalizeAnysphereAgentConfig } from "./agent-config-runtime.js";
import { AbstractUserMessageActionHandler } from "./actions/user-message-action/abstract-user-message-action-handler.js";
import { UserMessageActionHandler } from "./actions/user-message-action/user-message-action-handler.js";
import { ResumeActionHandler } from "./actions/user-message-action/resume-action-handler.js";
import { SubscriptionNotificationActionHandler } from "./actions/subscription-notification-action-handler.js";
import { GoalContinuationActionHandler } from "./actions/goal-continuation-action-handler.js";
import { SummarizeActionHandler } from "./actions/summarize-action-handler.js";
import { ShellCommandActionHandler } from "./actions/shell-command-action-handler.js";
import { CancelActionHandler } from "./actions/cancel-action-handler.js";
import { ExecutePlanActionHandler } from "./actions/execute-plan-action-handler.js";
import { AsyncAskQuestionCompletionActionHandler } from "./actions/async-ask-question-completion-action-handler.js";
import { BackgroundTaskCompletionActionHandler } from "./actions/background-task-completion-action-handler.js";
import { BackgroundShellActionHandler } from "./actions/background-shell-action-handler.js";
import { BackgroundSubagentActionHandler } from "./actions/background-subagent-action-handler.js";

type Any = any;

const MAX_AGENT_STEPS = 1_000;
const stateDeserializationDuration = createHistogram("agent.state_deserialization_ms", { description: "State restore duration" });
const actionHandlerDuration = createHistogram("agent.action_handler_ms", { description: "Action handler duration", labelNames: ["action"] });

/** The package-owned Agent root, reconstructed from the immutable Mac/Windows carrier. */
export class AnysphereAgent {
  readonly config: Any;
  readonly promptSession: Any;
  readonly interactionListener: Any;
  readonly resourceAccessor: Any;
  readonly blobStore: Any;
  readonly summarizationHandler: Any;
  readonly conversationActionReceiver: Any;
  readonly orchestrator: Any;
  readonly actionHandlers: Map<string, Any>;

  shouldTrackAgentTypeChange(actionCase: string | undefined): boolean {
    return shouldTrackAgentTypeChange(actionCase);
  }

  stateHandleOptions(options: Any): Any {
    return buildRunStreamStateHandleOptions(options, this.config.featureFlags);
  }

  constructor(config: Any, promptSession: Any, interactionListener: Any, resourceAccessor: Any, blobStore: Any, summarizationHandler: Any, conversationActionReceiver: Any) {
    this.promptSession = promptSession;
    this.interactionListener = interactionListener;
    this.resourceAccessor = resourceAccessor;
    this.blobStore = blobStore;
    this.summarizationHandler = summarizationHandler;
    this.conversationActionReceiver = conversationActionReceiver;
    this.config = normalizeAnysphereAgentConfig(config);
    this.orchestrator = new SummarizationOrchestrator(summarizationHandler, undefined, this.config.backgroundSummarizationProps, this.config.selfSummaryConfig?.tokenLimit, this.config.selfSummaryConfig?.canUseSelfSummary);
    this.actionHandlers = new Map();
    const user = new UserMessageActionHandler(this.config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver, this.orchestrator);
    this.actionHandlers.set("userMessageAction", user);
    this.actionHandlers.set("subscriptionNotificationAction", new SubscriptionNotificationActionHandler(user));
    this.actionHandlers.set("goalContinuationAction", new GoalContinuationActionHandler(user, this.config.toolsGenerator, resourceAccessor, this.config.agentSessionId));
    this.actionHandlers.set("resumeAction", new ResumeActionHandler(this.config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver, this.orchestrator));
    this.actionHandlers.set("summarizeAction", new SummarizeActionHandler(this.config, resourceAccessor, interactionListener, this.orchestrator, conversationActionReceiver));
    this.actionHandlers.set("shellCommandAction", new ShellCommandActionHandler(this.config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver));
    this.actionHandlers.set("cancelAction", new CancelActionHandler(this.config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver));
    this.actionHandlers.set("executePlanAction", new ExecutePlanActionHandler(this.config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver, this.orchestrator));
    this.actionHandlers.set("asyncAskQuestionCompletionAction", new AsyncAskQuestionCompletionActionHandler(this.config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver, this.orchestrator));
    this.actionHandlers.set("backgroundTaskCompletionAction", new BackgroundTaskCompletionActionHandler(this.config, resourceAccessor, interactionListener, summarizationHandler, conversationActionReceiver, this.orchestrator));
    this.actionHandlers.set("backgroundShellAction", new BackgroundShellActionHandler());
    this.actionHandlers.set("backgroundSubagentAction", new BackgroundSubagentActionHandler());
  }

  async runStream(parentCtx: Any, state: Any, action: Any, mcpTools: Any, onStateUpdate?: Any, options?: Any): Promise<Any> {
    using span = createSpan(parentCtx.withName("runStream"));
    let ctx = withLogAttributes(span.ctx, { action: action.action?.case, modelName: this.config.modelId, ...(this.config.canonicalModelName === undefined ? {} : { canonicalModelName: this.config.canonicalModelName }) });
    if (this.config.conversationGroupId !== undefined) ctx = ctx.with(conversationGroupIdKey, this.config.conversationGroupId);
    if (this.config.conversationId !== undefined) ctx = ctx.with(conversationIdKey, this.config.conversationId);
    if (this.config.isBackground === true) ctx = ctx.with(bubbleRetryableTaskErrorsKey, true);
    const baseExecutor = new RedactedPromptToolExecutor(this.promptSession.getExecutor(), PrivacyMode.UNSPECIFIED);
    let rootPromptImagePresence: Any;
    const restoreStart = performance.now();
    const stateHandler = await ConversationStateHandle.fromConversationStateStructure(ctx, this.blobStore, state, baseExecutor as Any, this.config.formattingOptions, this.config.modelId, this.config.agentType, this.stateHandleOptions({ shouldTrackAgentTypeChange: this.shouldTrackAgentTypeChange(action.action?.case), loadRootPromptBlobs: true, ...(options?.onRootPromptImagePresence === undefined ? {} : { onRootPromptImagePresence: (value: Any) => { rootPromptImagePresence = value; } }) }));
    const stateDeserializationMs = performance.now() - restoreStart;
    stateDeserializationDuration.histogram(ctx, stateDeserializationMs);
    options?.onStateDeserialized?.(stateDeserializationMs);
    if (rootPromptImagePresence !== undefined) options?.onRootPromptImagePresence?.(rootPromptImagePresence);
    if (action.action?.case === undefined) throw new Error("Action is required");
    if (action.action.case === "startPlanAction") throw new Error("startPlanAction is deprecated; use userMessageAction with UserMessage.mode = PLAN");
    const handler = this.actionHandlers.get(action.action.case);
    if (handler === undefined) throw new Error(`Unsupported action type: ${action.action.case}`);
    const updateWithFlush = createRunStreamStateUpdateWithFlush({ blobStore: this.blobStore, onStateUpdate });
    let pending = Promise.resolve();
    let currentState = state;
    const usage: Record<string, number> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    const runOne = async (currentHandler: Any, currentAction: Any, currentStateHandler: Any): Promise<void> => {
      const start = performance.now();
      currentState = currentAction === action.action.value
        ? await currentHandler.handle(ctx, action.action.value, baseExecutor, currentStateHandler, mcpTools, updateWithFlush)
        : await currentHandler.handle(ctx, currentAction, baseExecutor, currentStateHandler, mcpTools, updateWithFlush);
      actionHandlerDuration.histogram(ctx, performance.now() - start, { action: action.action.case });
      const turnUsage = currentStateHandler.getTurnUsageAndReset?.() ?? {};
      for (const key of Object.keys(usage)) usage[key] += turnUsage[key] ?? 0;
      if (this.config.fireAndForgetCheckpoints) pending = pending.then(() => updateWithFlush(ctx, currentState)).catch(() => undefined);
      else await updateWithFlush(ctx, currentState);
    };
    try {
      await runOne(handler, action.action.value, stateHandler);
      while (true) {
        const queued = await this.conversationActionReceiver.peek(ctx);
        if (queued?.action?.case === undefined) break;
        const queuedHandler = this.actionHandlers.get(queued.action.case);
        await this.conversationActionReceiver.pop(ctx);
        if (queuedHandler === undefined) continue;
        baseExecutor.clearMessages();
        const queuedStateHandler = await ConversationStateHandle.fromConversationStateStructure(ctx, this.blobStore, currentState, baseExecutor as Any, this.config.formattingOptions, this.config.modelId, this.config.agentType, this.stateHandleOptions({ shouldTrackAgentTypeChange: this.shouldTrackAgentTypeChange(queued.action.case), loadRootPromptBlobs: true }));
        await runOne(queuedHandler, queued.action.value, queuedStateHandler);
      }
      if (!options?.skipTurnEndedUpdate) {
        const hasUsage = Object.values(usage).some(value => value > 0);
        await this.interactionListener.sendUpdate(ctx, toRedactedInteractionUpdate(Updates.turnEnded(hasUsage ? usage as Any : undefined), action._privacyMode));
      }
      await flushPostTurnEndedWork(ctx, this.interactionListener);
      await pending;
      await this.blobStore.flush(ctx);
      options?.onTimings?.({ stateDeserializationMs, actionHandlerMs: 0 });
      return fromRedactedConversationStateStructure(currentState, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined);
    } catch (error) {
      await drainPendingWritesOnRunStreamError(ctx, { pendingCheckpoints: pending, flush: () => this.blobStore.flush(ctx) });
      throw error;
    }
  }

  async setupSingleStep(parentCtx: Any, state: Any, action: Any, onStateUpdate?: Any): Promise<Any> {
    using span = createSpan(parentCtx.withName("setupSingleStep"));
    const ctx = span.ctx;
    const baseExecutor = new RedactedPromptToolExecutor(this.promptSession.getExecutor(), PrivacyMode.UNSPECIFIED);
    const stateHandler = await ConversationStateHandle.fromConversationStateStructure(ctx, this.blobStore, state, baseExecutor as Any, this.config.formattingOptions, this.config.modelId, this.config.agentType, this.stateHandleOptions({ shouldTrackAgentTypeChange: this.shouldTrackAgentTypeChange(action.action?.case), loadRootPromptBlobs: true }));
    if (action.action?.case === undefined) throw new Error("Action is required");
    const handler = this.actionHandlers.get(action.action.case);
    if (handler === undefined) throw new Error(`Unsupported action type: ${action.action.case}`);
    return { ctx, baseExecutor, stateHandler, handler, onStateUpdateWithFlush: createRunStreamStateUpdateWithFlush({ blobStore: this.blobStore, onStateUpdate }) };
  }

  async runSingleStep(parentCtx: Any, state: Any, action: Any, mcpTools: Any, onStateUpdate?: Any): Promise<Any> {
    const setup = await this.setupSingleStep(parentCtx, state, action, onStateUpdate);
    if (!("handleSingleStep" in setup.handler)) throw new Error(`Action handler for ${action.action.case} does not support single-step execution`);
    const result = await setup.handler.handleSingleStep(setup.ctx, action.action.value, setup.baseExecutor, setup.stateHandler, mcpTools, setup.onStateUpdateWithFlush);
    await setup.onStateUpdateWithFlush(setup.ctx, result.state);
    return { state: fromRedactedConversationStateStructure(result.state, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined), hasToolCall: result.hasToolCall };
  }

  getSplitStepHandler(actionCase?: string): Any {
    const handler = actionCase === undefined ? [...this.actionHandlers.values()].find(value => value instanceof AbstractUserMessageActionHandler) : this.actionHandlers.get(actionCase);
    if (handler instanceof SubscriptionNotificationActionHandler || handler instanceof GoalContinuationActionHandler) return handler.getUserMessageActionHandler();
    if (handler instanceof AbstractUserMessageActionHandler) return handler;
    throw new Error(`Action handler for ${actionCase ?? "unknown"} does not support split-step execution`);
  }

  async runModelStep(parentCtx: Any, state: Any, action: Any, mcpTools: Any, onStateUpdate?: Any): Promise<Any> {
    const setup = await this.setupSingleStep(parentCtx, state, action, onStateUpdate);
    if (!("handleModelStep" in setup.handler)) throw new Error(`Action handler for ${action.action.case} does not support split-step execution`);
    const result = await setup.handler.handleModelStep(setup.ctx, action.action.value, setup.baseExecutor, setup.stateHandler, mcpTools, setup.onStateUpdateWithFlush);
    await setup.onStateUpdateWithFlush(setup.ctx, result.state);
    return { state: fromRedactedConversationStateStructure(result.state, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined), toolCallDescriptors: result.toolCallDescriptors, splitStepData: { ...result.splitStepData, actionCase: action.action.case } };
  }

  async executeToolCall(parentCtx: Any, state: Any, descriptor: Any, mcpTools: Any, splitStepData: Any, fileOperationLockManager: Any, onStateUpdate?: Any): Promise<Any> {
    const ctx = parentCtx;
    const baseExecutor = new RedactedPromptToolExecutor(this.promptSession.getExecutor(), PrivacyMode.UNSPECIFIED);
    const stateHandler = await ConversationStateHandle.fromConversationStateStructure(ctx, this.blobStore, state, baseExecutor as Any, this.config.formattingOptions, this.config.modelId, this.config.agentType, this.stateHandleOptions({ shouldTrackAgentTypeChange: this.shouldTrackAgentTypeChange(splitStepData.actionCase), loadRootPromptBlobs: false }));
    const handler = this.getSplitStepHandler(splitStepData.actionCase);
    try { return await handler.executeToolCall(ctx, descriptor, stateHandler, mcpTools, splitStepData, splitStepData.requestContext ?? {}, fileOperationLockManager); }
    catch (error) { if (error instanceof DeferredInteractionResponseError && onStateUpdate !== undefined) await onStateUpdate(ctx, fromRedactedConversationStateStructure(await stateHandler.computeNewStructure(ctx), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)); throw error; }
  }

  async prepareSubagent(parentCtx: Any, state: Any, descriptor: Any, mcpTools: Any, splitStepData: Any, fileOperationLockManager: Any): Promise<Any> {
    const ctx = parentCtx;
    const baseExecutor = new RedactedPromptToolExecutor(this.promptSession.getExecutor(), PrivacyMode.UNSPECIFIED);
    const stateHandler = await ConversationStateHandle.fromConversationStateStructure(ctx, this.blobStore, state, baseExecutor as Any, this.config.formattingOptions, this.config.modelId, this.config.agentType, this.stateHandleOptions({ shouldTrackAgentTypeChange: this.shouldTrackAgentTypeChange(splitStepData.actionCase), loadRootPromptBlobs: true }));
    return this.getSplitStepHandler(splitStepData.actionCase).prepareSubagent(ctx, descriptor, stateHandler, mcpTools, splitStepData, splitStepData.requestContext ?? {}, fileOperationLockManager);
  }

  async finalizeStep(parentCtx: Any, state: Any, splitStepData: Any, toolCallResults: Any, mcpTools: Any, onStateUpdate?: Any): Promise<Any> {
    const ctx = parentCtx;
    const baseExecutor = new RedactedPromptToolExecutor(this.promptSession.getExecutor(), PrivacyMode.UNSPECIFIED);
    const stateHandler = await ConversationStateHandle.fromConversationStateStructure(ctx, this.blobStore, state, baseExecutor as Any, this.config.formattingOptions, this.config.modelId, this.config.agentType, this.stateHandleOptions({ shouldTrackAgentTypeChange: this.shouldTrackAgentTypeChange(splitStepData.actionCase), loadRootPromptBlobs: true }));
    const update = createRunStreamStateUpdateWithFlush({ blobStore: this.blobStore, onStateUpdate });
    const result = await this.getSplitStepHandler(splitStepData.actionCase).finalizeStep(ctx, splitStepData, toolCallResults, baseExecutor, stateHandler, mcpTools, splitStepData.requestContext ?? {}, update);
    await update(ctx, result.state);
    return { state: fromRedactedConversationStateStructure(result.state, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined), hasToolCall: result.hasToolCall };
  }

  shouldPrecomputeSummary(tokenDetails: Any): boolean { return this.orchestrator.shouldStartBackgroundSummarization(tokenDetails, []); }

  async computeSummarizedConversationState(parentCtx: Any, state: Any, requestContext: Any): Promise<Any> {
    using span = createSpan(parentCtx.withName("computeSummarizedConversationState"));
    const executor = new RedactedPromptToolExecutor(this.promptSession.getExecutor(), PrivacyMode.UNSPECIFIED);
    const stateHandler = await ConversationStateHandle.fromConversationStateStructure(span.ctx, this.blobStore, state, executor as Any, this.config.formattingOptions, this.config.modelId, this.config.agentType, { shouldTrackAgentTypeChange: false });
    const noop = { sendUpdate: async () => {}, query: async () => { throw new Error("Interaction queries are not supported during summarization"); } };
    const summary = await this.orchestrator.handleSummarization(span.ctx, stateHandler, executor, noop, this.config, requestContext, { backgroundSummarizationMode: BackgroundSummarizationMode.WaitForCompletion, triggerReason: "approaching_token_limit", resourceAccessor: this.resourceAccessor, forceExternalModel: true, currentInvocationId: (stateHandler as Any).lastStepInvocationId });
    if (summary === undefined) return undefined;
    stateHandler.setTokenDetails(createRedactedConversationTokenDetails(stateHandler.getPrivacyMode(), { usedTokens: estimateTokenCount(executor.getMessages() as Any), maxTokens: stateHandler.tokenDetails.maxTokens, breakdown: undefined, promptContextUsageTree: undefined }));
    return fromRedactedConversationStateStructure(await stateHandler.computeNewStructure(span.ctx), PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined);
  }

  isSingleStepHandler(handler: Any): boolean { return "handleSingleStep" in handler; }
  isSplitStepHandler(handler: Any): boolean { return "handleModelStep" in handler; }
}

export { ConversationStateHandle } from "./state.js";
export { UserMessageActionHandler } from "./actions/user-message-action/user-message-action-handler.js";
export { ExecutePlanActionHandler } from "./actions/execute-plan-action-handler.js";
export { sanitizePlanFileName, resolvePlanFilePath } from "./actions/execute-plan-plan-file.js";
