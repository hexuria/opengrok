import type { PrivacyMode } from "../redaction/privacy-mode.js";
import type { RedactedString } from "../redaction/types.js";

interface RedactedCarrier {
  readonly _privacyMode: PrivacyMode;
  readonly [key: string]: unknown;
}

interface RedactedInteractionUpdate {
  readonly _privacyMode: PrivacyMode;
  readonly message: {
    readonly case: string;
    readonly value: RedactedCarrier;
  };
}

interface ContextInjectionState {
  readonly kind: "queued" | "delivered" | "queued_for_next_turn" | "cancelled" | "rejected";
  readonly step?: unknown;
  readonly deliveryBatchId?: unknown;
  readonly deliveredAtMs?: string | number | bigint;
  readonly reason?: unknown;
}

function toRedactedContextInjectionStateValue(
  privacyMode: PrivacyMode,
  state: ContextInjectionState,
): RedactedCarrier {
  const _privacyMode = privacyMode;
  switch (state.kind) {
    case "queued":
      return { _privacyMode, state: { case: "queued", value: { _privacyMode } } };
    case "delivered":
      return {
        _privacyMode,
        state: {
          case: "delivered",
          value: {
            _privacyMode,
            step: state.step,
            deliveryBatchId: state.deliveryBatchId,
            deliveredAtMs: BigInt(state.deliveredAtMs!),
          },
        },
      };
    case "queued_for_next_turn":
      return { _privacyMode, state: { case: "queuedForNextTurn", value: { _privacyMode } } };
    case "cancelled":
      return { _privacyMode, state: { case: "cancelled", value: { _privacyMode } } };
    case "rejected":
      return {
        _privacyMode,
        state: { case: "rejected", value: { _privacyMode, reason: state.reason } },
      };
  }
}

export const RedactedUpdates = {
  textDelta(text: RedactedString): RedactedInteractionUpdate {
    const privacyMode = text.__privacyMode;
    return {
      _privacyMode: privacyMode,
      message: {
        case: "textDelta",
        value: { _privacyMode: privacyMode, text, isServerNotice: false },
      },
    };
  },
  toolCallStarted(callId: string, toolCall: RedactedCarrier, modelCallId: unknown): RedactedInteractionUpdate {
    const privacyMode = toolCall._privacyMode;
    return {
      _privacyMode: privacyMode,
      message: { case: "toolCallStarted", value: { _privacyMode: privacyMode, callId, toolCall, modelCallId } },
    };
  },
  toolCallCompleted(callId: string, toolCall: RedactedCarrier, modelCallId: unknown): RedactedInteractionUpdate {
    const privacyMode = toolCall._privacyMode;
    return {
      _privacyMode: privacyMode,
      message: { case: "toolCallCompleted", value: { _privacyMode: privacyMode, callId, toolCall, modelCallId } },
    };
  },
  toolCallDelta(callId: string, toolCallDelta: RedactedCarrier, modelCallId: unknown): RedactedInteractionUpdate {
    const privacyMode = toolCallDelta._privacyMode;
    return {
      _privacyMode: privacyMode,
      message: {
        case: "toolCallDelta",
        value: { _privacyMode: privacyMode, callId, toolCallDelta, modelCallId },
      },
    };
  },
  thinkingDelta(text: RedactedString, thinkingStyle: unknown): RedactedInteractionUpdate {
    const privacyMode = text.__privacyMode;
    return {
      _privacyMode: privacyMode,
      message: { case: "thinkingDelta", value: { _privacyMode: privacyMode, text, thinkingStyle } },
    };
  },
  thinkingCompleted(privacyMode: PrivacyMode, thinkingDurationMs: unknown): RedactedInteractionUpdate {
    return {
      _privacyMode: privacyMode,
      message: { case: "thinkingCompleted", value: { _privacyMode: privacyMode, thinkingDurationMs } },
    };
  },
  userMessageAppended(userMessage: RedactedCarrier): RedactedInteractionUpdate {
    const privacyMode = userMessage._privacyMode;
    return {
      _privacyMode: privacyMode,
      message: { case: "userMessageAppended", value: { _privacyMode: privacyMode, userMessage } },
    };
  },
  partialToolCall(
    callId: string,
    toolCall: RedactedCarrier,
    modelCallId: unknown,
    argsTextDelta: unknown,
  ): RedactedInteractionUpdate {
    const privacyMode = toolCall._privacyMode;
    return {
      _privacyMode: privacyMode,
      message: {
        case: "partialToolCall",
        value: { _privacyMode: privacyMode, callId, toolCall, modelCallId, argsTextDelta },
      },
    };
  },
  tokenDelta(privacyMode: PrivacyMode, tokens: unknown): RedactedInteractionUpdate {
    return {
      _privacyMode: privacyMode,
      message: { case: "tokenDelta", value: { _privacyMode: privacyMode, tokens } },
    };
  },
  summary(summary: RedactedString): RedactedInteractionUpdate {
    const privacyMode = summary.__privacyMode;
    return {
      _privacyMode: privacyMode,
      message: { case: "summary", value: { _privacyMode: privacyMode, summary } },
    };
  },
  summaryStarted(privacyMode: PrivacyMode): RedactedInteractionUpdate {
    return {
      _privacyMode: privacyMode,
      message: { case: "summaryStarted", value: { _privacyMode: privacyMode } },
    };
  },
  heartbeat(privacyMode: PrivacyMode): RedactedInteractionUpdate {
    return {
      _privacyMode: privacyMode,
      message: { case: "heartbeat", value: { _privacyMode: privacyMode } },
    };
  },
  contextInjectionState(
    privacyMode: PrivacyMode,
    injectionId: string,
    state: ContextInjectionState,
  ): RedactedInteractionUpdate {
    return {
      _privacyMode: privacyMode,
      message: {
        case: "contextInjectionState",
        value: {
          _privacyMode: privacyMode,
          injectionId,
          state: toRedactedContextInjectionStateValue(privacyMode, state),
        },
      },
    };
  },
  summaryCompleted(privacyMode: PrivacyMode, hookMessage: unknown): RedactedInteractionUpdate {
    return {
      _privacyMode: privacyMode,
      message: { case: "summaryCompleted", value: { _privacyMode: privacyMode, hookMessage } },
    };
  },
  shellOutputDelta(privacyMode: PrivacyMode, event: unknown): RedactedInteractionUpdate {
    return {
      _privacyMode: privacyMode,
      message: { case: "shellOutputDelta", value: { _privacyMode: privacyMode, event } },
    };
  },
  turnEnded(
    privacyMode: PrivacyMode,
    usage: {
      readonly inputTokens: string | number | bigint;
      readonly outputTokens: string | number | bigint;
      readonly cacheReadTokens: string | number | bigint;
      readonly cacheWriteTokens: string | number | bigint;
      readonly reasoningTokens?: string | number | bigint | null | undefined;
    } | null | undefined,
  ): RedactedInteractionUpdate {
    return {
      _privacyMode: privacyMode,
      message: {
        case: "turnEnded",
        value: Object.assign(
          { _privacyMode: privacyMode },
          usage && {
            inputTokens: BigInt(usage.inputTokens),
            outputTokens: BigInt(usage.outputTokens),
            cacheReadTokens: BigInt(usage.cacheReadTokens),
            cacheWriteTokens: BigInt(usage.cacheWriteTokens),
            reasoningTokens: BigInt(usage.reasoningTokens ?? 0),
          },
        ),
      },
    };
  },
  stepStarted(privacyMode: PrivacyMode, stepId: string | number | bigint): RedactedInteractionUpdate {
    return {
      _privacyMode: privacyMode,
      message: { case: "stepStarted", value: { _privacyMode: privacyMode, stepId: BigInt(stepId) } },
    };
  },
  stepCompleted(
    privacyMode: PrivacyMode,
    stepId: string | number | bigint,
    stepDurationMs: string | number | bigint,
  ): RedactedInteractionUpdate {
    return {
      _privacyMode: privacyMode,
      message: {
        case: "stepCompleted",
        value: {
          _privacyMode: privacyMode,
          stepId: BigInt(stepId),
          stepDurationMs: BigInt(stepDurationMs),
        },
      },
    };
  },
  promptSuggestion(suggestion: RedactedString): RedactedInteractionUpdate {
    const privacyMode = suggestion.__privacyMode;
    return {
      _privacyMode: privacyMode,
      message: { case: "promptSuggestion", value: { _privacyMode: privacyMode, suggestion } },
    };
  },
  activeBranchChange(path: RedactedString, branchName: unknown): RedactedInteractionUpdate {
    const privacyMode = path.__privacyMode;
    return {
      _privacyMode: privacyMode,
      message: { case: "activeBranchChange", value: { _privacyMode: privacyMode, path, branchName } },
    };
  },
  feedbackRequest(
    requestId: string,
    canonicalModelName: string,
    privacyMode: PrivacyMode,
    categories: readonly { readonly id: unknown; readonly label: unknown }[],
    categoryGroups: readonly {
      readonly id: unknown;
      readonly prompt: unknown;
      readonly categories: readonly { readonly id: unknown; readonly label: unknown }[];
    }[] = [],
    copy: {
      readonly title?: unknown;
      readonly negativeTitle?: unknown;
      readonly commentPlaceholder?: unknown;
    } = {},
  ): RedactedInteractionUpdate {
    const toRedactedCategory = (category: { readonly id: unknown; readonly label: unknown }) => ({
      _privacyMode: privacyMode,
      id: category.id,
      label: category.label,
    });
    return {
      _privacyMode: privacyMode,
      message: {
        case: "feedbackRequest",
        value: {
          _privacyMode: privacyMode,
          requestId,
          canonicalModelName,
          categories: categories.map(toRedactedCategory),
          categoryGroups: categoryGroups.map(group => ({
            _privacyMode: privacyMode,
            id: group.id,
            prompt: group.prompt,
            categories: group.categories.map(toRedactedCategory),
          })),
          showFormImmediately: false,
          title: copy.title,
          negativeTitle: copy.negativeTitle,
          commentPlaceholder: copy.commentPlaceholder,
        },
      },
    };
  },
};
