import { BasePromptBuilder, BasePromptExecutor } from "./base.js";

type Loose = Record<string, any>;

export interface MockPromptExecutorOptions {
  response?: string;
  toolCalls?: readonly Loose[];
  streamDelay?: number;
  chunkSize?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    maxTokens?: number;
  };
  simulateError?: unknown;
}

interface NormalizedMockPromptExecutorOptions {
  response: string;
  toolCalls: readonly Loose[];
  streamDelay: number;
  chunkSize: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    maxTokens: number;
  };
  simulateError?: unknown;
}

export function createMockPromptExecutor(options: () => MockPromptExecutorOptions): MockPromptExecutor {
  return new MockPromptExecutor(() => options(), undefined);
}

export class MockPromptBuilder extends BasePromptBuilder<Loose> {}

export class MockPromptExecutor extends BasePromptExecutor<Loose> {
  readonly options: () => NormalizedMockPromptExecutorOptions;

  constructor(options?: () => MockPromptExecutorOptions | undefined, initialMessages?: Loose | readonly Loose[]) {
    super(new MockPromptBuilder(initialMessages));
    this.options = () => {
      const opts = options?.();
      return {
        response: opts?.response ?? "This is a mock response.",
        toolCalls: opts?.toolCalls ?? [],
        streamDelay: opts?.streamDelay ?? 0,
        chunkSize: opts?.chunkSize ?? 1,
        usage: {
          inputTokens: opts?.usage?.inputTokens ?? 10,
          outputTokens: opts?.usage?.outputTokens ?? 20,
          cacheReadTokens: opts?.usage?.cacheReadTokens ?? 0,
          cacheWriteTokens: opts?.usage?.cacheWriteTokens ?? 0,
          maxTokens: opts?.usage?.maxTokens ?? 1_000,
        },
        simulateError: opts?.simulateError,
      };
    };
  }

  stream(_ctx: unknown, invocationId?: string, _tools?: readonly Loose[], _options?: Loose) {
    const options = this.options();
    const responseText = options.response;
    const toolCalls = options.toolCalls;
    const chunkSize = options.chunkSize;
    const streamDelay = options.streamDelay;
    const simulateError = options.simulateError;
    const usage = options.usage;
    const fullStream = (async function*(): AsyncGenerator<Loose> {
      if (responseText) {
        for (let i = 0; i < responseText.length; i += chunkSize) {
          const chunk = responseText.slice(i, i + chunkSize);
          if (streamDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, streamDelay));
          }
          yield { type: "text-delta", textDelta: chunk };
        }
      }
      for (const toolCall of toolCalls) {
        if (streamDelay > 0) {
          await new Promise(resolve => setTimeout(resolve, streamDelay));
        }
        yield {
          type: "tool-call-streaming-start",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        };
        const argsJson = JSON.stringify(toolCall.args);
        for (let i = 0; i < argsJson.length; i += chunkSize) {
          const chunk = argsJson.slice(i, i + chunkSize);
          if (streamDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, streamDelay));
          }
          yield {
            type: "tool-call-delta",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            argsTextDelta: chunk,
          };
        }
        if (streamDelay > 0) {
          await new Promise(resolve => setTimeout(resolve, streamDelay));
        }
        yield {
          type: "tool-call",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.args,
        };
      }
      if (simulateError) {
        yield { type: "error", error: simulateError };
        throw simulateError;
      }
      yield {
        type: "finish",
        finishReason: "stop",
        usage: {
          promptTokens: usage.inputTokens,
          completionTokens: usage.outputTokens,
          totalTokens: usage.inputTokens + usage.outputTokens,
        },
        logprobs: undefined,
        response: {
          id: "mock-response-id",
          timestamp: new Date(),
          modelId: "mock-model",
        },
      };
    })();

    const response = (async () => {
      const content: Loose[] = [];
      if (responseText) {
        content.push({
          type: "text",
          text: simulateError ? responseText.slice(0, chunkSize) : responseText,
        });
      }
      for (const toolCall of toolCalls) {
        content.push({
          type: "tool-call",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.args,
        });
      }
      const messages = [{
        role: "assistant",
        content: content.length > 0 ? content : "",
        id: "mock-message-id",
      }];
      const result: Loose = {
        id: "mock-response-id",
        timestamp: new Date(),
        modelId: "mock-model",
        messages,
      };
      if (simulateError) {
        result.error = simulateError;
      }
      return result;
    })();
    const usagePromise = Promise.resolve({
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
    });
    const extendedUsage = Promise.resolve({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      maxTokens: usage.maxTokens,
    });
    const providerMetadata = Promise.resolve(undefined);
    return {
      fullStream,
      response,
      usage: usagePromise,
      extendedUsage,
      providerMetadata,
      invocationId: Promise.resolve(invocationId ?? crypto.randomUUID()),
    };
  }
}
