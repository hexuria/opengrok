import {
  ActiveBranchChange,
  FeedbackRequestUpdate,
  HeartbeatUpdate,
  InteractionUpdate,
  PartialToolCallUpdate,
  PromptSuggestionUpdate,
  ShellOutputDeltaUpdate,
  StepCompletedUpdate,
  StepStartedUpdate,
  SummaryCompletedUpdate,
  SummaryStartedUpdate,
  SummaryUpdate,
  TextDeltaUpdate,
  ThinkingCompletedUpdate,
  ThinkingDeltaUpdate,
  TokenDeltaUpdate,
  ToolCallCompletedUpdate,
  ToolCallDeltaUpdate,
  ToolCallStartedUpdate,
  TurnEndedUpdate,
  UserMessageAppendedUpdate,
  type FeedbackRequestCategory,
  type FeedbackRequestCategoryGroup,
} from "../proto/generated/agent/v1/agent_pb.js";

export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens?: number;
}

export interface FeedbackRequestCopy {
  readonly title?: string;
  readonly negativeTitle?: string;
  readonly commentPlaceholder?: string;
}

export const Updates = {
  textDelta(text: string): InteractionUpdate {
    return new InteractionUpdate({
      message: { case: "textDelta", value: new TextDeltaUpdate({ text }) },
    });
  },
  toolCallStarted(
    callId: string,
    toolCall: ToolCallStartedUpdate["toolCall"],
    modelCallId: string,
  ): InteractionUpdate {
    return new InteractionUpdate({
      message: {
        case: "toolCallStarted",
        value: new ToolCallStartedUpdate({ callId, toolCall: toolCall!, modelCallId }),
      },
    });
  },
  toolCallCompleted(
    callId: string,
    toolCall: ToolCallCompletedUpdate["toolCall"],
    modelCallId: string,
  ): InteractionUpdate {
    return new InteractionUpdate({
      message: {
        case: "toolCallCompleted",
        value: new ToolCallCompletedUpdate({ callId, toolCall: toolCall!, modelCallId }),
      },
    });
  },
  toolCallDelta(
    callId: string,
    toolCallDelta: ToolCallDeltaUpdate["toolCallDelta"],
    modelCallId: string,
  ): InteractionUpdate {
    return new InteractionUpdate({
      message: {
        case: "toolCallDelta",
        value: new ToolCallDeltaUpdate({ callId, toolCallDelta: toolCallDelta!, modelCallId }),
      },
    });
  },
  thinkingDelta(text: string, thinkingStyle: ThinkingDeltaUpdate["thinkingStyle"]): InteractionUpdate {
    return new InteractionUpdate({
      message: {
        case: "thinkingDelta",
        value: new ThinkingDeltaUpdate({ text, thinkingStyle: thinkingStyle! }),
      },
    });
  },
  thinkingCompleted(thinkingDurationMs: number): InteractionUpdate {
    return new InteractionUpdate({
      message: {
        case: "thinkingCompleted",
        value: new ThinkingCompletedUpdate({ thinkingDurationMs }),
      },
    });
  },
  userMessageAppended(userMessage: UserMessageAppendedUpdate["userMessage"]): InteractionUpdate {
    return new InteractionUpdate({
      message: {
        case: "userMessageAppended",
        value: new UserMessageAppendedUpdate({ userMessage: userMessage! }),
      },
    });
  },
  partialToolCall(
    callId: string,
    toolCall: PartialToolCallUpdate["toolCall"],
    modelCallId: string,
  ): InteractionUpdate {
    return new InteractionUpdate({
      message: {
        case: "partialToolCall",
        value: new PartialToolCallUpdate({ callId, toolCall: toolCall!, modelCallId }),
      },
    });
  },
  tokenDelta(tokens: number): InteractionUpdate {
    return new InteractionUpdate({
      message: { case: "tokenDelta", value: new TokenDeltaUpdate({ tokens }) },
    });
  },
  summary(summary: string): InteractionUpdate {
    return new InteractionUpdate({
      message: { case: "summary", value: new SummaryUpdate({ summary }) },
    });
  },
  summaryStarted(): InteractionUpdate {
    return new InteractionUpdate({
      message: { case: "summaryStarted", value: new SummaryStartedUpdate() },
    });
  },
  heartbeat(): InteractionUpdate {
    return new InteractionUpdate({
      message: { case: "heartbeat", value: new HeartbeatUpdate() },
    });
  },
  summaryCompleted(hookMessage: SummaryCompletedUpdate["hookMessage"]): InteractionUpdate {
    return new InteractionUpdate({
      message: {
        case: "summaryCompleted",
        value: new SummaryCompletedUpdate({ hookMessage: hookMessage! }),
      },
    });
  },
  shellOutputDelta(event: ShellOutputDeltaUpdate["event"]): InteractionUpdate {
    return new InteractionUpdate({
      message: {
        case: "shellOutputDelta",
        value: new ShellOutputDeltaUpdate({ event }),
      },
    });
  },
  turnEnded(usage?: TurnUsage): InteractionUpdate {
    return new InteractionUpdate({
      message: {
        case: "turnEnded",
        value: new TurnEndedUpdate(usage ? {
          inputTokens: BigInt(usage.inputTokens),
          outputTokens: BigInt(usage.outputTokens),
          cacheReadTokens: BigInt(usage.cacheReadTokens),
          cacheWriteTokens: BigInt(usage.cacheWriteTokens),
          reasoningTokens: BigInt(usage.reasoningTokens ?? 0),
        } : {}),
      },
    });
  },
  stepStarted(stepId: number): InteractionUpdate {
    return new InteractionUpdate({
      message: { case: "stepStarted", value: new StepStartedUpdate({ stepId: BigInt(stepId) }) },
    });
  },
  stepCompleted(stepId: number, stepDurationMs: number): InteractionUpdate {
    return new InteractionUpdate({
      message: {
        case: "stepCompleted",
        value: new StepCompletedUpdate({
          stepId: BigInt(stepId),
          stepDurationMs: BigInt(stepDurationMs),
        }),
      },
    });
  },
  promptSuggestion(suggestion: string): InteractionUpdate {
    return new InteractionUpdate({
      message: {
        case: "promptSuggestion",
        value: new PromptSuggestionUpdate({ suggestion }),
      },
    });
  },
  activeBranchChange(path: string, branchName: string): InteractionUpdate {
    return new InteractionUpdate({
      message: {
        case: "activeBranchChange",
        value: new ActiveBranchChange({ path, branchName }),
      },
    });
  },
  feedbackRequest(
    requestId: string,
    canonicalModelName: string | undefined,
    categories: readonly FeedbackRequestCategory[],
    categoryGroups: readonly FeedbackRequestCategoryGroup[] = [],
    copy: FeedbackRequestCopy = {},
  ): InteractionUpdate {
    return new InteractionUpdate({
      message: {
        case: "feedbackRequest",
        value: new FeedbackRequestUpdate({
          requestId,
          canonicalModelName: canonicalModelName!,
          categories: [...categories],
          categoryGroups: [...categoryGroups],
          title: copy.title!,
          negativeTitle: copy.negativeTitle!,
          commentPlaceholder: copy.commentPlaceholder!,
        }),
      },
    });
  },
};
