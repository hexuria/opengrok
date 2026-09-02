import { createHash } from "node:crypto";

import { jsonSchema, type Schema } from "ai";
import { z, type ZodTypeAny } from "zod";

import { createKey, type Context } from "../../context/core.js";
import { createLogger } from "../../context/logger.js";
import { createSpan } from "../../context/otel.js";
import { createHistogram } from "../../metrics/index.js";
import { DSV3_TOOL_TOKENS_TO_STRIP } from "../../utils/model-utils.js";
import { ToolErrorClassification } from "./core.js";
import { buildToolCallExecutionTimedOutMessage } from "./tool-execution-timeout.js";
import {
  toolExecutionTimeoutSuspensionKey,
  type ToolExecutionTimeoutSuspension,
} from "./tool-timeout-suspension.js";

const logger = createLogger("tools/common");

export function generateSeededUuid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest();
  hash[6] = (hash[6]! & 15) | 64;
  hash[8] = (hash[8]! & 63) | 128;
  const hex = hash.toString("hex");
  return [hex.substring(0, 8), hex.substring(8, 12), hex.substring(12, 16), hex.substring(16, 20), hex.substring(20, 32)].join("-");
}

const SUBAGENT_REQUEST_ID_SEED_PREFIX = "subagent-request-";
export function computeSubagentRequestId(toolCallId: string): string {
  return generateSeededUuid(`${SUBAGENT_REQUEST_ID_SEED_PREFIX}${toolCallId}`);
}

export const CHAR_HARD_LIMIT = 100_000;
export const ASK_MODE_MODEL_ERROR = "You are in ask mode and cannot run non read-only tools. Ask the user to switch to agent mode if edits are required.";

const toolArgsParseSuccessRate = createHistogram("agent.tools.args_parse_success", {
  description: "Tool argument parsing success rate (1 for success, 0 for failure)",
  labelNames: ["tool_name"],
});

interface StateHandlerLike { isDsv3?: () => boolean }
interface ToolExecutionMetaLike { toolCallId: string; stateHandler?: StateHandlerLike; [key: string]: unknown }

function isDsv3FromMeta(meta: ToolExecutionMetaLike | undefined): boolean {
  const stateHandler = meta?.stateHandler;
  if (stateHandler == null || typeof stateHandler !== "object") return false;
  return typeof stateHandler.isDsv3 === "function" && stateHandler.isDsv3.call(stateHandler) === true;
}

function stripDsv3TokensFromArgs(options: { ctx: Context; args: string; toolName: string; isDsv3Model: boolean }): string {
  if (!options.isDsv3Model) return options.args;
  let result = options.args;
  for (const token of DSV3_TOOL_TOKENS_TO_STRIP) {
    if (result.includes(token)) {
      logger.warn(options.ctx, "nal.tool_args.dsv3_token_leaked", { tool_name: options.toolName, token });
      result = result.replaceAll(token, "");
    }
  }
  return result;
}

export const agentToolExecutionMetaKey = createKey<unknown>(Symbol("agentToolExecutionMeta"), undefined);

export function truncateOutput(output: string, maxLength = CHAR_HARD_LIMIT, frontAndBack = false): { output: string; truncated: boolean } {
  if (output.length <= maxLength) return { output, truncated: false };
  if (frontAndBack) {
    const halfLength = Math.floor(maxLength / 2);
    return {
      output: output.substring(0, halfLength) + "\n\n... (output truncated) ...\n\n" + output.substring(output.length - halfLength),
      truncated: true,
    };
  }
  return { output: output.substring(0, maxLength) + "\n\n... (output truncated)", truncated: true };
}

function stripSchemaArtifacts(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripSchemaArtifacts);
  const { $schema: _schema, default: _default, definitions: _definitions, markdownDescription: _markdown, additionalProperties: _additional, ...rest } = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(rest)) result[key] = stripSchemaArtifacts(child);
  return result;
}

export function convertTupleSchemaToDraft2020_12(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(convertTupleSchemaToDraft2020_12);
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const isTupleSchema = Array.isArray(record.items);
  for (const [key, child] of Object.entries(record)) {
    if (key === "items" && Array.isArray(child)) {
      result.prefixItems = child.map(convertTupleSchemaToDraft2020_12);
      if (record.additionalItems === false) result.items = false;
    } else if (key === "additionalItems") {
      if (isTupleSchema && child !== false) result.items = convertTupleSchemaToDraft2020_12(child);
    } else {
      result[key] = convertTupleSchemaToDraft2020_12(child);
    }
  }
  return result;
}

interface AgentToolLike {
  name: string;
  parameters: ZodTypeAny;
  render: (...args: any[]) => unknown;
  execute: (...args: any[]) => Promise<unknown>;
  serializeError: (error: unknown) => unknown;
  [key: string]: any;
}

export function createZodAgentTool(toolIdentifier: string, tool: AgentToolLike): Record<string, unknown> {
  // zod 4 converts to JSON Schema itself, so zod-to-json-schema is gone. "any" for what JSON
  // Schema cannot express keeps the old library's forgiving behaviour instead of throwing.
  const schema = stripSchemaArtifacts(z.toJSONSchema(tool.parameters, { unrepresentable: "any", io: "input" }));
  return {
    toolIdentifier,
    name: tool.name,
    contextType: tool.contextType,
    dynamicToolMetaRole: tool.dynamicToolMetaRole,
    resolveToolCallTelemetry: tool.resolveToolCallTelemetry,
    descriptionGenerator: tool.descriptionGenerator,
    descriptionTokenPartsGenerator: tool.descriptionTokenPartsGenerator,
    parameters: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
    customToolFormat: tool.customToolFormat,
    prepareSubagent: tool.prepareSubagent,
    render: (ctx: unknown, output: unknown, props: unknown) => tool.render(ctx, output, props),
    execute: async (parentCtx: Context, interactionHandler: unknown, argsStream: AsyncIterable<string>, meta: ToolExecutionMetaLike) => {
      using spanContext = createSpan(parentCtx.withName("execute"));
      spanContext.span.setAttribute("tool.name", toolIdentifier);
      return await tool.execute(spanContext.ctx, interactionHandler, argsStream, meta);
    },
    serializeError: (error: unknown) => tool.serializeError(error),
  };
}

export class ToolCallError extends Error {
  readonly clientVisibleErrorMessage: string;
  readonly modelVisibleErrorMessage: string;
  constructor({ clientVisibleErrorMessage, modelVisibleErrorMessage, error }: { clientVisibleErrorMessage: string; modelVisibleErrorMessage: string; error: string }) {
    super(error);
    this.clientVisibleErrorMessage = clientVisibleErrorMessage;
    this.modelVisibleErrorMessage = modelVisibleErrorMessage;
  }
}
export class ToolTimeoutError extends ToolCallError {}
export class CustomToolCallError extends ToolCallError {
  readonly classification: ToolErrorClassification;
  constructor(classification: ToolErrorClassification, fields: { clientVisibleErrorMessage: string; modelVisibleErrorMessage: string; error: string }) {
    super(fields);
    this.classification = classification;
  }
}
export class ToolCallArgParseError extends ToolCallError {
  constructor(formattedError: string) { super({ clientVisibleErrorMessage: formattedError, modelVisibleErrorMessage: formattedError, error: formattedError }); }
}
export class ToolCallRejectedError extends ToolCallError {
  constructor(reason: string) { super({ clientVisibleErrorMessage: reason, modelVisibleErrorMessage: reason, error: reason }); }
}
export class ToolCallUnexpectedEnvironmentError extends ToolCallError {
  constructor(reason: string) { super({ clientVisibleErrorMessage: reason, modelVisibleErrorMessage: reason, error: reason }); }
}
export class ToolCallAbortedError extends ToolCallError {
  constructor() { super({ clientVisibleErrorMessage: "Aborted", modelVisibleErrorMessage: "Aborted", error: "Aborted" }); }
}
export class RetryableToolOrchestrationError extends Error {
  readonly isRetryable = true;
  readonly classification: ToolErrorClassification | undefined;
  constructor(message: string, options?: { classification?: ToolErrorClassification; cause?: unknown }) {
    super(message);
    this.name = "RetryableToolOrchestrationError";
    this.classification = options?.classification;
    if (options?.cause) this.cause = options.cause;
  }
}
export class RetryableToolEnvironmentOrchestrationError extends RetryableToolOrchestrationError {
  readonly code: string;
  constructor(reason: string, options?: { cause?: unknown; code?: string }) {
    super(reason, { ...(options?.cause ? { cause: options.cause } : {}), classification: ToolErrorClassification.UNEXPECTED_ENVIRONMENT });
    this.name = "RetryableToolEnvironmentOrchestrationError";
    this.code = options?.code ?? "ENVIRONMENT_UNREACHABLE";
  }
}

function parseJsonArgsWithZodSchema(args: string, schema: ZodTypeAny): unknown {
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(args); }
  catch (error) {
    const message = error instanceof Error ? error.message : "Invalid arguments";
    throw new ToolCallArgParseError(`Tool call arguments were not valid JSON (${message}). Re-issue the call with arguments as a single well-formed JSON object.`);
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    const messages = parsed.error.issues.map(error => `${error.path.length > 0 ? error.path.join(".") : "argument"}: ${error.message}`);
    throw new ToolCallArgParseError(`Invalid arguments:\n${messages.join("\n")}`);
  }
  return parsed.data;
}

export const withSafeParsedArgs = (
  parametersSchema: ZodTypeAny | ((meta: ToolExecutionMetaLike) => ZodTypeAny),
  execute: (ctx: Context, interactionHandler: any, args: any, meta: ToolExecutionMetaLike) => Promise<unknown>,
  initialToolCall: any,
  options?: { emitInitialPartialToolCall?: boolean },
) => async (ctx: Context, interactionHandler: any, argsStream: AsyncIterable<string>, meta: ToolExecutionMetaLike): Promise<unknown> => {
  if (options?.emitInitialPartialToolCall !== false) interactionHandler.emitPartialToolCall(ctx, meta.toolCallId, initialToolCall);
  let args = "";
  let parsedArgs: unknown;
  try {
    for await (const chunk of argsStream) args += chunk;
    const toolName = initialToolCall.tool?.case ?? "unknown";
    args = stripDsv3TokensFromArgs({ ctx, args, toolName, isDsv3Model: isDsv3FromMeta(meta) });
    parsedArgs = parseJsonArgsWithZodSchema(args, typeof parametersSchema === "function" ? parametersSchema(meta) : parametersSchema);
  } catch (error) {
    const toolName = initialToolCall.tool?.case ?? "unknown";
    toolArgsParseSuccessRate.histogram(ctx, 0, { tool_name: toolName });
    if (error instanceof ToolCallArgParseError) throw error;
    throw new ToolCallArgParseError(error instanceof Error ? error.message : "Invalid arguments");
  }
  const toolName = initialToolCall.tool?.case ?? "unknown";
  toolArgsParseSuccessRate.histogram(ctx, 1, { tool_name: toolName });
  using coreExecuteSpan = createSpan(ctx.withName("coreExecute"));
  return await execute(coreExecuteSpan.ctx, interactionHandler, parsedArgs, meta);
};

export function resolveTerminalsFolder(value: string | (() => string)): string { return typeof value === "function" ? value() : value; }
const CODEX_PROMPT_VERSIONS = ["gpt5-codex", "codex-cloud"];
export function isCodexPromptVersion(version: string): boolean { return CODEX_PROMPT_VERSIONS.includes(version); }

export function createToolCallExecutionTimeoutError({ toolName, executionTimeoutMs }: { toolName: string; executionTimeoutMs: number }): ToolTimeoutError {
  const message = buildToolCallExecutionTimedOutMessage({ toolName, executionTimeoutMs });
  return new ToolTimeoutError({ clientVisibleErrorMessage: message, modelVisibleErrorMessage: message, error: message });
}

interface TimeoutToolLike { name: string; execute: (...args: any[]) => Promise<any>; [key: string]: any }
interface TimeoutEvent<T extends TimeoutToolLike> { ctx: Context; tool: T; meta: ToolExecutionMetaLike; timeoutMs: number }
export function wrapToolWithTimeout<T extends TimeoutToolLike>(tool: T, options: {
  timeoutMs: number;
  onTimeout?: (event: TimeoutEvent<T>) => unknown;
  createTimeoutError?: (event: TimeoutEvent<T>) => unknown;
}): T {
  const timeoutMs = options.timeoutMs;
  const createTimeoutError = options.createTimeoutError ?? (event => new Error(`Tool ${event.tool.name} timed out after ${event.timeoutMs} ms`));
  return {
    ...tool,
    execute: async (parentCtx: Context, interactionHandler: unknown, argsStream: AsyncIterable<string>, meta: ToolExecutionMetaLike) => {
      const parentSuspension = parentCtx.get(toolExecutionTimeoutSuspensionKey);
      const [execCtx, cancelExec] = parentCtx.withCancel();
      let finished = false, remainingMs = timeoutMs, armedAtMs: number | undefined, timer: NodeJS.Timeout | undefined, suspendCount = 0;
      const disarm = () => {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
        if (armedAtMs !== undefined) { remainingMs = Math.max(0, remainingMs - (Date.now() - armedAtMs)); armedAtMs = undefined; }
      };
      const arm = () => {
        if (finished || suspendCount > 0 || timer !== undefined) return;
        armedAtMs = Date.now();
        timer = setTimeout(() => { timer = undefined; armedAtMs = undefined; cancelExec(new Error("context deadline exceeded")); }, remainingMs);
      };
      const suspension: ToolExecutionTimeoutSuspension = { suspend: () => {
        const resumeParent = parentSuspension?.suspend();
        suspendCount += 1; disarm(); let resumed = false;
        return () => { if (resumed) return; resumed = true; suspendCount -= 1; arm(); resumeParent?.(); };
      } };
      const timeoutCtx = execCtx.with(toolExecutionTimeoutSuspensionKey, suspension);
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        execCtx.signal.addEventListener("abort", () => {
          if (finished) return;
          const event = { ctx: parentCtx, tool, meta, timeoutMs };
          if (options.onTimeout !== undefined) void Promise.resolve(options.onTimeout(event)).catch(() => {});
          reject(createTimeoutError(event));
        }, { once: true });
      });
      arm();
      try { return await Promise.race([tool.execute(timeoutCtx, interactionHandler, argsStream, meta), timeoutPromise]); }
      finally { finished = true; disarm(); cancelExec(); }
    },
  } as T;
}
