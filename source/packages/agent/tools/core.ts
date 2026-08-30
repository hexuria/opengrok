import { withLogAttributes } from "../../context/logger.js";
import { createSpan } from "../../context/otel.js";
import { DeferredInteractionResponseError } from "../../agent-core/interaction-queries.js";
import { HOOK_DENIAL_AGENT_NOTE } from "../../hooks-exec/hook-error-handling.js";
import { getShouldBubbleRetryableTaskErrorsFromContext } from "../utils/request-id.js";
import {
  CustomToolCallError,
  RetryableToolOrchestrationError,
  ToolCallAbortedError,
  ToolCallArgParseError,
  ToolCallRejectedError,
  ToolCallUnexpectedEnvironmentError,
  ToolTimeoutError,
  createToolCallExecutionTimeoutError,
} from "./common.js";
import { maybeCreateAgentStreamStartTimeoutTurnError, maybeNormalizeExecBoundaryError } from "./core/connect-error.js";
import { RemoteHookBlockedError } from "./core/remote-hooks.js";
import { isFusedStepGuardTimeoutReason } from "./tool-execution-timeout.js";

type AnyTool = Record<string, any>;

export function getRequiredToolName(allTools: Record<string, { name: string }>, toolId: string): string {
  const tool = allTools[toolId];
  if (!tool) throw new Error(`Required tool ${toolId} not found in allTools`);
  return tool.name;
}
export function isPromptVisibleDescription(options: { promptVisible?: boolean } | undefined): boolean { return options?.promptVisible !== false; }
export function isForcedStaticContext(contextType: { type?: string } | undefined): boolean { return contextType?.type === "static"; }
export function getConciseStaticContext(contextType: { type?: string; conciseStaticContext?: string } | undefined): string | undefined {
  if (contextType?.type !== "dynamic") return undefined;
  return contextType.conciseStaticContext?.trim() || undefined;
}
export function resolveToolCallIdentity({ tool, args, isDirectDynamicTool = false }: { tool: AnyTool; args: unknown; isDirectDynamicTool?: boolean }): {
  readonly toolIdentifier: string;
  readonly isDynamic: boolean;
  readonly [key: string]: unknown;
} {
  const identity = tool.resolveToolCallTelemetry?.(args) ?? { toolIdentifier: tool.toolIdentifier, isDynamic: false };
  return {
    ...identity,
    toolIdentifier: identity.toolIdentifier as string,
    isDynamic: identity.isDynamic === true || isDirectDynamicTool,
  };
}

export interface ToolExecutionSet { modelVisibleTools: AnyTool[]; additionalExecutableTools: AnyTool[] }
export function getExecutableTools(toolSet: ToolExecutionSet): AnyTool[] {
  return toolSet.additionalExecutableTools.length === 0 ? toolSet.modelVisibleTools : [...toolSet.modelVisibleTools, ...toolSet.additionalExecutableTools];
}
export function getDirectDynamicToolNames(toolSet: ToolExecutionSet): Set<string> { return new Set(toolSet.additionalExecutableTools.map(tool => tool.name)); }

function stabilizeMcpToolOrder(tools: AnyTool[]): AnyTool[] {
  const nonMcp: AnyTool[] = [], mcp: AnyTool[] = [];
  for (const tool of tools) (tool.toolIdentifier === "MCP" ? mcp : nonMcp).push(tool);
  if (mcp.length === 0) return tools;
  mcp.sort((a, b) => a.name.localeCompare(b.name));
  return [...nonMcp, ...mcp];
}

export class ToolSetHandle {
  constructor(
    private allToolsByIdentifier: Map<string, AnyTool[]>,
    private staticTools: AnyTool[],
    private dynamicTools: AnyTool[] = [],
    private readonly dynamicToolRegistry?: { replaceTools(value: { dynamicTools: AnyTool[]; allTools: AnyTool[] }): void },
    private descriptionProps: Record<string, unknown> = { allTools: {} },
  ) {}
  hasTool(identifier: string): boolean { return this.getTool(identifier) !== undefined; }
  getTool(identifier: string): AnyTool | undefined { return this.allToolsByIdentifier.get(identifier)?.at(0); }
  resolveToolCallIdentity({ toolName, args }: { toolName: string; args: unknown }): ReturnType<typeof resolveToolCallIdentity> | undefined {
    const staticTool = this.staticTools.find(tool => tool.name === toolName);
    if (staticTool !== undefined) return resolveToolCallIdentity({ tool: staticTool, args });
    const dynamicTool = this.dynamicTools.find(tool => tool.name === toolName);
    return dynamicTool === undefined ? undefined : resolveToolCallIdentity({ tool: dynamicTool, args, isDirectDynamicTool: true });
  }
  getTools(identifier: string): AnyTool[] | undefined { return this.allToolsByIdentifier.get(identifier); }
  hasStaticTool(identifier: string): boolean { return this.getStaticTool(identifier) !== undefined; }
  getStaticTool(identifier: string): AnyTool | undefined { return this.staticTools.find(tool => tool.toolIdentifier === identifier); }
  getStaticTools(): AnyTool[] { return this.staticTools; }
  getAllTools(): AnyTool[] { return [...this.staticTools, ...this.dynamicTools]; }
  getDynamicTools(): AnyTool[] { return this.dynamicTools; }
  getToolExecutionSet(modelVisibleTools = this.staticTools): ToolExecutionSet {
    if (this.dynamicTools.length === 0) return { modelVisibleTools, additionalExecutableTools: [] };
    if (!modelVisibleTools.some(tool => tool.dynamicToolMetaRole === "invocation")) return { modelVisibleTools, additionalExecutableTools: [] };
    const modelToolNames = new Set(modelVisibleTools.map(tool => tool.name));
    return { modelVisibleTools, additionalExecutableTools: this.dynamicTools.filter(tool => !modelToolNames.has(tool.name)) };
  }
  getDynamicToolRegistry(): typeof this.dynamicToolRegistry { return this.dynamicToolRegistry; }
  getDescriptionProps(): Record<string, unknown> { return this.descriptionProps; }
  transformToolsInPlace(transform: (tools: AnyTool[]) => AnyTool[]): this {
    const transformed = transform(this.getAllTools());
    const dynamicToolSet = new Set(this.dynamicTools);
    const dynamicTools = transformed.filter(tool => dynamicToolSet.has(tool));
    const staticTools = transformed.filter(tool => !dynamicToolSet.has(tool));
    const handle = this.dynamicToolRegistry === undefined ? ToolSetHandle.fromTools(staticTools) : ToolSetHandle.fromTools({ staticTools, dynamicTools, dynamicToolRegistry: this.dynamicToolRegistry });
    this.allToolsByIdentifier = handle.allToolsByIdentifier;
    this.staticTools = handle.staticTools;
    this.dynamicTools = handle.dynamicTools;
    this.descriptionProps = handle.descriptionProps;
    return this;
  }
  static fromTools(input: AnyTool[] | { staticTools: AnyTool[]; dynamicTools?: AnyTool[]; dynamicToolRegistry?: { replaceTools(value: { dynamicTools: AnyTool[]; allTools: AnyTool[] }): void } }): ToolSetHandle {
    const { staticTools: tools, dynamicTools = [], dynamicToolRegistry } = Array.isArray(input) ? { staticTools: input } : input;
    const hasDynamicMetaTools = tools.some(tool => tool.dynamicToolMetaRole === "discovery") && tools.some(tool => tool.dynamicToolMetaRole === "invocation");
    const canExposeDynamicTools = dynamicToolRegistry !== undefined && hasDynamicMetaTools;
    const effectiveDynamicTools = canExposeDynamicTools ? dynamicTools : [];
    const effectiveStaticTools = canExposeDynamicTools ? tools : [...tools, ...dynamicTools];
    const descriptionProps = buildDescriptionGeneratorProps([...effectiveStaticTools, ...effectiveDynamicTools]);
    dynamicToolRegistry?.replaceTools({ dynamicTools: effectiveDynamicTools, allTools: [...effectiveStaticTools, ...effectiveDynamicTools] });
    const allToolsByIdentifier = new Map<string, AnyTool[]>();
    const sortedStaticTools = stabilizeMcpToolOrder(effectiveStaticTools);
    for (const tool of [...sortedStaticTools, ...effectiveDynamicTools]) {
      const existing = allToolsByIdentifier.get(tool.toolIdentifier);
      if (existing) existing.push(tool); else allToolsByIdentifier.set(tool.toolIdentifier, [tool]);
    }
    return new ToolSetHandle(allToolsByIdentifier, sortedStaticTools, effectiveDynamicTools, dynamicToolRegistry, descriptionProps);
  }
  merge(other: ToolSetHandle): ToolSetHandle {
    const otherRegistry = other.getDynamicToolRegistry();
    if (this.dynamicToolRegistry !== undefined && otherRegistry !== undefined && this.dynamicToolRegistry !== otherRegistry) throw new Error("Cannot merge toolsets with distinct dynamic registries");
    if (this.dynamicToolRegistry !== undefined && this.dynamicToolRegistry === otherRegistry) throw new Error("Cannot merge toolsets sharing a dynamic registry");
    if (this.dynamicToolRegistry !== undefined) return this.transformToolsInPlace(tools => [...tools, ...other.getAllTools()]);
    if (otherRegistry !== undefined) return other.transformToolsInPlace(tools => [...this.getAllTools(), ...tools]);
    return ToolSetHandle.fromTools([...this.getAllTools(), ...other.getAllTools()]);
  }
}

export enum ToolErrorClassification {
  NOOP = "noop", INVALID_ARGS = "invalid_args", UNEXPECTED_ENVIRONMENT = "unexpected_environment", USER_REJECTED = "user_rejected",
  TIMEOUT = "timeout", PROVIDER_ERROR = "provider_error", BAD_USER_DEVICE_STATE = "bad_user_device_state", ABORTED = "aborted",
  EXEC_BACKEND_UNAVAILABLE = "exec_backend_unavailable", HOOK_DENIED = "hook_denied", MCP_AUTH_ERROR = "mcp_auth_error", OTHER_ERROR = "error",
}

export async function executeToolResultOrError(tool: AnyTool, parentCtx: any, interactionHandler: any, argsStream: AsyncIterable<string>, meta: AnyTool): Promise<AnyTool> {
  using spanContext = createSpan(parentCtx.withName("executeToolResultOrError"));
  const ctx = withLogAttributes(spanContext.ctx, { toolName: tool.toolIdentifier, toolId: meta.toolCallId });
  spanContext.span.setAttribute("toolName", tool.toolIdentifier);
  spanContext.span.setAttribute("toolId", meta.toolCallId);
  if (meta.enableToolArgPreservation === true && "customToolFormat" in tool && tool.customToolFormat !== undefined) interactionHandler.markToolCallForArgPreservation(meta.toolCallId);
  try { return { result: await tool.execute(ctx, interactionHandler, argsStream, meta) }; }
  catch (error) {
    if (error instanceof DeferredInteractionResponseError) throw error;
    const shouldBubble = getShouldBubbleRetryableTaskErrorsFromContext(ctx);
    if (error instanceof RetryableToolOrchestrationError && shouldBubble) throw error;
    const streamStartTimeout = maybeCreateAgentStreamStartTimeoutTurnError(error);
    if (streamStartTimeout !== undefined) throw streamStartTimeout;
    const interactionAbortSignal = interactionHandler.getAbortSignal?.(ctx);
    const normalized = maybeRewriteFusedStepGuardAbort(maybeNormalizeExecBoundaryError(error), interactionAbortSignal !== undefined ? [interactionAbortSignal, ctx.signal] : [ctx.signal], tool.name);
    if (normalized instanceof DeferredInteractionResponseError) throw normalized;
    if (normalized instanceof RetryableToolOrchestrationError && shouldBubble) throw normalized;
    const errorClassification = classifyError(normalized);
    const output = tool.serializeError(normalized);
    if (!shouldHideToolCallErrorFromClient(normalized)) await interactionHandler.emitToolCallError(ctx, meta.toolCallId, output);
    return { result: output.tool.value?.result, error: normalized, errorClassification };
  }
}

function shouldHideToolCallErrorFromClient(error: unknown): boolean { return error instanceof CustomToolCallError && "hideFromClientToolCall" in error && error.hideFromClientToolCall === true; }
function isAbortLikeError(error: unknown): boolean { return error instanceof ToolCallAbortedError || (error instanceof Error && error.name === "AbortError"); }
function maybeRewriteFusedStepGuardAbort(error: unknown, abortSignals: AbortSignal[], toolName: string): unknown {
  if (!isAbortLikeError(error)) return error;
  const reason = findFusedStepGuardTimeoutReason(abortSignals, error);
  if (reason === undefined) return error;
  const timeoutError = createToolCallExecutionTimeoutError({ toolName, executionTimeoutMs: reason.fuseGuardMs });
  timeoutError.cause = error;
  return timeoutError;
}
function findFusedStepGuardTimeoutReason(abortSignals: AbortSignal[], error: unknown): { fuseGuardMs: number } | undefined {
  for (const signal of abortSignals) if (signal.aborted && isFusedStepGuardTimeoutReason(signal.reason)) return signal.reason;
  if (isFusedStepGuardTimeoutReason(error)) return error;
  return error instanceof Error && isFusedStepGuardTimeoutReason(error.cause) ? error.cause : undefined;
}
function classifyError(error: unknown): ToolErrorClassification {
  if (error instanceof RetryableToolOrchestrationError) return error.classification ?? ToolErrorClassification.OTHER_ERROR;
  if (error instanceof CustomToolCallError) return error.classification;
  if (error instanceof ToolCallArgParseError) return ToolErrorClassification.INVALID_ARGS;
  if (isAbortLikeError(error)) return ToolErrorClassification.ABORTED;
  if (error instanceof ToolCallRejectedError) return error.message.includes(HOOK_DENIAL_AGENT_NOTE) ? ToolErrorClassification.HOOK_DENIED : ToolErrorClassification.USER_REJECTED;
  if (error instanceof ToolCallUnexpectedEnvironmentError) return ToolErrorClassification.UNEXPECTED_ENVIRONMENT;
  if (error instanceof ToolTimeoutError || (error instanceof Error && error.name === "TimeoutError") || isAxiosTimeoutError(error)) return ToolErrorClassification.TIMEOUT;
  if (isBadUserDeviceStateError(error)) return ToolErrorClassification.BAD_USER_DEVICE_STATE;
  if (isUnexpectedEnvironmentErrno(error)) return ToolErrorClassification.UNEXPECTED_ENVIRONMENT;
  if (error instanceof RemoteHookBlockedError) return ToolErrorClassification.HOOK_DENIED;
  if (error instanceof Error && error.message.includes(HOOK_DENIAL_AGENT_NOTE)) return ToolErrorClassification.HOOK_DENIED;
  return ToolErrorClassification.OTHER_ERROR;
}
function errorCode(error: Error): unknown { return (error as Error & { code?: unknown }).code; }
function isAxiosTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = errorCode(error);
  return code === "ETIMEDOUT" || (code === "ECONNABORTED" && error.message.toLowerCase().includes("timeout"));
}
function isBadUserDeviceStateError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = errorCode(error);
  if (["ENOSPC", "ENOMEM", "EMFILE", "ENFILE", "EAGAIN", "EBADF"].includes(String(code))) return true;
  const message = error.message.toLowerCase();
  return message.includes("no space left on device") || message.includes("out of memory") || message.includes("cannot allocate memory") || message.includes("too many open files") || message.includes("bad file descriptor");
}
function isUnexpectedEnvironmentErrno(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return true;
  const message = error.message.toLowerCase();
  return message.includes("no such file or directory") || message.includes("not a directory");
}

export async function renderToolResultOrError(ctx: unknown, tool: AnyTool, output: AnyTool, props: unknown): Promise<AnyTool> {
  const renderedOutput = await tool.render(ctx, output.result, props);
  return "error" in output ? { ...renderedOutput, isError: true } : renderedOutput;
}
export function extractToolMetadataMap(tools: AnyTool[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const tool of tools) record[tool.toolIdentifier] = { name: tool.name, toolIdentifier: tool.toolIdentifier, parameters: tool.parameters };
  return record;
}
export function buildDescriptionGeneratorProps(tools: AnyTool[]): Record<string, unknown> {
  const allTools: Record<string, unknown> = {};
  for (const tool of tools) allTools[tool.toolIdentifier] = { name: tool.name, toolIdentifier: tool.toolIdentifier, parameters: tool.parameters };
  return { allTools };
}
export function toAgentTools(tools: AnyTool[], props?: Record<string, unknown>): AnyTool[] {
  const descriptionProps = props ?? buildDescriptionGeneratorProps(tools);
  return tools.map(tool => "descriptionGenerator" in tool ? {
    name: tool.name, description: tool.descriptionGenerator(descriptionProps), parameters: tool.parameters, customToolFormat: tool.customToolFormat, render: tool.render,
  } : { name: tool.name, description: tool.description, parameters: tool.parameters, render: tool.render });
}
