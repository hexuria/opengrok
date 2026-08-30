import { CURSOR_DYNAMIC_TOOLS_NAMESPACE } from "../agent-exec/mcp.js";
import { InteractionListenerStreamClosedError } from "../agent-core/interaction-listener.js";
import { createKey, type Context } from "../context/core.js";
import { createLogger } from "../context/logger.js";
import { appendHookContextRemindersToCoreToolResult } from "../hooks-carriers/render.js";
import { isMcpToolNotFoundError } from "../mcp-agent-exec/mcp.js";
import { createCounter, createHistogram } from "../metrics/index.js";
import { PrivacyCapability } from "../redaction/classification.js";
import {
  fromRedactedCoreMessages,
  toRedactedCoreMessages,
  type CoreMessageLike,
} from "../redaction/core-message.js";
import type { PrivacyMode } from "../redaction/privacy-mode.js";
import {
  createWritableIterable,
  type WritableIterable,
  WriteIterableClosedError,
} from "../utils/writable-iterable.js";
import {
  buildDescriptionGeneratorProps,
  executeToolResultOrError,
  extractToolMetadataMap,
  getDirectDynamicToolNames,
  getExecutableTools,
  renderToolResultOrError,
  resolveToolCallIdentity,
  ToolErrorClassification,
  toAgentTools,
  type ToolExecutionSet,
} from "./tools/core.js";
import { getToolOwnerTeam } from "./tools/all-tools.js";
import { RetryableToolOrchestrationError, truncateOutput } from "./tools/common.js";
import { isAgentStreamStartTimeoutRecoveryTurnError } from "./tools/core/connect-error.js";
import { getAgentEventTracker } from "./utils/event-tracking.js";
import {
  getClientOsMetricTagFromContext,
  getClientRemoteTypeMetricTagFromContext,
  getClientVersionMetricTagsFromContext,
  getIsDevFromContext,
  getIsSubagentFromContext,
  getIsUserApiKeyFromContext,
} from "./utils/request-id.js";

type ToolLike = Record<string, unknown> & {
  readonly name: string;
  readonly toolIdentifier: string;
  readonly dynamicToolMetaRole?: string;
  readonly customToolFormat?: unknown;
};

type ProviderOptions = {
  readonly cursor?: {
    readonly isAlreadySummarizedThinking?: boolean;
    readonly modelName?: string;
  };
};

type StreamChunk =
  | { readonly type: "text-delta"; readonly textDelta: string }
  | { readonly type: "reasoning"; readonly textDelta: string; readonly providerOptions?: ProviderOptions }
  | { readonly type: "redacted-reasoning"; readonly data: string; readonly providerOptions?: ProviderOptions }
  | { readonly type: "reasoning-signature"; readonly signature: string }
  | { readonly type: "tool-call-streaming-start"; readonly toolCallId: string; readonly toolName: string }
  | { readonly type: "tool-call-delta"; readonly toolCallId: string; readonly toolName: string; readonly argsTextDelta: string }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown };

type AssistantContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; signature?: string; providerOptions?: ProviderOptions }
  | { type: "redacted-reasoning"; data: string; providerOptions?: ProviderOptions }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "file"; [key: string]: unknown };

interface ModelResponse {
  readonly messages: Array<Record<string, unknown> & {
    readonly role: string;
    readonly content: string | AssistantContentPart[];
  }>;
  readonly id: string;
  readonly [key: string]: unknown;
}

interface ModelStreamResult {
  readonly fullStream: AsyncIterable<StreamChunk>;
  readonly response: Promise<ModelResponse>;
  readonly usage: Promise<unknown>;
  readonly extendedUsage: Promise<unknown>;
  readonly providerMetadata: Promise<unknown>;
  readonly invocationId: unknown;
}

interface StreamingPromptExecutor {
  stream(
    ctx: Context,
    invocationId: string,
    tools: readonly unknown[],
    options: Record<string, unknown>,
  ): ModelStreamResult;
}

const logger = createLogger("chat-inference/tool-call");
const TOOL_CALL_ID_CONTEXT_KEY = createKey<string | undefined>(
  Symbol("agent.toolCallId"),
  undefined,
);
const SEMANTIC_SEARCH_TOOL_NAME = "semantic_search";
const AGENT_STORE_CONFLICT_HOOK_EVENT_NAME = "agentStoreConflict";
const RAW_ERROR_MESSAGE_CHARACTER_BUDGET = 20_000;

interface HookContextCarrier {
  readonly hookEventName: string;
  readonly content: string;
}

export function conversationStateOpsInReplayOrder(
  toolCallResults: readonly { readonly stateOps?: readonly unknown[] }[],
): unknown[] {
  return toolCallResults.flatMap(result => result.stateOps ?? []);
}

function collectRawErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current instanceof Error) {
      if (current.message.length > 0) {
        messages.push(
          truncateOutput(current.message, RAW_ERROR_MESSAGE_CHARACTER_BUDGET, true).output,
        );
      }
      const cause = current.cause;
      if (cause !== undefined) {
        queue.push(cause);
      }
    }
  }
  return Array.from(new Set(messages));
}

function createConflictNoticeOnlyCollector(): HookContextCarrier[] {
  const collector: HookContextCarrier[] = [];
  const push = collector.push.bind(collector);
  collector.push = (...items: HookContextCarrier[]) => push(
    ...items.filter(item => item.hookEventName === AGENT_STORE_CONFLICT_HOOK_EVENT_NAME),
  );
  return collector;
}

function getMcpVersionLabel(toolName: string): string {
  if (toolName !== "mcp") {
    return "";
  }
  return "snapshots";
}

const toolCallDuration = createHistogram("tool_call.duration_ms", {
  description: "Duration of tool call execution in milliseconds",
  labelNames: [
    "toolName",
    "outcome",
    "team",
    "mcp_version",
    "clientversion",
    "clienttype",
    "remoteType",
    "isdynamic",
    "user.is_dev",
  ],
});
const toolCallResult = createCounter("tool_call.result", {
  description: "Result status of tool call execution",
  labelNames: [
    "toolName",
    "outcome",
    "team",
    "mcp_version",
    "clientversion",
    "clienttype",
    "remoteType",
    "os",
    "issubagent",
    "isuserapikey",
    "isdynamic",
    "user.is_dev",
  ],
});
const rawToolCallInputTokens = createHistogram("agent.tool_call.input_tokens", {
  description:
    "Approximate number of tokens in raw model-produced tool call arguments (argsText.length / 4)",
  labelNames: ["tool_name"],
});
const duplicateInboundToolCallId = createCounter("agent.duplicate_inbound_tool_call_id", {
  description:
    "Tool-call stream chunks whose id collided with an already-handled or in-flight tool call in the same model response",
  labelNames: ["chunkType", "disposition"],
});

export interface NativeToolCallDescriptor {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly effectiveNativeToolCall?: {
    readonly toolName: string;
    readonly args: unknown;
  };
}

interface BasePromptExecutorLike {
  appendMessages(messages: any): unknown;
  getState(): readonly any[];
  getMessages(): readonly any[];
  clearMessages(): unknown;
  stream(ctx: Context, invocationId: string, tools: readonly unknown[], options: Record<string, unknown>): any;
}

interface PromptExecutorLike extends BasePromptExecutorLike {
  executeToolStream(...args: unknown[]): unknown;
  executeModelStreamOnly(...args: unknown[]): unknown;
}

interface InteractionHandlerLike {
  readonly invocationId: string;
}

interface ToolCallEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argsStream: AsyncIterable<string>;
  readonly completedArgs: Promise<unknown>;
  readonly completedArgsText: Promise<string>;
}

interface StreamCollectionOptions {
  readonly emitToolCallEvents?: boolean;
  readonly executionToolMap?: Record<string, ToolLike>;
  readonly acceptedUnadvertisedToolNames?: readonly string[];
}

function toolNameForLogging(toolName: string, toolMap: Record<string, ToolLike>): string {
  if (!(toolName in toolMap)) {
    return "other";
  }
  return toolMap[toolName]!.toolIdentifier;
}

function resolveToolCallTelemetry(
  tool: ToolLike,
  args: unknown,
  isDirectDynamicTool = false,
): Record<string, unknown> & { toolIdentifier: string; loggedToolName: string } {
  const identity = resolveToolCallIdentity({ tool, args, isDirectDynamicTool });
  const toolIdentifier = typeof identity.toolIdentifier === "string"
    ? identity.toolIdentifier
    : "unknown";
  return {
    ...identity,
    toolIdentifier,
    loggedToolName: toolIdentifier === "unknown" ? "other" : toolIdentifier.toLowerCase(),
  };
}

function approximateTokenCountFromRawArgs(rawArgs: string): number {
  if (rawArgs.length === 0) {
    return 0;
  }
  return Math.floor(rawArgs.length / 4);
}

function duplicateStream<T>(stream: AsyncIterable<T>): [WritableIterable<T>, WritableIterable<T>] {
  const stream1 = createWritableIterable<T>();
  const stream2 = createWritableIterable<T>();
  async function run(): Promise<void> {
    try {
      for await (const chunk of stream) {
        await stream1.write(chunk);
        await stream2.write(chunk);
      }
    } catch (error) {
      stream1.throw(error);
      stream2.throw(error);
    } finally {
      stream1.close();
      stream2.close();
    }
  }
  void run().catch(error => {
    throw error;
  });
  return [stream1, stream2];
}

class ToolCallStream {
  readonly toolCallId: string;
  toolName: string;
  readonly inner: WritableIterable<string> | undefined;
  written: string;
  private resolveCompletedArgs: (args: unknown) => void;
  private resolveCompletedArgsText: (argsText: string) => void;
  readonly completedArgs: Promise<unknown>;
  readonly completedArgsText: Promise<string>;

  constructor(
    toolCallId: string,
    toolName: string,
    inner: WritableIterable<string> | undefined,
  ) {
    this.toolCallId = toolCallId;
    this.toolName = toolName;
    this.inner = inner;
    this.written = "";
    this.resolveCompletedArgs = () => {};
    this.resolveCompletedArgsText = () => {};
    this.completedArgs = new Promise(resolve => {
      this.resolveCompletedArgs = resolve;
    });
    this.completedArgsText = new Promise(resolve => {
      this.resolveCompletedArgsText = resolve;
    });
  }

  async write(ctx: Context, chunk: string): Promise<void> {
    this.written += chunk;
    if (this.inner === undefined) {
      return;
    }
    void this.inner.write(chunk).catch(error => {
      if (error instanceof WriteIterableClosedError) {
        return;
      }
      logger.error(ctx, "Error writing to tool call stream", error);
    });
  }

  async complete(ctx: Context, fullValue: string): Promise<void> {
    const rest = fullValue.slice(this.written.length);
    if (rest.length > 0) {
      this.written += rest;
      if (this.inner === undefined) {
        return;
      }
      try {
        await this.inner.write(rest);
      } catch (error) {
        if (error instanceof WriteIterableClosedError) {
          return;
        }
        logger.error(ctx, "Error writing to tool call stream", error);
      }
    }
  }

  resolveArgs(args: unknown): void {
    this.resolveCompletedArgs(args);
  }

  resolveArgsText(argsText: string): void {
    this.resolveCompletedArgsText(argsText);
  }

  async close(): Promise<void> {
    this.inner?.close();
  }
}

function createOneShotArgsIterable(args: unknown): AsyncIterable<string> {
  return createOneShotStringIterable(typeof args === "string" ? args : JSON.stringify(args) as string);
}

function createOneShotStringIterable(value: string): AsyncIterable<string> {
  return (async function* () {
    yield value;
  })();
}

function createToolMap(tools: readonly ToolLike[]): Record<string, ToolLike> {
  const toolMap: Record<string, ToolLike> = {};
  for (const tool of tools) {
    toolMap[tool.name] = tool;
  }
  return toolMap;
}

export function parseNativeToolArguments(value: unknown): unknown {
  if (value === undefined) {
    return {};
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Preserve the raw string for custom-format and malformed native calls.
  }
  return value;
}

function getDynamicInvocationToolNames(modelVisibleTools: readonly ToolLike[]): Set<string> {
  return new Set(
    modelVisibleTools
      .filter(tool => tool.dynamicToolMetaRole === "invocation")
      .map(tool => tool.name),
  );
}

export function resolveEffectiveToolCallDescriptor(
  descriptor: NativeToolCallDescriptor,
  toolExecutionSet: ToolExecutionSet,
): NativeToolCallDescriptor {
  const modelVisibleTools = toolExecutionSet.modelVisibleTools as ToolLike[];
  const dynamicInvocationToolNames = getDynamicInvocationToolNames(modelVisibleTools);
  if (!dynamicInvocationToolNames.has(descriptor.toolName)) {
    return descriptor;
  }
  const executableToolNames = new Set(
    getExecutableTools(toolExecutionSet).map(tool => tool.name as string),
  );
  if (
    descriptor.args === null ||
    typeof descriptor.args !== "object" ||
    Array.isArray(descriptor.args)
  ) {
    return descriptor;
  }
  const args = descriptor.args as Record<string, unknown>;
  const namespace = args.namespace;
  const toolName = args.toolName;
  if (
    namespace !== CURSOR_DYNAMIC_TOOLS_NAMESPACE ||
    typeof toolName !== "string" ||
    !executableToolNames.has(toolName)
  ) {
    return descriptor;
  }
  const effectiveArgs = parseNativeToolArguments(args.arguments);
  if (effectiveArgs === undefined) {
    return descriptor;
  }
  return {
    ...descriptor,
    effectiveNativeToolCall: { toolName, args: effectiveArgs },
  };
}

export function getEffectiveToolCallName(descriptor: NativeToolCallDescriptor): string {
  return descriptor.effectiveNativeToolCall?.toolName ?? descriptor.toolName;
}

export function getEffectiveToolCallArgs(descriptor: NativeToolCallDescriptor): unknown {
  return descriptor.effectiveNativeToolCall?.args ?? descriptor.args;
}

async function drainArgsStream(argsStream: AsyncIterable<string>): Promise<void> {
  for await (const _chunk of argsStream) {
    // Drain the model's outer dynamic-tool payload before switching to native arguments.
  }
}

type RecordToolCallResult = (
  ctx: Context,
  result: unknown,
  loggedToolName: string,
  errorClassification: ToolErrorClassification | string | undefined,
) => unknown | Promise<unknown>;

interface ToolExecutionExtra extends Record<string, unknown> {
  readonly enableHookAdditionalContext?: boolean;
  readonly enableAgentStoreConflictNoticeCollector?: boolean;
  readonly enableAgentStoreConflictNotices?: boolean;
  readonly stateHandler?: {
    readonly getBlobStore?: () => unknown;
  };
}

export async function executeDeferredToolCall(
  ctx: Context,
  descriptor: NativeToolCallDescriptor,
  toolMap: Record<string, ToolLike>,
  interactionHandler: unknown,
  extraT: ToolExecutionExtra,
  recordToolCallResult: RecordToolCallResult | undefined,
  renderProps: Record<string, unknown>,
  streamingArgsIterable: AsyncIterable<string> | undefined,
  completedArgs: Promise<unknown> | undefined,
  directDynamicToolNames = new Set<string>(),
): Promise<Record<string, unknown>> {
  const effectiveToolName = getEffectiveToolCallName(descriptor);
  const effectiveArgs = getEffectiveToolCallArgs(descriptor);
  const tool = toolMap[effectiveToolName];
  if (tool === undefined) {
    logger.warn(ctx, "nal.tool_call.failure", {
      toolCallId: descriptor.toolCallId,
      toolName: "other",
      toolNameFromModel: effectiveToolName,
      errorClassification: "tool_not_found",
      team: getToolOwnerTeam("unknown"),
    });
    toolCallResult.increment(ctx, 1, {
      toolName: "other",
      outcome: "tool_not_found",
      team: getToolOwnerTeam("unknown"),
      mcp_version: "",
      ...getClientVersionMetricTagsFromContext(ctx),
      ...getClientRemoteTypeMetricTagFromContext(ctx),
      ...getClientOsMetricTagFromContext(ctx),
      issubagent: getIsSubagentFromContext(ctx) ? "true" : "false",
      isuserapikey: getIsUserApiKeyFromContext(ctx) ? "true" : "false",
      isdynamic: "false",
      "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
    } as Record<string, string>);
    getAgentEventTracker(ctx).trackToolCallResult(ctx, {
      toolName: "other",
      toolCallId: descriptor.toolCallId,
      outcome: "tool_not_found",
    });
    return {
      role: "tool",
      id: descriptor.toolCallId,
      content: [{
        type: "tool-result",
        toolName: descriptor.toolName,
        toolCallId: descriptor.toolCallId,
        result: `Tool not found: ${effectiveToolName}. Available tools: ${Object.keys(toolMap).join(", ")}`,
      }],
    };
  }
  const startTimeMs = Date.now();
  const argsIterable = streamingArgsIterable ?? createOneShotArgsIterable(effectiveArgs);
  const usedDynamicInvocationSurface = descriptor.effectiveNativeToolCall !== undefined ||
    directDynamicToolNames.has(effectiveToolName);
  let telemetry = resolveToolCallTelemetry(tool, effectiveArgs, usedDynamicInvocationSurface);
  let telemetryLogFields: Record<string, unknown> = telemetry.isDynamic
    ? { isDynamicToolCall: true }
    : {};
  let didLogStart = false;
  const logToolCallStart = (): void => {
    didLogStart = true;
    logger.info(ctx, "nal.tool_call.start", {
      toolCallId: descriptor.toolCallId,
      toolName: telemetry.loggedToolName,
      team: getToolOwnerTeam(telemetry.toolIdentifier),
      ...telemetryLogFields,
    });
    getAgentEventTracker(ctx).trackToolCallStarted(ctx, {
      toolName: telemetry.loggedToolName,
      toolCallId: descriptor.toolCallId,
    });
  };
  const generalHookCarriersEnabled = extraT.enableHookAdditionalContext === true;
  const conflictNoticeCollectorEnabled =
    extraT.enableAgentStoreConflictNoticeCollector === true ||
    extraT.enableAgentStoreConflictNotices === true;
  const hookContextCollector = generalHookCarriersEnabled
    ? []
    : conflictNoticeCollectorEnabled
      ? createConflictNoticeOnlyCollector()
      : undefined;
  const toolCallCtx = ctx.with(TOOL_CALL_ID_CONTEXT_KEY, descriptor.toolCallId);
  try {
    const executeTool = () => executeToolResultOrError(
      tool,
      toolCallCtx,
      interactionHandler,
      argsIterable,
      {
        ...extraT,
        toolCallId: descriptor.toolCallId,
        hookContextCollector,
      },
    );
    const toolOutputPromise = executeTool().then(
      result => ({ ok: true as const, result }),
      error => ({ ok: false as const, error }),
    );
    if (tool.resolveToolCallTelemetry !== undefined && completedArgs !== undefined) {
      try {
        const telemetryRaceResult = await Promise.race([
          completedArgs.then(args => ({ source: "completedArgs" as const, args })),
          toolOutputPromise.then(result => ({ source: "toolOutput" as const, result })),
        ]);
        if (telemetryRaceResult.source === "completedArgs") {
          telemetry = resolveToolCallTelemetry(
            tool,
            telemetryRaceResult.args,
            usedDynamicInvocationSurface,
          );
          telemetryLogFields = telemetry.isDynamic ? { isDynamicToolCall: true } : {};
        }
      } catch {
        // Telemetry refinement must never affect execution.
      }
    }
    logToolCallStart();
    const settledToolOutput = await toolOutputPromise;
    if (!settledToolOutput.ok) {
      throw settledToolOutput.error;
    }
    const toolOutputRaw = settledToolOutput.result;
    const blobStore = extraT.stateHandler?.getBlobStore?.();
    const renderPropsWithBlobStore = { ...renderProps, blobStore };
    const toolOutput = await renderToolResultOrError(
      ctx,
      tool,
      toolOutputRaw,
      renderPropsWithBlobStore,
    );
    const highLevelToolCallResult: Record<string, unknown> = {
      output: toolOutputRaw.result.toJson(),
      isError: toolOutput.isError,
    };
    const durationMs = Date.now() - startTimeMs;
    let primaryContent: string | undefined;
    const textParts: string[] = [];
    for (const part of toolOutput.content as Array<Record<string, unknown>>) {
      if (part.type === "text") {
        textParts.push(part.text as string);
      }
    }
    if (textParts.length > 0) {
      primaryContent = textParts.join("\n");
    }
    let errorClassification: ToolErrorClassification | string | undefined;
    if (toolOutput.isError === true && "error" in toolOutputRaw) {
      errorClassification = toolOutputRaw.errorClassification;
      const rawErrorMessages = collectRawErrorMessages(toolOutputRaw.error);
      if (rawErrorMessages.length > 0) {
        highLevelToolCallResult.rawErrorMessages = rawErrorMessages;
      }
      const toolAbortReason = ctx.reason as {
        readonly intentional?: unknown;
        readonly reason?: unknown;
      } | undefined;
      const isToolIntentionalAbort = ctx.canceled && toolAbortReason?.intentional === true;
      const logData = {
        toolCallId: descriptor.toolCallId,
        toolName: telemetry.loggedToolName,
        durationMs,
        errorClassification,
        toolError: true,
        intentionalAbort: isToolIntentionalAbort,
        abortReason: toolAbortReason?.reason,
        team: getToolOwnerTeam(telemetry.toolIdentifier),
        errorMessage: typeof primaryContent === "string" ? primaryContent : undefined,
        mcp_version: getMcpVersionLabel(telemetry.loggedToolName),
        ...telemetryLogFields,
      };
      if (isToolIntentionalAbort) {
        logger.info(ctx, "nal.tool_call.aborted", logData);
      } else {
        logger.error(ctx, "nal.tool_call.failure", toolOutputRaw.error, logData);
      }
    } else {
      logger.info(ctx, "nal.tool_call.success", {
        toolCallId: descriptor.toolCallId,
        toolName: telemetry.loggedToolName,
        durationMs,
        team: getToolOwnerTeam(telemetry.toolIdentifier),
        mcp_version: getMcpVersionLabel(telemetry.loggedToolName),
        ...telemetryLogFields,
      });
    }
    if (recordToolCallResult !== undefined) {
      await recordToolCallResult(
        ctx,
        toolOutput,
        telemetry.loggedToolName,
        errorClassification,
      );
    }
    const outcome = errorClassification === undefined
      ? "success"
      : errorClassification.toString();
    getAgentEventTracker(ctx).trackToolCallResult(ctx, {
      toolName: telemetry.loggedToolName,
      toolCallId: descriptor.toolCallId,
      outcome,
    });
    const team = getToolOwnerTeam(telemetry.toolIdentifier);
    const mcpVersion = getMcpVersionLabel(telemetry.loggedToolName);
    toolCallResult.increment(ctx, 1, {
      toolName: telemetry.loggedToolName,
      outcome,
      team,
      mcp_version: mcpVersion,
      ...getClientVersionMetricTagsFromContext(ctx),
      ...getClientRemoteTypeMetricTagFromContext(ctx),
      ...getClientOsMetricTagFromContext(ctx),
      issubagent: getIsSubagentFromContext(ctx) ? "true" : "false",
      isuserapikey: getIsUserApiKeyFromContext(ctx) ? "true" : "false",
      isdynamic: telemetry.isDynamic ? "true" : "false",
      "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
    } as Record<string, string>);
    if (telemetry.loggedToolName === SEMANTIC_SEARCH_TOOL_NAME) {
      logger.info(ctx, "semantic search usage detected");
    }
    toolCallDuration.histogram(ctx, durationMs, {
      toolName: telemetry.loggedToolName,
      outcome,
      team,
      mcp_version: mcpVersion,
      ...getClientVersionMetricTagsFromContext(ctx),
      ...getClientRemoteTypeMetricTagFromContext(ctx),
      isdynamic: telemetry.isDynamic ? "true" : "false",
      "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
    } as Record<string, string>);
    const toolResultContent = [...toolOutput.content] as Array<Record<string, unknown>>;
    const carriersToRender = generalHookCarriersEnabled || hookContextCollector === undefined
      ? hookContextCollector ?? []
      : hookContextCollector.filter(
        carrier => carrier.hookEventName === AGENT_STORE_CONFLICT_HOOK_EVENT_NAME,
      );
    appendHookContextRemindersToCoreToolResult(
      textParts,
      toolResultContent as Array<{ type: "text"; text: string }>,
      carriersToRender as never[],
    );
    primaryContent = textParts.length > 0 ? textParts.join("\n") : primaryContent;
    return {
      role: "tool",
      id: descriptor.toolCallId,
      content: [{
        type: "tool-result",
        toolName: descriptor.toolName,
        toolCallId: descriptor.toolCallId,
        result: primaryContent,
        experimental_content: toolResultContent,
      }],
      providerOptions: {
        cursor: {
          highLevelToolCallResult: highLevelToolCallResult ?? {},
        },
      },
    };
  } catch (error) {
    if (!didLogStart) {
      logToolCallStart();
    }
    const durationMs = Date.now() - startTimeMs;
    const errorName = error instanceof Error ? error.name : typeof error;
    const errorMessage = error instanceof Error ? error.message : undefined;
    const errorClassification = isMcpToolNotFoundError(error)
      ? "tool_not_found"
      : error instanceof RetryableToolOrchestrationError
        ? error.classification
        : undefined;
    let outcome = errorClassification !== undefined ? errorClassification : "error";
    const abortReason = ctx.reason as {
      readonly intentional?: unknown;
      readonly reason?: unknown;
    } | undefined;
    const isIntentionalAbort = ctx.canceled && abortReason?.intentional === true;
    if (error instanceof InteractionListenerStreamClosedError || isIntentionalAbort) {
      const logLevel = isIntentionalAbort ? "info" : "warn";
      logger[logLevel](ctx, "nal.tool_call.aborted", {
        error,
        toolCallId: descriptor.toolCallId,
        toolName: telemetry.loggedToolName,
        durationMs,
        errorName,
        errorMessage,
        errorClassification,
        intentionalAbort: isIntentionalAbort,
        abortReason: abortReason?.reason,
        team: getToolOwnerTeam(telemetry.toolIdentifier),
        mcp_version: getMcpVersionLabel(telemetry.loggedToolName),
        ...telemetryLogFields,
      });
      outcome = "aborted";
    } else {
      logger.error(ctx, "nal.tool_call.unexpected_error_not_user_visible", error, {
        toolCallId: descriptor.toolCallId,
        toolName: telemetry.loggedToolName,
        durationMs,
        errorName,
        errorMessage,
        errorClassification,
        team: getToolOwnerTeam(telemetry.toolIdentifier),
        mcp_version: getMcpVersionLabel(telemetry.loggedToolName),
        ...telemetryLogFields,
      });
    }
    const catchTeam = getToolOwnerTeam(telemetry.toolIdentifier);
    const catchMcpVersion = getMcpVersionLabel(telemetry.loggedToolName);
    toolCallDuration.histogram(ctx, durationMs, {
      toolName: telemetry.loggedToolName,
      outcome,
      team: catchTeam,
      mcp_version: catchMcpVersion,
      ...getClientVersionMetricTagsFromContext(ctx),
      ...getClientRemoteTypeMetricTagFromContext(ctx),
      isdynamic: telemetry.isDynamic ? "true" : "false",
      "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
    } as Record<string, string>);
    toolCallResult.increment(ctx, 1, {
      toolName: telemetry.loggedToolName,
      outcome,
      team: catchTeam,
      mcp_version: catchMcpVersion,
      ...getClientVersionMetricTagsFromContext(ctx),
      ...getClientRemoteTypeMetricTagFromContext(ctx),
      ...getClientOsMetricTagFromContext(ctx),
      issubagent: getIsSubagentFromContext(ctx) ? "true" : "false",
      isuserapikey: getIsUserApiKeyFromContext(ctx) ? "true" : "false",
      isdynamic: telemetry.isDynamic ? "true" : "false",
      "user.is_dev": getIsDevFromContext(ctx) ? "true" : "false",
    } as Record<string, string>);
    if (telemetry.loggedToolName === SEMANTIC_SEARCH_TOOL_NAME) {
      logger.info(ctx, "semantic search usage detected");
    }
    getAgentEventTracker(ctx).trackToolCallResult(ctx, {
      toolName: telemetry.loggedToolName,
      toolCallId: descriptor.toolCallId,
      outcome,
    });
    throw error;
  }
}

function hasMeaningfulContentPart(part: AssistantContentPart): boolean {
  if (part.type === "text") {
    return part.text.trim().length > 0;
  }
  if (part.type === "reasoning") {
    return part.text.trim().length > 0;
  }
  return part.type === "tool-call" || part.type === "file";
}

function shouldSynthesizeResponseFromStreamContent(part: AssistantContentPart): boolean {
  if (part.type === "text") {
    return part.text.trim().length > 0;
  }
  return part.type === "tool-call" || part.type === "file";
}

function sanitizeContentBufferForReplay(buffer: readonly AssistantContentPart[]): AssistantContentPart[] {
  return buffer.flatMap<AssistantContentPart>(part => {
    if (part.type !== "reasoning") {
      return [part];
    }
    const isSummary = part.providerOptions?.cursor?.isAlreadySummarizedThinking === true;
    if (!isSummary) {
      return [part];
    }
    if (part.signature !== undefined && part.signature.length > 0) {
      const modelName = part.providerOptions?.cursor?.modelName;
      if (modelName === undefined) {
        return [];
      }
      return [{
        type: "redacted-reasoning" as const,
        data: part.signature,
        providerOptions: { cursor: { modelName } },
      }];
    }
    return [];
  });
}

function hasMeaningfulResponseMessageContent(messages: ModelResponse["messages"]): boolean {
  return messages.some(message => {
    if (message.role !== "assistant") {
      return false;
    }
    if (typeof message.content === "string") {
      return message.content.trim().length > 0;
    }
    return message.content.some(hasMeaningfulContentPart);
  });
}

function streamModelAndCollectToolCalls(
  ctx: Context,
  executor: StreamingPromptExecutor,
  interactionHandler: InteractionHandlerLike,
  modelVisibleTools: readonly ToolLike[],
  descriptionProps: Record<string, unknown> | undefined,
  firstToolCallHook: ((messages: string[]) => unknown | Promise<unknown>) | undefined,
  options?: StreamCollectionOptions,
) {
  const emitToolCallEvents = options?.emitToolCallEvents ?? true;
  let toolMap = options?.executionToolMap;
  if (toolMap === undefined) {
    const modelVisibleToolMap: Record<string, ToolLike> = {};
    for (const tool of modelVisibleTools) {
      modelVisibleToolMap[tool.name] = tool;
    }
    toolMap = modelVisibleToolMap;
  }
  const mutableModelVisibleTools = modelVisibleTools as ToolLike[];
  const toolDefinitions = toAgentTools(
    mutableModelVisibleTools,
    descriptionProps ?? buildDescriptionGeneratorProps(mutableModelVisibleTools),
  );
  const acceptedUnadvertisedToolNames = options?.acceptedUnadvertisedToolNames ?? [];
  const result = executor.stream(
    ctx,
    interactionHandler.invocationId,
    toolDefinitions,
    { acceptedUnadvertisedToolNames },
  );
  const settledResultResponse = result.response.then(
    response => ({ didReject: false as const, response }),
    error => ({ didReject: true as const, error }),
  );
  const [innerStream, fullStream] = duplicateStream(result.fullStream);
  const toolCallsIterable = createWritableIterable<NativeToolCallDescriptor>();
  const toolCallEventsIterable = createWritableIterable<ToolCallEvent>();
  const responsePromise = (async (): Promise<ModelResponse> => {
    let currentStream: ToolCallStream | undefined;
    let currentToolCallId: string | undefined;
    let hasStartedToolCall = false;
    const handledToolCalls = new Set<string>();
    const contentBuffer: AssistantContentPart[] = [];
    const newMessages: ModelResponse["messages"] = [];
    let response: ModelResponse;
    let toolIterablesClosed = false;
    let shouldCloseToolIterables = false;
    const pendingDescriptorWrites = new Set<Promise<void>>();
    const pendingEventWrites = new Set<Promise<void>>();
    const maybeCloseToolIterables = (): void => {
      if (toolIterablesClosed || !shouldCloseToolIterables) {
        return;
      }
      const pendingWrites = emitToolCallEvents ? pendingEventWrites : pendingDescriptorWrites;
      if (pendingWrites.size > 0) {
        return;
      }
      toolIterablesClosed = true;
      toolCallsIterable.close();
      toolCallEventsIterable.close();
    };
    const closeCurrentStream = (): void => {
      if (currentStream === undefined) {
        return;
      }
      const stream = currentStream;
      stream.close().catch(error => {
        if (error instanceof Error && error.message.includes("WritableIterable is closed")) {
          return;
        }
        logger.error(ctx, "Error closing tool call stream", error);
      });
      handledToolCalls.add(stream.toolCallId);
      const tool = toolMap[stream.toolName];
      const isCustomFormatTool = tool !== undefined &&
        "customToolFormat" in tool &&
        tool.customToolFormat !== undefined;
      let argsParseError: unknown;
      const args: unknown = (() => {
        if (stream.written.length === 0) {
          return {};
        }
        if (isCustomFormatTool) {
          return stream.written;
        }
        try {
          return JSON.parse(stream.written) as unknown;
        } catch (error) {
          argsParseError = error;
          return stream.written;
        }
      })();
      contentBuffer.push({
        type: "tool-call",
        toolCallId: stream.toolCallId,
        toolName: stream.toolName,
        args,
      });
      stream.resolveArgs(args);
      stream.resolveArgsText(stream.written);
      const descriptor: NativeToolCallDescriptor = {
        toolCallId: stream.toolCallId,
        toolName: stream.toolName,
        args,
      };
      const telemetry = tool === undefined ? undefined : resolveToolCallTelemetry(tool, args);
      const loggedToolName = telemetry === undefined || telemetry.toolIdentifier === "unknown"
        ? "other"
        : telemetry.toolIdentifier;
      if (argsParseError !== undefined) {
        logger.warn(ctx, "nal.tool_call.args_parse_failure", {
          toolCallId: stream.toolCallId,
          toolName: loggedToolName,
          toolNameFromModel: stream.toolName,
          errorClassification: "invalid_args",
          errorMessage: argsParseError instanceof Error
            ? argsParseError.message
            : String(argsParseError),
          writtenByteLength: Buffer.byteLength(stream.written, "utf8"),
          team: getToolOwnerTeam(telemetry?.toolIdentifier ?? "unknown"),
        });
      }
      const approximateInputTokens = approximateTokenCountFromRawArgs(stream.written);
      if (approximateInputTokens > 0) {
        rawToolCallInputTokens.histogram(ctx, approximateInputTokens, {
          tool_name: loggedToolName,
        });
      }
      const pendingWrite = toolCallsIterable.write(descriptor).catch(() => {});
      pendingDescriptorWrites.add(pendingWrite);
      void pendingWrite.finally(() => {
        pendingDescriptorWrites.delete(pendingWrite);
        maybeCloseToolIterables();
      });
    };
    const closeToolIterables = (): void => {
      shouldCloseToolIterables = true;
      maybeCloseToolIterables();
    };
    const writeToolCallEvent = (stream: ToolCallStream): void => {
      if (stream.inner === undefined) {
        return;
      }
      const pendingWrite = toolCallEventsIterable.write({
        toolCallId: stream.toolCallId,
        toolName: stream.toolName,
        argsStream: stream.inner,
        completedArgs: stream.completedArgs,
        completedArgsText: stream.completedArgsText,
      }).catch(() => {});
      pendingEventWrites.add(pendingWrite);
      void pendingWrite.finally(() => {
        pendingEventWrites.delete(pendingWrite);
        maybeCloseToolIterables();
      });
    };
    const logDuplicate = (
      chunk: Extract<StreamChunk, { toolCallId: string }>,
      disposition: "dropped" | "merged",
    ): void => {
      logger.warn(ctx, "nal.tool_call.duplicate_inbound_id", {
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        chunkType: chunk.type,
        disposition,
      });
      duplicateInboundToolCallId.increment(ctx, 1, {
        chunkType: chunk.type,
        disposition,
      });
    };
    try {
      for await (const chunk of innerStream) {
        if (chunk.type === "text-delta") {
          if (chunk.textDelta.length === 0) {
            continue;
          }
          const lastContent = contentBuffer.at(-1);
          if (lastContent !== undefined && lastContent.type === "text") {
            lastContent.text += chunk.textDelta;
          } else {
            contentBuffer.push({ type: "text", text: chunk.textDelta });
          }
        } else if (chunk.type === "reasoning") {
          const incomingProviderOptions = chunk.providerOptions;
          const last = contentBuffer.at(-1);
          if (last !== undefined && last.type === "reasoning" && last.signature === undefined) {
            last.text += chunk.textDelta;
            const incomingCursor = incomingProviderOptions?.cursor;
            if (
              incomingCursor?.isAlreadySummarizedThinking === true ||
              incomingCursor?.modelName !== undefined
            ) {
              last.providerOptions = {
                ...(last.providerOptions ?? {}),
                cursor: {
                  ...(last.providerOptions?.cursor ?? {}),
                  ...(incomingCursor.isAlreadySummarizedThinking === true
                    ? { isAlreadySummarizedThinking: true }
                    : {}),
                  ...(incomingCursor.modelName !== undefined
                    ? { modelName: incomingCursor.modelName }
                    : {}),
                },
              };
            }
          } else {
            contentBuffer.push({
              type: "reasoning",
              text: chunk.textDelta,
              ...(incomingProviderOptions !== undefined
                ? { providerOptions: incomingProviderOptions }
                : {}),
            });
          }
        } else if (chunk.type === "redacted-reasoning") {
          const incomingProviderOptions = chunk.providerOptions;
          const last = contentBuffer.at(-1);
          if (last !== undefined && last.type === "redacted-reasoning") {
            last.data += chunk.data;
            if (incomingProviderOptions?.cursor?.modelName !== undefined) {
              last.providerOptions = {
                ...(last.providerOptions ?? {}),
                cursor: {
                  ...(last.providerOptions?.cursor ?? {}),
                  modelName: incomingProviderOptions.cursor.modelName,
                },
              };
            }
          } else {
            contentBuffer.push({
              type: "redacted-reasoning",
              data: chunk.data,
              ...(incomingProviderOptions !== undefined
                ? { providerOptions: incomingProviderOptions }
                : {}),
            });
          }
        } else if (chunk.type === "reasoning-signature") {
          const last = contentBuffer.at(-1);
          if (last !== undefined && last.type === "reasoning") {
            if (last.signature === undefined) {
              last.signature = chunk.signature;
            } else {
              contentBuffer.push({ type: "reasoning", text: "", signature: chunk.signature });
            }
          }
        } else if (chunk.type === "tool-call-streaming-start") {
          const hasCurrentStreamForChunk = chunk.toolCallId === currentToolCallId;
          if (!hasStartedToolCall) {
            hasStartedToolCall = true;
          }
          if (handledToolCalls.has(chunk.toolCallId)) {
            logDuplicate(chunk, "dropped");
            continue;
          }
          if (!hasCurrentStreamForChunk) {
            closeCurrentStream();
            currentStream = new ToolCallStream(
              chunk.toolCallId,
              chunk.toolName,
              emitToolCallEvents ? createWritableIterable<string>() : undefined,
            );
            currentToolCallId = chunk.toolCallId;
            writeToolCallEvent(currentStream);
          } else if (currentStream !== undefined) {
            if (currentStream.toolName === "") {
              currentStream.toolName = chunk.toolName;
            } else {
              logDuplicate(chunk, "merged");
            }
          }
        } else if (chunk.type === "tool-call-delta" || chunk.type === "tool-call") {
          if (!hasStartedToolCall) {
            hasStartedToolCall = true;
          }
          if (handledToolCalls.has(chunk.toolCallId)) {
            logDuplicate(chunk, "dropped");
            continue;
          }
          if (chunk.toolCallId !== currentToolCallId) {
            closeCurrentStream();
            currentStream = new ToolCallStream(
              chunk.toolCallId,
              chunk.toolName,
              emitToolCallEvents ? createWritableIterable<string>() : undefined,
            );
            currentToolCallId = chunk.toolCallId;
            writeToolCallEvent(currentStream);
            if (chunk.type === "tool-call-delta") {
              await currentStream.write(ctx, chunk.argsTextDelta);
            } else {
              const argsString = typeof chunk.args === "string"
                ? chunk.args
                : JSON.stringify(chunk.args) as string;
              await currentStream.complete(ctx, argsString);
              closeCurrentStream();
              currentStream = undefined;
              currentToolCallId = undefined;
            }
          } else {
            if (currentStream === undefined) {
              throw new Error("No current stream found");
            }
            if (chunk.type === "tool-call-delta") {
              await currentStream.write(ctx, chunk.argsTextDelta);
            } else {
              const argsString = typeof chunk.args === "string"
                ? chunk.args
                : JSON.stringify(chunk.args) as string;
              await currentStream.complete(ctx, argsString);
              closeCurrentStream();
              currentStream = undefined;
              currentToolCallId = undefined;
            }
          }
        }
      }
      closeCurrentStream();
      closeToolIterables();
      const settledResponse = await settledResultResponse;
      if (settledResponse.didReject) {
        throw settledResponse.error;
      }
      response = settledResponse.response;
      if (hasMeaningfulResponseMessageContent(response.messages)) {
        newMessages.push(...response.messages);
      } else if (contentBuffer.some(shouldSynthesizeResponseFromStreamContent)) {
        newMessages.push({
          role: "assistant",
          content: sanitizeContentBufferForReplay(contentBuffer),
          id: response.id,
        });
      } else {
        newMessages.push(...response.messages);
      }
    } catch (error) {
      closeCurrentStream();
      closeToolIterables();
      await settledResultResponse;
      const messages: ModelResponse["messages"] = [{
        role: "assistant",
        content: sanitizeContentBufferForReplay(contentBuffer),
        id: "1",
      }];
      response = {
        error: error instanceof Error ? error : new Error("Unknown error"),
        messages,
        id: "1",
        timestamp: new Date(),
        modelId: "1",
        headers: {},
      };
      newMessages.push(...messages);
    }
    if (firstToolCallHook !== undefined) {
      await firstToolCallHook(newMessages.map(message => JSON.stringify(message)));
    }
    return { ...response, messages: newMessages };
  })();
  return {
    fullStream,
    toolCalls: toolCallsIterable,
    toolCallEvents: toolCallEventsIterable,
    response: responsePromise,
    usage: result.usage.catch(() => ({
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
    })),
    extendedUsage: result.extendedUsage.catch(() => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      maxTokens: 0,
    })),
    providerMetadata: result.providerMetadata.catch(() => undefined),
    invocationId: result.invocationId,
  };
}

function normalizeToolExecutionInput(
  tools: readonly ToolLike[] | ToolExecutionSet,
): ToolExecutionSet {
  if (Array.isArray(tools)) {
    return {
      modelVisibleTools: tools as ToolLike[],
      additionalExecutableTools: [],
    };
  }
  return tools as ToolExecutionSet;
}

function executeToolStream(
  ctx: Context,
  executor: StreamingPromptExecutor,
  interactionHandler: InteractionHandlerLike,
  tools: readonly ToolLike[] | ToolExecutionSet,
  extraT: ToolExecutionExtra,
  recordToolCallResult: RecordToolCallResult,
  descriptionProps: Record<string, unknown> | undefined,
  firstToolCallHook: ((messages: string[]) => unknown | Promise<unknown>) | undefined,
) {
  const toolExecutionSet = normalizeToolExecutionInput(tools);
  const { modelVisibleTools } = toolExecutionSet;
  const executableTools = getExecutableTools(toolExecutionSet) as ToolLike[];
  const directDynamicToolNames = getDirectDynamicToolNames(toolExecutionSet);
  const toolMap = createToolMap(executableTools);
  const dynamicInvocationToolNames = getDynamicInvocationToolNames(
    modelVisibleTools as ToolLike[],
  );
  const renderProps = { allTools: extractToolMetadataMap(executableTools) };
  const streamResult = streamModelAndCollectToolCalls(
    ctx,
    executor,
    interactionHandler,
    modelVisibleTools as ToolLike[],
    descriptionProps,
    firstToolCallHook,
    {
      executionToolMap: toolMap,
      acceptedUnadvertisedToolNames: [...directDynamicToolNames],
    },
  );
  const responsePromise = (async (): Promise<ModelResponse> => {
    const toolPromises: Array<Promise<Record<string, unknown>>> = [];
    let execBackendDown = false;
    const circuitBreakerRecordToolCallResult: RecordToolCallResult = async (
      resultCtx,
      result,
      loggedToolName,
      errorClassification,
    ) => {
      if (errorClassification === ToolErrorClassification.EXEC_BACKEND_UNAVAILABLE) {
        execBackendDown = true;
      }
      await recordToolCallResult(
        resultCtx,
        result,
        loggedToolName,
        errorClassification,
      );
    };
    const consumeToolCalls = (async (): Promise<void> => {
      for await (const event of streamResult.toolCallEvents) {
        if (execBackendDown) {
          void (async () => {
            try {
              for await (const _chunk of event.argsStream) {
                // Drain subsequent model output after the backend circuit opens.
              }
            } catch {
              // The skipped result is authoritative once the backend is down.
            }
          })();
          const skippedToolResult = {
            content: [{
              type: "text",
              text: "Execution backend unavailable. Tool execution skipped.",
            }],
            isError: true,
          };
          const loggedName = toolNameForLogging(event.toolName, toolMap);
          await circuitBreakerRecordToolCallResult(
            ctx,
            skippedToolResult,
            loggedName,
            ToolErrorClassification.EXEC_BACKEND_UNAVAILABLE,
          );
          const skippedResult: Record<string, unknown> = {
            role: "tool",
            id: event.toolCallId,
            content: [{
              type: "tool-result",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              result: "Execution backend unavailable. Tool execution skipped.",
            }],
          };
          toolPromises.push(Promise.resolve(skippedResult));
          logger.warn(ctx, "nal.tool_call.skipped_exec_backend_down", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          });
          continue;
        }
        if (dynamicInvocationToolNames.has(event.toolName)) {
          const drainOuterArgs = drainArgsStream(event.argsStream).catch(() => {});
          const [outerArgs, outerArgsText] = await Promise.all([
            event.completedArgs,
            event.completedArgsText,
          ]);
          await drainOuterArgs;
          const outerDescriptor: NativeToolCallDescriptor = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: outerArgs,
          };
          const descriptor = resolveEffectiveToolCallDescriptor(
            outerDescriptor,
            toolExecutionSet,
          );
          const { effectiveNativeToolCall } = descriptor;
          const argsIterable = effectiveNativeToolCall === undefined
            ? createOneShotStringIterable(outerArgsText)
            : createOneShotArgsIterable(effectiveNativeToolCall.args);
          toolPromises.push(executeDeferredToolCall(
            ctx,
            descriptor,
            toolMap,
            interactionHandler,
            extraT,
            circuitBreakerRecordToolCallResult,
            renderProps,
            argsIterable,
            undefined,
            directDynamicToolNames,
          ));
          continue;
        }
        const descriptor: NativeToolCallDescriptor = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: {},
        };
        toolPromises.push(executeDeferredToolCall(
          ctx,
          descriptor,
          toolMap,
          interactionHandler,
          extraT,
          circuitBreakerRecordToolCallResult,
          renderProps,
          event.argsStream,
          event.completedArgs,
          directDynamicToolNames,
        ));
      }
    })();
    const [response] = await Promise.all([
      streamResult.response,
      consumeToolCalls,
    ]);
    const isValidToolResult = (toolId: unknown): boolean => response.messages.some(
      message => message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          content => content.type === "tool-call" && content.toolCallId === toolId,
        ),
    );
    let toolResults: Array<Record<string, unknown>>;
    try {
      toolResults = await Promise.all(toolPromises);
    } catch (error) {
      if (!isAgentStreamStartTimeoutRecoveryTurnError(error)) {
        throw error;
      }
      return {
        ...response,
        error: error instanceof Error ? error : new Error("Unknown tool error"),
      };
    }
    const newMessages: ModelResponse["messages"] = [
      ...response.messages,
      ...toolResults.filter(result => isValidToolResult(result.id)) as ModelResponse["messages"],
    ];
    return { ...response, messages: newMessages };
  })();
  return {
    fullStream: streamResult.fullStream,
    response: responsePromise,
    providerMetadata: streamResult.providerMetadata,
    usage: streamResult.usage,
    extendedUsage: streamResult.extendedUsage,
    invocationId: streamResult.invocationId,
  };
}

function executeModelStreamOnly(
  ctx: Context,
  executor: StreamingPromptExecutor,
  interactionHandler: InteractionHandlerLike,
  tools: readonly ToolLike[] | ToolExecutionSet,
  descriptionProps: Record<string, unknown> | undefined,
  firstToolCallHook: ((messages: string[]) => unknown | Promise<unknown>) | undefined,
) {
  const toolExecutionSet = normalizeToolExecutionInput(tools);
  const { modelVisibleTools } = toolExecutionSet;
  const directDynamicToolNames = getDirectDynamicToolNames(toolExecutionSet);
  const streamResult = streamModelAndCollectToolCalls(
    ctx,
    executor,
    interactionHandler,
    modelVisibleTools as ToolLike[],
    descriptionProps,
    firstToolCallHook,
    {
      emitToolCallEvents: false,
      acceptedUnadvertisedToolNames: [...directDynamicToolNames],
    },
  );
  const toolCallDescriptors = (async (): Promise<NativeToolCallDescriptor[]> => {
    const descriptors: NativeToolCallDescriptor[] = [];
    for await (const descriptor of streamResult.toolCalls) {
      descriptors.push(resolveEffectiveToolCallDescriptor(descriptor, toolExecutionSet));
    }
    return descriptors;
  })();
  return {
    fullStream: streamResult.fullStream,
    response: streamResult.response,
    providerMetadata: streamResult.providerMetadata,
    usage: streamResult.usage,
    extendedUsage: streamResult.extendedUsage,
    invocationId: streamResult.invocationId,
    toolCallDescriptors,
  };
}

export class SimplePromptToolExecutor {
  readonly innerExecutor: BasePromptExecutorLike;

  constructor(innerExecutor: BasePromptExecutorLike) {
    this.innerExecutor = innerExecutor;
  }

  appendMessages(messages: readonly unknown[]): this {
    this.innerExecutor.appendMessages(messages);
    return this;
  }

  getState(): readonly any[] {
    return this.innerExecutor.getState();
  }

  getMessages(): readonly any[] {
    return this.innerExecutor.getMessages();
  }

  clearMessages(): void {
    this.innerExecutor.clearMessages();
  }

  executeToolStream(
    ctx: unknown,
    _state: unknown,
    interactionHandler: unknown,
    tools: unknown,
    extraT: unknown,
    recordToolCallResult: unknown,
    descriptionProps: unknown,
    firstToolCallHook: unknown,
  ): unknown {
    return executeToolStream(
      ctx as Context,
      this.innerExecutor,
      interactionHandler as InteractionHandlerLike,
      tools as readonly ToolLike[] | ToolExecutionSet,
      extraT as ToolExecutionExtra,
      recordToolCallResult as RecordToolCallResult,
      descriptionProps as Record<string, unknown> | undefined,
      firstToolCallHook as ((messages: string[]) => unknown | Promise<unknown>) | undefined,
    );
  }

  executeModelStreamOnly(
    ctx: unknown,
    _state: unknown,
    interactionHandler: unknown,
    tools: unknown,
    descriptionProps: unknown,
    firstToolCallHook: unknown,
  ): unknown {
    return executeModelStreamOnly(
      ctx as Context,
      this.innerExecutor,
      interactionHandler as InteractionHandlerLike,
      tools as readonly ToolLike[] | ToolExecutionSet,
      descriptionProps as Record<string, unknown> | undefined,
      firstToolCallHook as ((messages: string[]) => unknown | Promise<unknown>) | undefined,
    );
  }

  stream(ctx: unknown, invocationId: unknown, tools: unknown, options: unknown): unknown {
    return this.innerExecutor.stream(
      ctx as Context,
      invocationId as string,
      tools as readonly unknown[],
      options as Record<string, unknown>,
    );
  }
}

export class RedactedPromptToolExecutor {
  readonly innerToolExecutor: PromptExecutorLike;
  readonly privacyMode: PrivacyMode;
  private redactedWrapperMemo: WeakMap<CoreMessageLike, unknown>;

  constructor(
    innerToolExecutor: PromptExecutorLike,
    privacyMode: PrivacyMode,
  ) {
    this.innerToolExecutor = innerToolExecutor;
    this.privacyMode = privacyMode;
    this.redactedWrapperMemo = new WeakMap<CoreMessageLike, unknown>();
  }

  private wrapStablePlainMessages(plainMessages: readonly CoreMessageLike[]): unknown[] {
    return plainMessages.map(plainMessage => {
      const memoized = this.redactedWrapperMemo.get(plainMessage);
      if (memoized !== undefined) {
        return memoized;
      }
      const [wrapped] = toRedactedCoreMessages([plainMessage], this.privacyMode);
      this.redactedWrapperMemo.set(plainMessage, wrapped);
      return wrapped;
    });
  }

  appendMessages(messages: unknown | readonly unknown[]): this {
    const arr = Array.isArray(messages) ? messages : [messages];
    const plain = fromRedactedCoreMessages(
      arr,
      PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    );
    for (let index = 0; index < plain.length; index++) {
      const wrapper = arr[index];
      const plainMessage = plain[index];
      if (wrapper !== undefined && plainMessage !== undefined) {
        this.redactedWrapperMemo.set(plainMessage, wrapper);
      }
    }
    this.innerToolExecutor.appendMessages(plain);
    return this;
  }

  getState(): unknown[] {
    return this.wrapStablePlainMessages(this.innerToolExecutor.getState());
  }

  getMessages(): unknown[] {
    return this.wrapStablePlainMessages(this.innerToolExecutor.getMessages());
  }

  clearMessages(): void {
    this.innerToolExecutor.clearMessages();
    this.redactedWrapperMemo = new WeakMap<CoreMessageLike, unknown>();
  }

  executeToolStream(
    ctx: unknown,
    state: unknown,
    interactionHandler: unknown,
    tools: unknown,
    extraT: unknown,
    recordToolCallResult: unknown,
    descriptionProps: unknown,
    firstToolCallHook: unknown,
  ): unknown {
    return this.innerToolExecutor.executeToolStream(
      ctx,
      state,
      interactionHandler,
      tools,
      extraT,
      recordToolCallResult,
      descriptionProps,
      firstToolCallHook,
    );
  }

  executeModelStreamOnly(
    ctx: unknown,
    state: unknown,
    interactionHandler: unknown,
    tools: unknown,
    descriptionProps: unknown,
    firstToolCallHook: unknown,
  ): unknown {
    return this.innerToolExecutor.executeModelStreamOnly(
      ctx,
      state,
      interactionHandler,
      tools,
      descriptionProps,
      firstToolCallHook,
    );
  }

  stream(ctx: unknown, invocationId: unknown, tools: unknown, options: unknown): unknown {
    return this.innerToolExecutor.stream(
      ctx as Context,
      invocationId as string,
      tools as readonly unknown[],
      options as Record<string, unknown>,
    );
  }
}
