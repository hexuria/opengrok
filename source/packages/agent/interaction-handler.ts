import { createLogger, createSpan } from "../context/index.js";
import { createCounter, createHistogram } from "../metrics/index.js";
import { Updates } from "../agent-core/interaction-updates.js";
import { InputTokenLimitError } from "../chat-inference/prompt-executor.js";
import { EditArgs } from "../proto/generated/agent/v1/edit_tool_pb.js";
import { ToolCall } from "../proto/generated/agent/v1/agent_pb.js";
import { PrivacyMode } from "../proto/generated/aiserver/v1/privacy_mode_pb.js";
import { toRedactedToolCall } from "../redacted-protos/generated/agent/v1/agent_redacted.js";
import { ToolCallAbortedError } from "./tools/common.js";
import { AgentLoopError, checkForAgentSingleMessageLooping, SingleMessageLoopDetector } from "./loop-detection/agent-loop-detector.js";

type Loose = any;

function requireGeneratedToolCall(value: unknown): ToolCall {
  if (value instanceof ToolCall && typeof value.clone === "function" && typeof value.toBinary === "function") return value;
  const constructorName = typeof value === "object" && value !== null
    ? Object.getPrototypeOf(value)?.constructor?.name ?? "unknown"
    : typeof value;
  const keys = typeof value === "object" && value !== null ? Object.keys(value).sort().join(",") : "";
  throw new TypeError(`tool call carrier is not agent.v1.ToolCall (constructor=${constructorName}; keys=${keys})`);
}

const logger = createLogger("interaction-handler");
const THINKING_RELATED_CHUNK_TYPES = ["reasoning", "reasoning-signature", "redacted-reasoning"];
const toolCallLatency = createHistogram("agent.tool_call.latency_ms", {
  description: "Latency of tool calls in milliseconds",
  labelNames: ["tool_name"],
});
const toolCallCount = createCounter("agent.tool_call.count", {
  description: "Total number of tool calls executed",
  labelNames: ["tool_name"],
});
const toolCallOutputTokens = createHistogram("agent.tool_call.output_tokens", {
  description: "Approximate number of tokens in tool call output (text.length / 4)",
  labelNames: ["tool_name"],
});
const toolCallResultTokens = createHistogram("agent.tool_call_result_tokens", {
  description: "Number of tokens in tool call result content",
  labelNames: ["tool_name", "success"],
});

export class InteractionHandler {
  declare readonly interactionProvider: Loose;
  declare readonly toolCallRecorder: Loose;
  declare readonly invocationId: string;
  declare readonly overrideSignal: AbortSignal | undefined;
  declare readonly thinkingStyle: Loose;
  declare readonly enableSingleMessageLoopDetection: boolean;
  declare readonly onThinkingCompleted: Loose;
  declare readonly latestToolCallsById: Map<string, Loose>;
  declare readonly shouldPreserveArgsOnErrorCallIds: Set<string>;
  declare readonly toolCallStartedAtMsByCallId: Map<string, number>;
  declare leftoverTokenCharCount: number;

  constructor(
    interactionProvider: Loose,
    toolCallRecorder: Loose,
    invocationId: string,
    overrideSignal?: AbortSignal,
    thinkingStyle?: Loose,
    enableSingleMessageLoopDetection = false,
    onThinkingCompleted?: Loose,
  ) {
    this.interactionProvider = interactionProvider;
    this.toolCallRecorder = toolCallRecorder;
    this.invocationId = invocationId;
    this.overrideSignal = overrideSignal;
    this.thinkingStyle = thinkingStyle;
    this.enableSingleMessageLoopDetection = enableSingleMessageLoopDetection;
    this.onThinkingCompleted = onThinkingCompleted;
    this.latestToolCallsById = new Map();
    this.shouldPreserveArgsOnErrorCallIds = new Set();
    this.toolCallStartedAtMsByCallId = new Map();
    this.leftoverTokenCharCount = 0;
  }

  get listener(): Loose {
    return this.interactionProvider;
  }

  getAbortSignal(ctx: Loose): AbortSignal {
    return this.overrideSignal ?? ctx.signal;
  }

  markToolCallForArgPreservation(callId: string): void {
    this.shouldPreserveArgsOnErrorCallIds.add(callId);
  }

  rememberToolCallForArgPreservation(callId: string, toolCall: Loose): void {
    this.rememberLatestToolCall(callId, toolCall);
  }

  applyArgsFromLatestToolCall(callId: string, incomingToolCall: Loose): Loose {
    const latestToolCall = this.latestToolCallsById.get(callId);
    if (latestToolCall === undefined || latestToolCall.tool.case !== incomingToolCall.tool.case) return incomingToolCall;
    const mergedToolCall = incomingToolCall.clone();
    if (mergedToolCall.tool.case === "createAgentToolCall" && latestToolCall.tool.case === "createAgentToolCall") {
      const latestArgs = latestToolCall.tool.value.args;
      if (latestArgs !== undefined) mergedToolCall.tool.value.args = latestArgs.clone();
      return mergedToolCall;
    }
    if (mergedToolCall.tool.case === "sendToAgentToolCall" && latestToolCall.tool.case === "sendToAgentToolCall") {
      const latestArgs = latestToolCall.tool.value.args;
      if (latestArgs !== undefined) mergedToolCall.tool.value.args = latestArgs.clone();
      return mergedToolCall;
    }
    if (mergedToolCall.tool.case === "editToolCall" && latestToolCall.tool.case === "editToolCall") {
      const latestArgs = latestToolCall.tool.value.args;
      if (latestArgs === undefined) return mergedToolCall;
      const mergedArgs = mergedToolCall.tool.value.args;
      if (mergedArgs === undefined) {
        mergedToolCall.tool.value.args = latestArgs.clone();
        return mergedToolCall;
      }
      if (mergedArgs.path.length === 0 && latestArgs.path.length > 0) mergedArgs.path = latestArgs.path;
      if (mergedArgs.streamContent === undefined && latestArgs.streamContent !== undefined) mergedArgs.streamContent = latestArgs.streamContent;
      return mergedToolCall;
    }
    return mergedToolCall;
  }

  rememberLatestToolCall(callId: string, toolCall: Loose): void {
    if (!this.shouldPreserveArgsOnErrorCallIds.has(callId)) return;
    this.latestToolCallsById.set(callId, this.applyArgsFromLatestToolCall(callId, toolCall));
  }

  async upsertRecordedToolCall(ctx: Loose, callId: string, toolCall: Loose): Promise<void> {
    if (this.toolCallRecorder.upsertToolCall !== undefined) {
      await this.toolCallRecorder.upsertToolCall(ctx, toolCall, callId);
      return;
    }
    this.toolCallRecorder.recordToolCall(toolCall, callId);
  }

  applyDeltaToLatestToolCall(callId: string, toolCallDelta: Loose): void {
    if (!this.shouldPreserveArgsOnErrorCallIds.has(callId)) return;
    const latestToolCall = this.latestToolCallsById.get(callId);
    if (latestToolCall?.tool.case !== "editToolCall" || toolCallDelta.delta.case !== "editToolCallDelta") return;
    const editToolCall = latestToolCall.tool.value;
    editToolCall.args ??= new EditArgs();
    editToolCall.args.streamContent = (editToolCall.args.streamContent ?? "") + toolCallDelta.delta.value.streamContentDelta;
  }

  withToolCallMetadata(callId: string, value: ToolCall, timestamps?: { startedAtMs?: number | undefined; completedAtMs?: number | undefined }): ToolCall {
    const toolCall = requireGeneratedToolCall(value);
    const startedAtMs = timestamps?.startedAtMs !== undefined ? BigInt(timestamps.startedAtMs) : undefined;
    const completedAtMs = timestamps?.completedAtMs !== undefined ? BigInt(timestamps.completedAtMs) : undefined;
    if (toolCall.toolCallId === callId && (startedAtMs === undefined || toolCall.startedAtMs === startedAtMs) && (completedAtMs === undefined || toolCall.completedAtMs === completedAtMs)) return toolCall;
    const stamped = toolCall.clone();
    stamped.toolCallId = callId;
    if (startedAtMs !== undefined) stamped.startedAtMs = startedAtMs;
    if (completedAtMs !== undefined) stamped.completedAtMs = completedAtMs;
    return stamped;
  }

  async emitTokenDeltaFromChars(ctx: Loose, newChars: string): Promise<void> {
    const combinedLength = this.leftoverTokenCharCount + newChars.length;
    const tokens = Math.floor(combinedLength / 4);
    this.leftoverTokenCharCount = combinedLength % 4;
    if (tokens > 0) await this.interactionProvider.sendUpdate(ctx, Updates.tokenDelta(tokens));
  }

  isConsumerSideError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (error.name === "CacheRuntimeError" || error.message.includes("Cache operation") || error.message.includes("Redis") || error.message.includes("xadd")) return true;
    const stack = error.stack ?? "";
    const stackFrames = stack.split("\n").slice(1).join("\n");
    return stackFrames.includes("sendUpdate") || stackFrames.includes("appendUpdateToConversationStreamAsync") || stackFrames.includes("pushAsync") || stackFrames.includes("conversationStream");
  }

  async consumeStream(ctx: Loose, fullStream: AsyncIterable<Loose>, textHandler: Loose): Promise<void> {
    let _textAccumulator = "";
    let thinkingAccumulator = "";
    let thinkingStartTime: number | undefined;
    let currentThinkingActive = false;
    const singleMessageLoopDetector = this.enableSingleMessageLoopDetection ? new SingleMessageLoopDetector() : null;
    const sealCurrentThinking = async () => {
      if (!currentThinkingActive || thinkingStartTime === undefined) return;
      currentThinkingActive = false;
      const duration = Math.max(1, Date.now() - thinkingStartTime);
      await this.interactionProvider.sendUpdate(ctx, Updates.thinkingCompleted(duration));
      await textHandler.recordThinking(ctx, "", duration);
      const completedThinkingText = thinkingAccumulator;
      thinkingAccumulator = "";
      void this.onThinkingCompleted?.(ctx, { text: completedThinkingText, durationMs: duration }).catch((error: unknown) => {
        logger.warn(ctx, "afterAgentThought hook callback failed", { error: error instanceof Error ? error.message : String(error) });
      });
    };
    try {
      for await (const chunk of fullStream) {
        if (chunk.type === "reasoning-signature") {
          if (thinkingAccumulator.length > 0) await sealCurrentThinking();
          continue;
        }
        if (currentThinkingActive && !THINKING_RELATED_CHUNK_TYPES.includes(chunk.type)) await sealCurrentThinking();
        if (chunk.type === "text-delta") {
          _textAccumulator += chunk.textDelta;
          if (singleMessageLoopDetector !== null) {
            const singleMessageLoopResult = checkForAgentSingleMessageLooping({ ctx, newText: chunk.textDelta, detector: singleMessageLoopDetector, caller: "nal" });
            if (singleMessageLoopResult.loopDetected) {
              throw new AgentLoopError({
                loopType: "singleMessage",
                loopKind: singleMessageLoopResult.loopKind ?? "single_message_multi_line",
                repetitions: singleMessageLoopResult.repetitions ?? 0,
                period: singleMessageLoopResult.period,
              });
            }
          }
          await this.interactionProvider.sendUpdate(ctx, Updates.textDelta(chunk.textDelta));
          await this.emitTokenDeltaFromChars(ctx, chunk.textDelta);
          await textHandler.recordText(ctx, chunk.textDelta);
        } else if (THINKING_RELATED_CHUNK_TYPES.includes(chunk.type)) {
          if (!currentThinkingActive) {
            thinkingStartTime = Date.now();
            currentThinkingActive = true;
          }
          let delta = "";
          if (chunk.type === "reasoning") delta = chunk.textDelta;
          thinkingAccumulator += delta;
          await this.interactionProvider.sendUpdate(ctx, Updates.thinkingDelta(delta, this.thinkingStyle));
          await this.emitTokenDeltaFromChars(ctx, delta);
          await textHandler.recordThinking(ctx, delta);
        } else if (chunk.type === "tool-call-delta") {
          await this.emitTokenDeltaFromChars(ctx, chunk.argsTextDelta);
        }
      }
    } catch (error) {
      if (error instanceof AgentLoopError && error.loopType === "singleMessage") throw error;
      if (error instanceof InputTokenLimitError) {
        logger.warn(ctx, "InputTokenLimitError will trigger blocking summarization", { error });
        return;
      }
      const streamAbortReason = ctx.reason;
      const isStreamIntentionalAbort = ctx.canceled && streamAbortReason?.intentional === true;
      if (isStreamIntentionalAbort) logger.info(ctx, "consumeStream aborted (intentional cancellation)", { error, intentionalAbort: true, abortReason: streamAbortReason?.reason });
      else logger.error(ctx, "Error in consumeStream", error);
      if (this.isConsumerSideError(error)) throw error;
    }
  }

  async emitPartialToolCall(ctx: Loose, callId: string, toolCall: Loose): Promise<void> {
    const toolCallWithId = this.withToolCallMetadata(callId, toolCall, undefined);
    this.rememberLatestToolCall(callId, toolCallWithId);
    await this.interactionProvider.sendUpdate(ctx, Updates.partialToolCall(callId, toolCallWithId, this.invocationId));
  }

  async recordPendingToolCall(ctx: Loose, callId: string, toolCall: Loose): Promise<void> {
    const toolCallWithId = this.withToolCallMetadata(callId, toolCall, undefined);
    const redactedToolCall = toRedactedToolCall(toolCallWithId, PrivacyMode.UNSPECIFIED);
    if (this.toolCallRecorder.recordPendingToolCall !== undefined) {
      await this.toolCallRecorder.recordPendingToolCall(ctx, redactedToolCall, callId);
      return;
    }
    await this.upsertRecordedToolCall(ctx, callId, redactedToolCall);
  }

  async emitToolCallDelta(ctx: Loose, callId: string, toolCallDelta: Loose): Promise<void> {
    this.applyDeltaToLatestToolCall(callId, toolCallDelta);
    await this.interactionProvider.sendUpdate(ctx, Updates.toolCallDelta(callId, toolCallDelta, this.invocationId));
  }

  async emitToolCallError(ctx: Loose, callId: string, erroredToolCall: Loose): Promise<void> {
    const shouldPreserveArgs = this.shouldPreserveArgsOnErrorCallIds.has(callId);
    const toolCallWithArgs = shouldPreserveArgs ? this.applyArgsFromLatestToolCall(callId, erroredToolCall) : erroredToolCall;
    const toolCallWithId = this.withToolCallMetadata(callId, toolCallWithArgs, { startedAtMs: this.toolCallStartedAtMsByCallId.get(callId), completedAtMs: Date.now() });
    this.toolCallStartedAtMsByCallId.delete(callId);
    this.latestToolCallsById.delete(callId);
    this.shouldPreserveArgsOnErrorCallIds.delete(callId);
    await this.interactionProvider.sendUpdate(ctx, Updates.toolCallCompleted(callId, toolCallWithId, this.invocationId));
    const redactedToolCall = toRedactedToolCall(toolCallWithId, PrivacyMode.UNSPECIFIED);
    if (toolCallWithId.tool.case === "askQuestionToolCall") await this.upsertRecordedToolCall(ctx, callId, redactedToolCall);
    else this.toolCallRecorder.recordToolCall(redactedToolCall, callId);
  }

  async recordToolCallResult(ctx: Loose, result: Loose, loggedToolName: string, errorClassification?: unknown): Promise<void> {
    let totalTextLength = 0;
    for (const part of result.content) {
      if (part.type === "text") {
        totalTextLength += part.text.length;
        await this.emitTokenDeltaFromChars(ctx, part.text);
      }
    }
    if (totalTextLength > 0) {
      const approximateTokens = Math.floor(totalTextLength / 4);
      toolCallOutputTokens.histogram(ctx, approximateTokens, { tool_name: loggedToolName });
      toolCallResultTokens.histogram(ctx, approximateTokens, { tool_name: loggedToolName, success: errorClassification === undefined ? "true" : "false" });
    }
  }

  async sendHeartbeat(ctx: Loose): Promise<void> {
    await this.interactionProvider.sendUpdate(ctx, Updates.heartbeat());
  }

  async executeToolCall(
    parentCtx: Loose,
    toolCall: Loose,
    callId: string,
    promiseFn: (ctx: Loose) => Promise<Loose>,
    resultMergeFn: (result: Loose) => Loose,
    hookContextCollector?: readonly Loose[],
  ): Promise<Loose> {
    using spanCtxt = createSpan(parentCtx.withName("executeToolCall"));
    const ctx = spanCtxt.ctx;
    const startSendStartMs = Date.now();
    this.toolCallStartedAtMsByCallId.set(callId, startSendStartMs);
    {
      using startSendSpan = createSpan(ctx.withName("executeToolCall.sendStartUpdate"));
      const toolCallWithId = this.withToolCallMetadata(callId, toolCall, { startedAtMs: startSendStartMs });
      this.rememberLatestToolCall(callId, toolCallWithId);
      await this.interactionProvider.sendUpdate(startSendSpan.ctx, Updates.toolCallStarted(callId, toolCallWithId, this.invocationId));
    }
    const startSendMs = Date.now() - startSendStartMs;
    if (startSendMs > 1_000) logger.warn(ctx, "nal.await_stall.start_send_slow", { callId, toolName: toolCall.tool?.case ?? "unknown", startSendMs });
    const startTime = Date.now();
    let result: Loose;
    const abortSignal = this.getAbortSignal(ctx);
    const resolvers = Promise.withResolvers<Loose>();
    if (abortSignal.aborted) throw new ToolCallAbortedError();
    else abortSignal.addEventListener("abort", () => resolvers.reject(new ToolCallAbortedError()), { once: true });
    promiseFn(ctx).then(value => {
      result = value;
      const newToolCall = resultMergeFn(value);
      if (hookContextCollector && hookContextCollector.length > 0) newToolCall.hookAdditionalContexts.push(...hookContextCollector);
      resolvers.resolve(newToolCall);
    }).catch((error: unknown) => resolvers.reject(error));
    const newToolCall = this.withToolCallMetadata(callId, await resolvers.promise, { startedAtMs: startSendStartMs, completedAtMs: Date.now() });
    this.toolCallStartedAtMsByCallId.delete(callId);
    this.rememberLatestToolCall(callId, newToolCall);
    const toolExecutionMs = Date.now() - startTime;
    const toolName = toolCall.tool?.case ?? "unknown";
    toolCallLatency.histogram(ctx, toolExecutionMs, { tool_name: toolName });
    toolCallCount.increment(ctx, 1, { tool_name: toolName });
    const completionSendStartMs = Date.now();
    {
      using completionSendSpan = createSpan(ctx.withName("executeToolCall.sendCompletionUpdate"));
      await this.interactionProvider.sendUpdate(completionSendSpan.ctx, Updates.toolCallCompleted(callId, newToolCall, this.invocationId));
    }
    const completionSendMs = Date.now() - completionSendStartMs;
    if (completionSendMs > 1_000) logger.warn(ctx, "nal.await_stall.completion_send_slow", { callId, toolName, toolExecutionMs, completionSendMs });
    const redactedToolCall = toRedactedToolCall(newToolCall, PrivacyMode.UNSPECIFIED);
    if (newToolCall.tool.case === "askQuestionToolCall") await this.upsertRecordedToolCall(ctx, callId, redactedToolCall);
    else this.toolCallRecorder.recordToolCall(redactedToolCall, callId);
    this.latestToolCallsById.delete(callId);
    this.shouldPreserveArgsOnErrorCallIds.delete(callId);
    return result!;
  }

  async query(ctx: Loose, query: Loose): Promise<Loose> {
    return this.interactionProvider.query(ctx, query);
  }
}
