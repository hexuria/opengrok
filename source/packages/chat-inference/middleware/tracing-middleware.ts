import { createCounter, createHistogram } from "../../metrics/index.js";
import { BaseMiddleware, type PromptExecutor } from "../base.js";
import type { Context } from "../../context/core.js";

type Loose = Record<string, any>;

interface PromptStreamResult {
  readonly fullStream: AsyncIterable<Loose>;
  readonly response: Promise<Loose>;
  readonly usage: Promise<unknown>;
  readonly providerMetadata: Promise<unknown>;
  readonly extendedUsage: Promise<unknown>;
  readonly invocationId: Promise<unknown>;
}

function getMessageTextContent(message: Loose): string {
  if (message.role === "user" || message.role === "assistant") {
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content.map((part: Loose) => {
        if (part.type === "text" && "text" in part) {
          return part.text;
        }
        return "";
      }).join("");
    }
  }
  if (message.role === "tool") {
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content.map((part: Loose) => {
        if (part.type === "tool-result" && "result" in part) {
          return typeof part.result === "string" ? part.result : JSON.stringify(part.result);
        }
        return "";
      }).join("");
    }
  }
  return "";
}

function analyzeMessages(messages: readonly Loose[]) {
  const stats = {
    userCount: 0,
    assistantCount: 0,
    toolCount: 0,
    userChars: 0,
    assistantChars: 0,
    toolChars: 0,
  };
  for (const message of messages) {
    const textContent = getMessageTextContent(message);
    const charCount = textContent.length;
    switch (message.role) {
      case "user":
        stats.userCount++;
        stats.userChars += charCount;
        break;
      case "assistant":
        stats.assistantCount++;
        stats.assistantChars += charCount;
        break;
      case "tool":
        stats.toolCount++;
        stats.toolChars += charCount;
        break;
    }
  }
  return stats;
}

const middlewareChainDuration = createHistogram("agent.ttft.middlewareChainMs", {
  description: "Total synchronous time inside the middleware chain from tracing middleware entry to inner stream() returning (may exclude async preprocessing done by middleware wrappers)",
});
const ttftHistogram = createHistogram("chat_inference.ttft_ms", {
  description: "Time to first token in milliseconds",
  labelNames: ["outcome"],
});
const ttfToolCallHistogram = createHistogram("chat_inference.ttf_toolcall_ms", {
  description: "Time to first tool call in milliseconds",
  labelNames: ["outcome"],
});
const e2eLatencyHistogram = createHistogram("chat_inference.e2e_latency_ms", {
  description: "End-to-end latency in milliseconds",
  labelNames: ["outcome"],
});
const inputMessagesHistogram = createHistogram("chat_inference.input_messages", {
  description: "Distribution of input message counts per request",
  labelNames: ["message_type"],
});
const inputCharactersHistogram = createHistogram("chat_inference.input_characters", {
  description: "Distribution of input character counts per request",
  labelNames: ["message_type"],
});
const requestOutcomeCounter = createCounter("chat_inference.request_outcome", {
  description: "Count of request outcomes",
  labelNames: ["outcome"],
});

export class TracingMiddleware extends BaseMiddleware<Loose> {
  override stream(ctx: Context, invocationId?: string, tools?: readonly Loose[], options?: Loose): PromptStreamResult {
    const startTime = performance.now();
    let firstTokenTime: number | null = null;
    let seenFirstToken = false;
    let firstToolCallTime: number | null = null;
    let seenFirstToolCall = false;
    const inputMessages = this.innerExecutor.getMessages();
    const messageStats = analyzeMessages(inputMessages);
    inputMessagesHistogram.histogram(ctx, messageStats.userCount, { message_type: "user" });
    inputMessagesHistogram.histogram(ctx, messageStats.assistantCount, { message_type: "assistant" });
    inputMessagesHistogram.histogram(ctx, messageStats.toolCount, { message_type: "tool" });
    inputCharactersHistogram.histogram(ctx, messageStats.userChars, { message_type: "user" });
    inputCharactersHistogram.histogram(ctx, messageStats.assistantChars, { message_type: "assistant" });
    inputCharactersHistogram.histogram(ctx, messageStats.toolChars, { message_type: "tool" });
    const streamResult = this.innerExecutor.stream(ctx, invocationId, tools, options) as PromptStreamResult;
    middlewareChainDuration.histogram(ctx, performance.now() - startTime);

    const tracedFullStream = async function*(): AsyncGenerator<Loose> {
      try {
        for await (const part of streamResult.fullStream) {
          if (!seenFirstToken) {
            firstTokenTime = performance.now();
            seenFirstToken = true;
            const ttft = firstTokenTime - startTime;
            ttftHistogram.histogram(ctx, ttft, { outcome: "success" });
          }
          if (!seenFirstToolCall && (part.type === "tool-call" || part.type === "tool-call-delta")) {
            firstToolCallTime = performance.now();
            seenFirstToolCall = true;
            const ttfToolCall = firstToolCallTime - startTime;
            ttfToolCallHistogram.histogram(ctx, ttfToolCall, { outcome: "success" });
          }
          yield part;
        }
      } catch (error) {
        if (!seenFirstToken) {
          ttftHistogram.histogram(ctx, performance.now() - startTime, { outcome: "failure" });
        }
        throw error;
      }
    };

    const tracedResponse = streamResult.response.then((response) => {
      const endTime = performance.now();
      const e2eLatency = endTime - startTime;
      e2eLatencyHistogram.histogram(ctx, e2eLatency, { outcome: "success" });
      if (response.error) {
        requestOutcomeCounter.increment(ctx, 1, { outcome: "failure" });
      } else {
        requestOutcomeCounter.increment(ctx, 1, { outcome: "success" });
      }
      return response;
    }).catch((error: unknown) => {
      const endTime = performance.now();
      const e2eLatency = endTime - startTime;
      e2eLatencyHistogram.histogram(ctx, e2eLatency, { outcome: "failure" });
      requestOutcomeCounter.increment(ctx, 1, { outcome: "failure" });
      throw error;
    });

    return {
      fullStream: tracedFullStream(),
      response: tracedResponse,
      usage: streamResult.usage,
      providerMetadata: streamResult.providerMetadata,
      extendedUsage: streamResult.extendedUsage,
      invocationId: streamResult.invocationId,
    };
  }
}

export const createTracingMiddleware = () => {
  return (executor: PromptExecutor<Loose>): TracingMiddleware => new TracingMiddleware(executor);
};

export const tracingMiddleware = createTracingMiddleware();
