import { createKey, type Context } from "../context/core.js";
import { getSpanContextData } from "../context/otel.js";
import { BasePromptBuilder, BasePromptExecutor, type PromptExecutor } from "../chat-inference/base.js";
import { classifyTokenLimitErrorFromMessage } from "../chat-inference/token-limit-error-classification.js";
import { conversationIdKey, requestIdKey } from "../agent/utils/request-id.js";
import {
  InferenceMessageRole,
  type InferenceReason,
  type InferenceExtraData,
  type InferenceImageDescriptionsInfo,
  type InferenceResponseInfo,
  type InferenceStreamResponse,
} from "../proto/generated/aiserver/v1/inference_pb.js";
import {
  buildStreamRequest,
  protoStreamErrorToError,
  toolCallArgsFromProto,
} from "./converters.js";
import { providerOptionsFromModelName } from "./cursorModelProviderOptions.js";

type Loose = Record<string, any>;
type PromptMessage = Loose;
type Middleware = (executor: PromptExecutor<Loose>) => PromptExecutor<Loose>;

export { conversationIdKey, requestIdKey };
export const automationIdKey = createKey<string | undefined>(Symbol("automationId"), undefined);
export const requestedModelKey = createKey<Loose | undefined>(Symbol("requestedModel"), undefined);

interface InferenceClient {
  stream(request: unknown, options: { signal: AbortSignal; headers: Record<string, string> }): AsyncIterable<InferenceStreamResponse>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

export function stampImageDescriptionsOnMessage(
  message: PromptMessage,
  entries: readonly Loose[],
): PromptMessage | undefined {
  if (!Array.isArray(message.content)) return undefined;
  if (message.role === "user") {
    const content = [...message.content];
    let updated = false;
    for (const entry of entries) {
      if (entry.expContentIndex !== undefined) continue;
      const part = content[entry.partIndex];
      if (part === undefined || part.type !== "image") continue;
      content[entry.partIndex] = {
        ...part,
        providerOptions: {
          ...part.providerOptions,
          cursor: { ...part.providerOptions?.cursor, imageDescription: entry.description },
        },
      };
      updated = true;
    }
    return updated ? { ...message, content } : undefined;
  }
  if (message.role === "tool") {
    const content = [...message.content];
    let updated = false;
    for (const entry of entries) {
      if (entry.expContentIndex === undefined) continue;
      const part = content[entry.partIndex];
      if (part === undefined || part.type !== "tool-result" || !Array.isArray(part.experimental_content) ||
          part.experimental_content[entry.expContentIndex]?.type !== "image") continue;
      const descriptions = part.providerOptions?.cursor?.imageDescriptions ?? {};
      content[entry.partIndex] = {
        ...part,
        providerOptions: {
          ...part.providerOptions,
          cursor: {
            ...part.providerOptions?.cursor,
            imageDescriptions: { ...descriptions, [entry.expContentIndex]: entry.description },
          },
        },
      };
      updated = true;
    }
    return updated ? { ...message, content } : undefined;
  }
  return undefined;
}

export class ProtoPromptBuilder extends BasePromptBuilder<PromptMessage> {
  replaceMessage(previous: PromptMessage, next: PromptMessage): boolean {
    const index = this.messages.indexOf(previous);
    if (index === -1) return false;
    this.messages[index] = next;
    return true;
  }
}

interface StreamResolvers {
  usage: Deferred<Loose>;
  extendedUsage: Deferred<Loose>;
  providerMetadata: Deferred<unknown>;
  invocationId: Deferred<string>;
  response: Deferred<Loose>;
}

export class ProtoPromptExecutor extends BasePromptExecutor<PromptMessage> {
  private readonly protoBuilder: ProtoPromptBuilder;

  constructor(
    builder: ProtoPromptBuilder,
    private readonly client: InferenceClient,
    private readonly requestedModel: Loose,
    private readonly modelConfig?: Loose,
    private readonly inferenceReason?: InferenceReason,
  ) {
    super(builder);
    this.protoBuilder = builder;
  }

  private applyImageDescriptions(requestMessages: readonly PromptMessage[], info: InferenceImageDescriptionsInfo): void {
    const grouped = new Map<number, Loose[]>();
    for (const entry of info.descriptions) {
      if (entry.description.length === 0) continue;
      const entries = grouped.get(entry.messageIndex) ?? [];
      entries.push(entry);
      grouped.set(entry.messageIndex, entries);
    }
    for (const [messageIndex, entries] of grouped) {
      const original = requestMessages[messageIndex];
      if (original === undefined) continue;
      const updated = stampImageDescriptionsOnMessage(original, entries);
      if (updated !== undefined) this.protoBuilder.replaceMessage(original, updated);
    }
  }

  stream(
    context: Context,
    invocationId?: string,
    tools?: readonly Loose[],
    options?: Loose,
  ): {
    fullStream: AsyncIterable<Loose>;
    usage: Promise<Loose>;
    extendedUsage: Promise<Loose>;
    providerMetadata: Promise<unknown>;
    invocationId: Promise<string>;
    response: Promise<Loose>;
  } {
    const agentTools: Loose[] = [];
    const providerDefinedTools: Loose[] = [];
    for (const tool of tools ?? []) {
      if ("type" in tool && tool.type === "provider-defined") providerDefinedTools.push(tool);
      else agentTools.push(tool);
    }
    const effectiveModelConfig = options?.maxTokens !== undefined
      ? { ...this.modelConfig, maxTokens: options.maxTokens }
      : this.modelConfig;
    const requestedModel = context.get(requestedModelKey) ?? this.requestedModel;
    const requestMessages = this.builder.getMessages();
    const request = buildStreamRequest({
      messages: requestMessages,
      requestedModel,
      tools: agentTools,
      providerDefinedTools,
      modelConfig: effectiveModelConfig,
      invocationId,
      conversationId: context.get(conversationIdKey),
      automationId: context.get(automationIdKey),
      inferenceReason: this.inferenceReason,
      acceptedUnadvertisedToolNames: options?.acceptedUnadvertisedToolNames,
    });
    const headers: Record<string, string> = {};
    const requestId = context.get(requestIdKey);
    if (requestId) headers["x-request-id"] = requestId;
    try {
      const span = getSpanContextData(context);
      if (span !== undefined) {
        const traceparent = `00-${span.traceId}-${span.spanId}-${span.traceFlags.toString(16).padStart(2, "0")}`;
        headers.traceparent = traceparent;
        headers["backend-traceparent"] = traceparent;
      }
    } catch {}

    const stream = this.client.stream(request, { signal: context.signal, headers });
    const resolvers: StreamResolvers = {
      usage: deferred(),
      extendedUsage: deferred(),
      providerMetadata: deferred(),
      invocationId: deferred(),
      response: deferred(),
    };
    return {
      fullStream: this.createFullStream(stream, resolvers, requestMessages),
      usage: resolvers.usage.promise,
      extendedUsage: resolvers.extendedUsage.promise,
      providerMetadata: resolvers.providerMetadata.promise,
      invocationId: resolvers.invocationId.promise,
      response: resolvers.response.promise,
    };
  }

  private async *createFullStream(
    stream: AsyncIterable<InferenceStreamResponse>,
    resolvers: StreamResolvers,
    requestMessages: readonly PromptMessage[],
  ): AsyncGenerator<Loose> {
    let usageResolved = false;
    let extendedUsageResolved = false;
    let providerMetadataResolved = false;
    let invocationIdResolved = false;
    let responseResolved = false;
    let streamError: Error | undefined;
    try {
      for await (const response of stream) {
        const parts = this.protoResponseToStreamParts(response);
        switch (response.response.case) {
          case "usage": {
            const usage = response.response.value;
            resolvers.usage.resolve({
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens ?? 0,
            });
            usageResolved = true;
            break;
          }
          case "extendedUsage": {
            const usage = response.response.value;
            resolvers.extendedUsage.resolve({
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              maxTokens: usage.maxTokens,
            });
            extendedUsageResolved = true;
            break;
          }
          case "providerMetadata":
            resolvers.providerMetadata.resolve(response.response.value.metadata?.toJson());
            providerMetadataResolved = true;
            break;
          case "invocationId":
            resolvers.invocationId.resolve(response.response.value.invocationId);
            invocationIdResolved = true;
            break;
          case "responseInfo": {
            const info = response.response.value;
            resolvers.response.resolve({
              id: info.id,
              modelId: info.model,
              timestamp: new Date(Number(info.createdAt)),
              messages: this.protoMessagesToResponseMessages(info),
              error: info.errorMessage ? classifyTokenLimitErrorFromMessage(info.errorMessage) ?? new Error(info.errorMessage) : undefined,
              inferenceExtraData: info.inferenceExtraData ? this.protoExtraDataToInferenceExtraData(info.inferenceExtraData) : undefined,
            });
            responseResolved = true;
            break;
          }
          case "error":
            streamError = protoStreamErrorToError(response.response.value);
            break;
          case "imageDescriptions":
            this.applyImageDescriptions(requestMessages, response.response.value);
            break;
        }
        for (const part of parts) yield part;
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error));
    }
    if (!usageResolved) streamError ? resolvers.usage.reject(streamError) : resolvers.usage.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    if (!extendedUsageResolved) streamError ? resolvers.extendedUsage.reject(streamError) : resolvers.extendedUsage.resolve({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 });
    if (!providerMetadataResolved) streamError ? resolvers.providerMetadata.reject(streamError) : resolvers.providerMetadata.resolve(undefined);
    if (!invocationIdResolved) streamError ? resolvers.invocationId.reject(streamError) : resolvers.invocationId.resolve(globalThis.crypto.randomUUID());
    if (!responseResolved) streamError ? resolvers.response.reject(streamError) : resolvers.response.resolve({ id: "", modelId: "", timestamp: new Date(), messages: [] });
    if (streamError) throw streamError;
  }

  private protoResponseToStreamParts(response: InferenceStreamResponse): Loose[] {
    const parts: Loose[] = [];
    switch (response.response.case) {
      case "textPart": {
        const part = response.response.value;
        if (part.isFinal) parts.push({ type: "finish", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
        else if (part.text) parts.push({ type: "text-delta", textDelta: part.text });
        break;
      }
      case "thinkingPart": {
        const part = response.response.value;
        if (part.text) parts.push({ type: "reasoning", textDelta: part.text });
        if (part.signature) parts.push({ type: "reasoning-signature", signature: part.signature });
        break;
      }
      case "toolCallPart": {
        const part = response.response.value;
        if (part.isComplete) {
          let args: unknown;
          try { args = JSON.parse(part.args); } catch { args = {}; }
          parts.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, args });
        } else if (part.toolName) {
          parts.push({ type: "tool-call-streaming-start", toolCallId: part.toolCallId, toolName: part.toolName });
        } else {
          parts.push({ type: "tool-call-delta", toolCallId: part.toolCallId, toolName: "", argsTextDelta: part.args });
        }
        break;
      }
      case "error":
        parts.push({ type: "error", error: protoStreamErrorToError(response.response.value) });
        break;
    }
    return parts;
  }

  private protoMessagesToResponseMessages(info: InferenceResponseInfo): Loose[] {
    return info.messages.map((message) => {
      const role = message.role === InferenceMessageRole.TOOL ? "tool" : "assistant";
      if (role === "assistant") {
        const content: Loose[] = [];
        for (const reasoning of message.reasoningParts) {
          if (reasoning.isRedacted) content.push({ type: "redacted-reasoning", data: reasoning.redactedData ?? "", ...providerOptionsFromModelName(reasoning.modelName) });
          else {
            const part: Loose = { type: "reasoning", text: reasoning.text, ...providerOptionsFromModelName(reasoning.modelName) };
            if (reasoning.signature !== undefined) part.signature = reasoning.signature;
            content.push(part);
          }
        }
        if (message.content) content.push({ type: "text", text: message.content });
        for (const call of message.toolCalls) content.push({ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, args: toolCallArgsFromProto(call) });
        return { id: message.id, role, content };
      }
      return {
        id: message.id,
        role,
        content: message.toolResult?.parts.map((part) => ({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: part.result?.toJson(),
          isError: part.isError || undefined,
        })) ?? [],
      };
    });
  }

  private protoExtraDataToInferenceExtraData(data: InferenceExtraData): Loose {
    return {
      tokenLogprobs: data.tokenLogprobs.length ? data.tokenLogprobs.map((values) => values.values) : undefined,
      tokenIds: data.tokenIds.length ? data.tokenIds.map((ids) => ids.values.map(Number)) : undefined,
      promptTokenIds: data.promptTokenIds.length ? data.promptTokenIds.map((ids) => ids.values.map(Number)) : undefined,
      extraTokens: data.extraTokens.length ? data.extraTokens.map((ids) => ids.values.map(Number)) : undefined,
      extraLogprobs: data.extraLogprobs.length ? data.extraLogprobs.map((values) => values.values) : undefined,
      routingMatrix: data.routingMatrix.length ? data.routingMatrix.map((row) => row.values.map((value) => value === "" ? null : value)) : undefined,
    };
  }
}

export class ProtoPromptSession {
  constructor(
    private readonly client: InferenceClient,
    private readonly requestedModel: Loose,
    private readonly middleware?: Middleware,
    private readonly modelConfig?: Loose,
    private readonly inferenceReason?: InferenceReason,
  ) {}

  getExecutor(state?: PromptMessage | readonly PromptMessage[]): PromptExecutor<Loose> {
    const builder = new ProtoPromptBuilder(state);
    const executor = new ProtoPromptExecutor(builder, this.client, this.requestedModel, this.modelConfig, this.inferenceReason);
    return this.middleware ? this.middleware(executor) : executor;
  }

  getModelId(): string { return this.requestedModel.modelId; }
}

export class ProtoSessionProvider {
  constructor(
    private readonly client: InferenceClient,
    private readonly requestedModel: Loose,
    private readonly modelConfig?: Loose,
    private readonly inferenceReason?: InferenceReason,
  ) {}

  getSession(middleware?: Middleware): ProtoPromptSession {
    return new ProtoPromptSession(this.client, this.requestedModel, middleware, this.modelConfig, this.inferenceReason);
  }
  getProviderName(): string { return "proto"; }
  getModelId(): string { return this.requestedModel.modelId; }
  getThinkingDetails(): undefined { return undefined; }
}

export function createProtoSessionProvider(
  client: InferenceClient,
  requestedModel: Loose,
  modelConfig?: Loose,
  inferenceReason?: InferenceReason,
): ProtoSessionProvider {
  return new ProtoSessionProvider(client, requestedModel, modelConfig, inferenceReason);
}
