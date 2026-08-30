import { randomUUID } from "node:crypto";

import type { Context } from "../../context/core.js";
import { createLogger } from "../../context/logger.js";
import type { AskQuestionResult } from "../../proto/generated/agent/v1/ask_question_tool_pb.js";
import type { PrivacyMode } from "../../redaction/privacy-mode.js";
import { PrivacyCapability } from "../../redaction/classification.js";
import { toRedactedCoreMessages } from "../../redaction/core-message.js";
import type { RedactedString } from "../../redaction/types.js";
import {
  createRedactedAskQuestionArgs,
  createRedactedAskQuestionToolCall,
  fromRedactedAskQuestionResult,
} from "../../redacted-protos/generated/agent/v1/ask_question_tool_redacted.js";
import { createRedactedToolCall } from "../../redacted-protos/generated/agent/v1/agent_redacted.js";
import {
  formatAskQuestionResultAsString,
  shouldReceiptAskQuestionResult,
} from "../tools/core/ask-question/index.js";

interface RedactedAskQuestionOption {
  readonly id: string;
  readonly label: RedactedString;
}

interface RedactedAskQuestionQuestion {
  readonly id: string;
  readonly prompt: RedactedString;
  readonly allowMultiple: boolean;
  readonly options: readonly RedactedAskQuestionOption[];
}

interface RedactedAskQuestionArgs {
  readonly title: RedactedString;
  readonly questions: readonly RedactedAskQuestionQuestion[];
}

interface RedactedAskQuestionSuccessAnswer {
  readonly questionId: string;
  readonly selectedOptionIds: readonly string[];
  readonly freeformText: RedactedString;
}

type RedactedAskQuestionResult = {
  readonly result:
    | { readonly case: "success"; readonly value: { readonly answers: readonly RedactedAskQuestionSuccessAnswer[] } }
    | { readonly case: "error"; readonly value: { readonly errorMessage: RedactedString } }
    | { readonly case: "rejected"; readonly value: { readonly reason: RedactedString } }
    | { readonly case: "async"; readonly value: unknown }
    | { readonly case: undefined; readonly value?: undefined };
};

export interface AskQuestionCompletionAction {
  readonly _privacyMode: PrivacyMode;
  readonly originalToolCallId: string;
  readonly originalArgs?: RedactedAskQuestionArgs | undefined;
  readonly result?: RedactedAskQuestionResult | undefined;
}

interface AskQuestionCompletionStateHandler {
  hasCompletedAskQuestion(toolCallId: string): boolean;
  markAskQuestionCompleted(toolCallId: string): void;
  getPrivacyMode(): PrivacyMode;
}

interface AskQuestionCompletionTurn {
  upsertToolCall(ctx: Context, toolCall: unknown, toolCallId: string): Promise<unknown>;
}

interface AskQuestionCompletionPromptExecutor {
  appendMessages(messages: readonly unknown[]): unknown;
}

interface ApplyAskQuestionCompletionArgs {
  readonly action: AskQuestionCompletionAction;
  readonly stateHandler: AskQuestionCompletionStateHandler;
  readonly turn: AskQuestionCompletionTurn;
  readonly rootPromptExecutor: AskQuestionCompletionPromptExecutor;
  readonly resultFormat: "formatted-string" | string;
}

interface AppliedAskQuestionCompletion {
  readonly outcome: "applied";
  readonly recordedToolCallId: string;
  readonly toolCall: ReturnType<typeof createRedactedToolCall>;
  readonly promptMessages: ReturnType<typeof toRedactedCoreMessages>;
}

type AskQuestionCompletionApplication =
  | AppliedAskQuestionCompletion
  | { readonly outcome: "invalid" | "already-applied" };

const logger = createLogger("@anysphere/agent/ask-question-completion");

export function isValidAskQuestionCompletion(action: AskQuestionCompletionAction): boolean {
  const resultCase = action.result?.result.case;
  return action.originalToolCallId.length > 0 &&
    (resultCase === "success" || resultCase === "rejected" || resultCase === "error");
}

export function hasAppliedAskQuestionCompletion(
  stateHandler: AskQuestionCompletionStateHandler,
  originalToolCallId: string,
): boolean {
  return originalToolCallId.length > 0 &&
    stateHandler.hasCompletedAskQuestion(originalToolCallId);
}

export async function applyAskQuestionCompletion(
  ctx: Context,
  args: ApplyAskQuestionCompletionArgs,
): Promise<AskQuestionCompletionApplication> {
  const { action, stateHandler, turn, rootPromptExecutor, resultFormat } = args;
  const originalToolCallId = action.originalToolCallId;
  if (!isValidAskQuestionCompletion(action)) {
    logger.warn(ctx, "Dropping invalid ask_question completion", {
      originalToolCallId,
      resultCase: action.result?.result.case,
    });
    return { outcome: "invalid" };
  }
  if (
    originalToolCallId.length > 0 &&
    stateHandler.hasCompletedAskQuestion(originalToolCallId)
  ) {
    logger.info(ctx, "Dropping duplicate ask_question completion (already applied)", {
      originalToolCallId,
    });
    return { outcome: "already-applied" };
  }
  const syntheticArgs = action.originalArgs
    ? createRedactedAskQuestionArgs(action._privacyMode, {
      title: action.originalArgs.title,
      questions: action.originalArgs.questions,
      asyncOriginalToolCallId: originalToolCallId,
    })
    : undefined;
  const syntheticToolCall = createRedactedAskQuestionToolCall(action._privacyMode, {
    args: syntheticArgs,
    result: action.result,
  });
  const recordedToolCallId = originalToolCallId.length > 0 ? originalToolCallId : randomUUID();
  const promptToolCallId = randomUUID();
  const toolCall = createRedactedToolCall(action._privacyMode, {
    toolCallId: recordedToolCallId,
    tool: {
      case: "askQuestionToolCall",
      value: syntheticToolCall,
    },
  });
  const argsPlainObject = {
    title: action.originalArgs?.title?.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) ?? "",
    questions: action.originalArgs?.questions.map(question => ({
      id: question.id,
      prompt: question.prompt.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      allow_multiple: question.allowMultiple,
      options: question.options.map(option => ({
        id: option.id,
        label: option.label.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      })),
    })) ?? [],
    async_original_tool_call_id: originalToolCallId,
  };
  const assistantMessage = {
    role: "assistant",
    content: [{
      type: "tool-call",
      toolCallId: promptToolCallId,
      toolName: "ask_question",
      args: argsPlainObject,
    }],
  };
  const toolMessage = {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: promptToolCallId,
      toolName: "ask_question",
      result: formatCompletionResult(action, resultFormat),
    }],
  };
  const promptMessages = toRedactedCoreMessages(
    [assistantMessage, toolMessage],
    stateHandler.getPrivacyMode(),
  );
  await turn.upsertToolCall(ctx, toolCall, recordedToolCallId);
  rootPromptExecutor.appendMessages(promptMessages);
  if (
    originalToolCallId.length > 0 &&
    shouldReceiptAskQuestionResult(
      action.result
        ? (fromRedactedAskQuestionResult as unknown as (
          value: RedactedAskQuestionResult,
          purpose: PrivacyCapability,
        ) => AskQuestionResult)(
          action.result,
          PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
        )
        : undefined,
    )
  ) {
    stateHandler.markAskQuestionCompleted(originalToolCallId);
  }
  return {
    outcome: "applied",
    recordedToolCallId,
    toolCall,
    promptMessages,
  };
}

function formatCompletionResult(
  action: AskQuestionCompletionAction,
  resultFormat: string,
): string {
  if (resultFormat === "formatted-string") {
    return action.result
      ? formatAskQuestionResultAsString(
        (fromRedactedAskQuestionResult as unknown as (
          value: RedactedAskQuestionResult,
          purpose: PrivacyCapability,
        ) => AskQuestionResult)(action.result, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
      )
      : "Unknown error";
  }
  let resultPlainObject: Record<string, unknown>;
  if (action.result?.result.case === "success") {
    resultPlainObject = {
      success: {
        answers: action.result.result.value.answers.map(answer => ({
          question_id: answer.questionId,
          selected_option_ids: answer.selectedOptionIds,
          freeform_text: answer.freeformText.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
        })),
      },
    };
  } else if (action.result?.result.case === "rejected") {
    resultPlainObject = {
      rejected: {
        reason: action.result.result.value.reason.unwrap(
          PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
        ),
      },
    };
  } else if (action.result?.result.case === "error") {
    resultPlainObject = {
      error: {
        error_message: action.result.result.value.errorMessage.unwrap(
          PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
        ),
      },
    };
  } else {
    resultPlainObject = {};
  }
  return JSON.stringify(resultPlainObject);
}
