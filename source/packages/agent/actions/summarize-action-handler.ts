import { AgentMode } from "../../proto/generated/agent/v1/agent_pb.js";
import { BackgroundSummarizationMode } from "../../agent-summarization/background-summarization.js";
import { RedactedUpdates } from "../../agent-core/redacted-interaction-updates.js";
import { createLogger, type Context } from "../../context/index.js";
import { PrivacyCapability } from "../../redaction/classification.js";
import { toRedactedCoreMessages } from "../../redaction/core-message.js";
import {
  createRedactedConversationSummary,
  createRedactedConversationTokenDetails,
  fromRedactedPromptTokenBreakdownSnapshot,
  toRedactedPromptTokenBreakdownSnapshot,
} from "../../redacted-protos/generated/agent/v1/agent_redacted.js";
import { FileOperationLockManager } from "../tools/core/file-operation-lock-manager.js";
import { extractAutomationTriggerContext } from "./common.js";
import { buildRequestContextOptions } from "./meta-agent-notes.js";
import { getRequestContext } from "../utils/request-context.js";
import { buildSummarizeRefreshSnapshot } from "../utils/prompt-token-breakdown.js";
import { estimateTokenCount, extractTextContent } from "../self-summary/token-estimate.js";

type Any = any;

const logger = createLogger("@anysphere/agent:summarize");

function summarizedConversationCharCount(messages: readonly Any[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role !== "user" || message.providerOptions?.cursor?.isSummary !== true) continue;
    total += extractTextContent(message).length;
  }
  return total;
}

interface SummarizeConfig {
  readonly toolsGenerator: (options: Any) => Any;
  readonly systemPromptGenerator: (options: Any, toolSetHandle: Any) => Any;
  readonly agentSessionId?: string;
  readonly summarizeActionClearTurns?: boolean;
  readonly fireAndForgetCheckpoints?: boolean;
  readonly automationInstructions?: unknown;
  readonly [key: string]: unknown;
}

interface SummarizeStateHandler {
  readonly mode?: AgentMode | undefined;
  readonly tokenDetails: Any;
  getBlobStore(): Any;
  getPrivacyMode(): Any;
  computeNewStructure(ctx: Context): Promise<Any>;
  setSummary(summary: Any): void;
  clearTurns(): Promise<void>;
  setTokenDetails(tokenDetails: Any): void;
}

interface RootPromptExecutor {
  getMessages(): readonly Any[];
  appendMessages(messages: readonly Any[]): void;
}

export class SummarizeActionHandler {
  readonly config: SummarizeConfig;
  readonly resourceAccessor: Any;
  readonly interactionListener: Any;
  readonly orchestrator: Any;
  readonly conversationActionReceiver: Any;

  constructor(
    config: SummarizeConfig,
    resourceAccessor: Any,
    interactionListener: Any,
    orchestrator: Any,
    conversationActionReceiver: Any,
  ) {
    this.config = config;
    this.resourceAccessor = resourceAccessor;
    this.interactionListener = interactionListener;
    this.orchestrator = orchestrator;
    this.conversationActionReceiver = conversationActionReceiver;
  }

  async handle(
    ctx: Context,
    _action: Any,
    rootPromptExecutor: RootPromptExecutor,
    stateHandler: SummarizeStateHandler,
    _mcpTools: Any,
    onStateUpdate?: ((ctx: Context, checkpoint: Any) => Promise<void>) | undefined,
  ): Promise<Any> {
    const hasAnyMessages = rootPromptExecutor.getMessages().length > 0;
    if (!hasAnyMessages) return await stateHandler.computeNewStructure(ctx);

    const hasSystem = rootPromptExecutor.getMessages().some(message => message.role === "system");
    if (!hasSystem) {
      const requestContext = await getRequestContext(
        ctx,
        undefined,
        this.resourceAccessor,
        buildRequestContextOptions(this.config as Any),
      );
      const toolSetHandle = this.config.toolsGenerator({
        resourceAccessor: this.resourceAccessor,
        stateHandler,
        agentSessionId: this.config.agentSessionId,
        mcpTools: [],
        repositoryInfos: requestContext.repositoryInfo,
        blobStore: stateHandler.getBlobStore(),
        mode: stateHandler.mode ?? AgentMode.AGENT,
        loggingContext: ctx,
        requestContext,
        fileOperationLockManager: new FileOperationLockManager(),
        smartModeClassifierMode: this.config.smartModeClassifierMode,
        smartModeClassifierShadowMode: this.config.smartModeClassifierShadowMode,
        autoRejectFirstAskQuestion: this.config.autoRejectFirstAskQuestion,
      });
      rootPromptExecutor.appendMessages(toRedactedCoreMessages([
        {
          role: "system",
          content: this.config.systemPromptGenerator({
            cursorRules: [],
            mode: stateHandler.mode ?? AgentMode.AGENT,
          }, toolSetHandle),
        },
      ], stateHandler.getPrivacyMode()));
    }

    const requestContext = await getRequestContext(
      ctx,
      undefined,
      this.resourceAccessor,
      buildRequestContextOptions(this.config as Any),
    );
    const automationTriggerContext = this.config.automationInstructions !== undefined
      ? extractAutomationTriggerContext(rootPromptExecutor.getMessages())
      : undefined;
    const summary = await this.orchestrator.handleSummarization(
      ctx,
      stateHandler,
      rootPromptExecutor,
      this.interactionListener,
      this.config,
      requestContext,
      {
        fullSummarization: true,
        backgroundSummarizationMode: BackgroundSummarizationMode.WaitForCompletion,
        triggerReason: "force_option",
        resourceAccessor: this.resourceAccessor,
        automationTriggerContext,
      },
    );
    if (!summary) throw new Error("No summary generated, even though background summarization mode is WaitForCompletion");

    stateHandler.setSummary(createRedactedConversationSummary(stateHandler.getPrivacyMode(), { summary }));
    await this.interactionListener.sendUpdate(ctx, RedactedUpdates.summary(summary));
    if (this.config.summarizeActionClearTurns) await stateHandler.clearTurns();

    const postSummarizeMessages = rootPromptExecutor.getMessages();
    const estimatedUsedTokens = estimateTokenCount(postSummarizeMessages, { includeNonTextContent: true });
    const previousRedactedBreakdown = stateHandler.tokenDetails.breakdown;
    const refreshedBreakdown = previousRedactedBreakdown !== undefined
      ? toRedactedPromptTokenBreakdownSnapshot(buildSummarizeRefreshSnapshot({
        previousSnapshot: fromRedactedPromptTokenBreakdownSnapshot(previousRedactedBreakdown, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined),
        newSummarizedConversationCharCount: summarizedConversationCharCount(postSummarizeMessages),
        totalUsedTokens: estimatedUsedTokens,
        maxTokens: stateHandler.tokenDetails.maxTokens,
      }), stateHandler.getPrivacyMode())
      : previousRedactedBreakdown;
    stateHandler.setTokenDetails(createRedactedConversationTokenDetails(stateHandler.getPrivacyMode(), {
      usedTokens: estimatedUsedTokens,
      maxTokens: stateHandler.tokenDetails.maxTokens,
      breakdown: refreshedBreakdown,
      promptContextUsageTree: undefined,
    }));
    if (onStateUpdate) {
      if (this.config.fireAndForgetCheckpoints) {
        void stateHandler.computeNewStructure(ctx).then(async checkpoint => {
          await onStateUpdate(ctx, checkpoint);
        }).catch(error => {
          logger.error(ctx, "Failed to persist summarization checkpoint", { error });
        });
      } else {
        const checkpoint = await stateHandler.computeNewStructure(ctx);
        await onStateUpdate(ctx, checkpoint);
      }
    }
    return await stateHandler.computeNewStructure(ctx);
  }
}
