import { ToolErrorClassification } from "./tools/core.js";

type ToolResultRecorder = (
  ctx: unknown,
  result: unknown,
  loggedToolName: unknown,
  errorClassification: ToolErrorClassification | undefined,
) => Promise<void>;

interface ToolCountingExecutor {
  appendMessages(messages: unknown): unknown;
  getState(): unknown;
  getMessages(): unknown;
  clearMessages(): unknown;
  executeToolStream(
    ctx: unknown,
    convState: unknown,
    interactionHandler: unknown,
    tools: unknown,
    extraT: unknown,
    recordToolCallResult: ToolResultRecorder,
    descriptionProps: unknown,
    firstToolCallHook: unknown,
  ): unknown;
  executeModelStreamOnly(
    ctx: unknown,
    convState: unknown,
    interactionHandler: unknown,
    tools: unknown,
    descriptionProps: unknown,
    firstToolCallHook: unknown,
  ): unknown;
  stream(ctx: unknown, invocationId: unknown, tools: unknown, options: unknown): unknown;
}

export class ToolCountingStateTracker {
  toolCallCount = 0;
  readonly resultClassificationCounts = new Map<ToolErrorClassification, number>();

  getFailedToolCallCount(): number {
    return Array.from(this.resultClassificationCounts.values()).reduce(
      (sum, count) => sum + count,
      0,
    );
  }

  getUnexpectedToolCallErrorCount(): number {
    return (this.resultClassificationCounts.get(ToolErrorClassification.TIMEOUT) ?? 0) +
      (this.resultClassificationCounts.get(ToolErrorClassification.PROVIDER_ERROR) ?? 0) +
      (this.resultClassificationCounts.get(ToolErrorClassification.BAD_USER_DEVICE_STATE) ?? 0) +
      (this.resultClassificationCounts.get(ToolErrorClassification.OTHER_ERROR) ?? 0);
  }

  hasFailedToolCalls(): "true" | "false" {
    return this.getFailedToolCallCount() > 0 ? "true" : "false";
  }

  hasUnexpectedToolCallErrors(): "true" | "false" {
    return this.getUnexpectedToolCallErrorCount() > 0 ? "true" : "false";
  }
}

export function createToolCountingMiddleware(
  state: ToolCountingStateTracker,
): (executor: ToolCountingExecutor) => ToolCountingExecutor {
  return executor => ({
    appendMessages(messages) {
      executor.appendMessages(messages);
      return this;
    },
    getState() {
      return executor.getState();
    },
    getMessages() {
      return executor.getMessages();
    },
    clearMessages() {
      executor.clearMessages();
    },
    executeToolStream(
      ctx,
      convState,
      interactionHandler,
      tools,
      extraT,
      recordToolCallResult,
      descriptionProps,
      firstToolCallHook,
    ) {
      return executor.executeToolStream(
        ctx,
        convState,
        interactionHandler,
        tools,
        extraT,
        async (innerCtx, result, loggedToolName, errorClassification) => {
          await recordToolCallResult(innerCtx, result, loggedToolName, errorClassification);
          state.toolCallCount++;
          if (errorClassification !== undefined) {
            const currentCount = state.resultClassificationCounts.get(errorClassification) ?? 0;
            state.resultClassificationCounts.set(errorClassification, currentCount + 1);
          }
        },
        descriptionProps,
        firstToolCallHook,
      );
    },
    executeModelStreamOnly(
      ctx,
      convState,
      interactionHandler,
      tools,
      descriptionProps,
      firstToolCallHook,
    ) {
      return executor.executeModelStreamOnly(
        ctx,
        convState,
        interactionHandler,
        tools,
        descriptionProps,
        firstToolCallHook,
      );
    },
    stream(ctx, invocationId, tools, options) {
      return executor.stream(ctx, invocationId, tools, options);
    },
  });
}
