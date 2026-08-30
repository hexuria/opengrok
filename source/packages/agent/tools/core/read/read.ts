/**
 * Retained createReadTool owner from the byte-identical Mac/Windows host:
 * host-main.cjs 578006-579141, with the constructor/call region 578476-579141
 * pinned at SHA-256 dae8cc47adb166afe0b32316076e0bec7b0d82fee6ad85c3c6c574cf7a03d775.
 * The artifact resolves the read executor at construction and invokes PDF
 * extraction only for binary PDF results. The worker body is intentionally a
 * typed injected boundary here; no Piscina or pdf-worker fallback is supplied.
 */
import { z } from "zod";

import type { Context } from "../../../../context/core.js";
import { createSpan } from "../../../../context/otel.js";
import { createStringResult, createImageResult } from "../../../../chat-inference/prompt-executor.js";
import type { BlobStore } from "../../../../agent-kv/blob-store.js";
import { getBlobId } from "../../../../agent-kv/blob-store.js";
import { toHex, utf8Serde } from "../../../../agent-kv/serde.js";
import type { ResourceAccessor } from "../../../../agent-exec/resource-provider.js";
import type { RemoteExecManager } from "../../../../agent-exec/remote.js";
import { readExecutorResource, redactedReadExecutorResource } from "../../../../agent-exec/read.js";
import { ReadArgs, type ReadResult as ReadExecResult } from "../../../../proto/generated/agent/v1/read_exec_pb.js";
import {
  ReadRange,
  ReadToolArgs,
  ReadToolCall,
  ReadToolError,
  ReadToolResult,
  ReadToolSuccess,
} from "../../../../proto/generated/agent/v1/read_tool_pb.js";
import { ToolCall } from "../../../../proto/generated/agent/v1/agent_pb.js";
import type { CursorRule } from "../../../../proto/generated/agent/v1/cursor_rules_pb.js";
import type { HookAdditionalContext } from "../../../../proto/generated/agent/v1/hook_additional_context_pb.js";
import {
  ToolCallError,
  ToolCallRejectedError,
  ToolCallUnexpectedEnvironmentError,
  createZodAgentTool,
  generateSeededUuid,
  withSafeParsedArgs,
} from "../../common.js";
import { formatCodeBlock } from "../formatting.js";
import { isJupyterNotebook } from "../notebook-utils.js";
import { formatNotebookForLLM } from "./notebook-format.js";
import { detectImageMimeType } from "./image-utils.js";
import { LARGE_TEXT_BLOB_THRESHOLD, READ_CHAR_HARD_LIMIT } from "./common.js";
import { isPdfBinary } from "./pdf-utils.js";
import { maybeRedirectWorktriesPath } from "../worktree-paths.js";
import { getConversationId } from "../../../utils/request-id.js";
import { getSkillSourceFromPath } from "../../../utils/common.js";
import { getAgentEventTracker, recordSkillApplied } from "../../../utils/event-tracking.js";
import { trackMcpDirectoryAccessIfApplicable, trackMcpDirectoryResponseBytes } from "../../../utils/mcp-metrics.js";
import { filterByAgentEnvironment } from "../../../utils/environment-filtering.js";
import type { AgentType } from "../../../utils/agent-config.js";
import { isAgentTranscriptPath } from "../../../../utils/path-matchers.js";
import { createCounter, createHistogram } from "../../../../metrics/index.js";
import { safeString } from "../../../../redaction/factory.js";
import type { RedactedString } from "../../../../redaction/types.js";

export type ReadResourceAccessor = ResourceAccessor<RemoteExecManager>;
export type PdfTextExtractor = (bytes: Uint8Array) => Promise<string>;

export interface ReadFormattingOptions {
  readonly shouldUseFormatCodeblock?: boolean;
  readonly gpt5StyleLineNumbers?: boolean;
  readonly gpt5CodexCatN?: boolean;
  readonly enableLineNumbers?: boolean;
  readonly sparseLineNumbers?: number;
  readonly useSparseReadLineNumbers?: boolean;
}

export interface ReadToolOptions {
  readonly toolName?: string;
  readonly toolIdentifier?: string;
  readonly toolDescription?: string;
  readonly preferRedactedRead?: boolean;
  readonly enableLineNumbersArg?: boolean;
  readonly enableNegativeOffset?: boolean;
  readonly useMinimalHarness?: boolean;
  readonly useExplicitOffsetLimitDescription?: boolean;
  readonly pdfTextExtractor?: PdfTextExtractor;
}

interface ReadBlobState {
  readonly getBlobStore?: () => BlobStore<Context> | undefined;
  readonly readPaths?: ReadonlySet<string>;
  readonly recordReadPath?: (path: RedactedString) => void;
  readonly agentType?: AgentType;
  readonly lastSkillCatalogBudgetStrategy?: string;
  readonly isDsv3?: () => boolean;
}

interface ReadSkill {
  readonly fullPath?: string;
  readonly description?: string;
  readonly disableModelInvocation?: boolean;
  readonly parseError?: string;
  readonly environment?: string;
  readonly plugin?: string;
  readonly marketplace?: string;
  readonly pluginId?: string;
  readonly marketplaceId?: string;
  readonly disabledEnvironments?: readonly string[];
  readonly environments?: readonly string[];
}

interface ReadMetadata {
  readonly [key: string]: unknown;
  readonly toolCallId: string;
  readonly stateHandler?: ReadBlobState;
  readonly hookContextCollector?: HookAdditionalContext[];
  readonly stepReadPathDedup?: Set<string>;
  readonly cursorRules?: readonly CursorRule[];
  readonly agentSkills?: readonly ReadSkill[];
  readonly workspacePaths?: readonly string[];
}

interface ReadInteractionHandler {
  executeToolCall(
    context: Context,
    call: ToolCall,
    callId: string,
    execute: (context: Context) => Promise<ReadToolResult>,
    merge: (result: ReadToolResult) => ToolCall,
    hookContextCollector?: HookAdditionalContext[],
  ): Promise<ReadToolResult>;
}

const UNSUPPORTED_BINARY_EXTENSIONS = /\.(zip|tar|gz|exe|dll|so|dylib|bin|mp4|webm|mov|avi|mkv|wmv|flv|m4v)$/i;
const READ_LINE_NUMBER_INTERVAL = 10;
const MAX_CONVERSATION_ID_LENGTH = 200;
const pdfTextCache = new Map<string, string>();
const relatedSkillsBySuccess = new WeakMap<object, readonly ReadSkill[]>();

const readErrorsDistribution = createHistogram("agent.tools.read.errors", {
  description: "Number of errors per read operation",
  labelNames: [],
});
const readTotalCounter = createCounter("agent.tools.read.total", {
  description: "Total file read operations",
  labelNames: [],
});

function createReadToolCall(value: ReadToolCall): ToolCall {
  return new ToolCall({ tool: { case: "readToolCall", value } });
}

function getSafeConversationId(conversationId: string): string {
  let safe = encodeURIComponent(conversationId).replace(/%/g, "_");
  if (safe.length > MAX_CONVERSATION_ID_LENGTH) safe = safe.slice(0, MAX_CONVERSATION_ID_LENGTH);
  return safe;
}

function lastPathComponent(filePath: string): string {
  const parts = filePath.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

function stripKnownTranscriptExtension(fileName: string): string {
  if (fileName.endsWith(".txt")) return fileName.slice(0, -4);
  if (fileName.endsWith(".json")) return fileName.slice(0, -5);
  return fileName;
}

function skillIdFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "").replace(/\/SKILL\.md$/i, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? lastPathComponent(normalized);
}

function normalizeComparablePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/+$/, "");
}

function matchingSkill(filePath: string, skills: readonly ReadSkill[] | undefined): ReadSkill | undefined {
  const normalized = normalizeComparablePath(filePath);
  return skills?.find(skill => skill.fullPath !== undefined && normalizeComparablePath(skill.fullPath) === normalized);
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function computeReadSlice(totalLines: number, offset: number | undefined, limit: number | undefined): {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly readRange: ReadRange;
} | undefined {
  if (offset === undefined && limit === undefined) return undefined;
  const effectiveOffset = offset ?? 1;
  const effectiveLimit = limit ?? (effectiveOffset < 0 ? Math.abs(effectiveOffset) : totalLines);
  const startIndex = effectiveOffset < 0
    ? Math.max(0, totalLines + effectiveOffset)
    : Math.max(0, effectiveOffset - 1);
  const endIndex = Math.min(totalLines, startIndex + effectiveLimit);
  if (startIndex >= totalLines) {
    throw new ToolCallUnexpectedEnvironmentError(`Offset ${offset} is beyond file length (${totalLines} lines)`);
  }
  return {
    startIndex,
    endIndex,
    readRange: new ReadRange({ startLine: startIndex + 1, endLine: endIndex }),
  };
}

function createSuccessResult(
  content: string,
  totalLines: number,
  fileSize: number,
  filePath: string,
  readRange: ReadRange | undefined,
  includeLineNumbers: boolean | undefined,
): ReadToolResult {
  const exceededLimit = content.length > READ_CHAR_HARD_LIMIT;
  return new ReadToolResult({
    result: {
      case: "success",
      value: new ReadToolSuccess({
        output: { case: "content", value: exceededLimit ? "" : content },
        isEmpty: !exceededLimit && totalLines === 0 && content === "",
        exceededLimit,
        totalLines,
        fileSize,
        path: filePath,
        ...(readRange === undefined ? {} : { readRange }),
        ...(includeLineNumbers === undefined ? {} : { includeLineNumbers }),
      }),
    },
  });
}

function positiveIntegerSchema(description: string, allowNegative = false): z.ZodType<number | undefined> {
  return z.number().int().optional().refine(value => value === undefined || value === 0 || value >= 1 || (allowNegative && value <= -1), allowNegative ? "Offset must be >= 1 or <= -1." : "Offset must be >= 1.").transform(value => value === 0 ? 1 : value).describe(description);
}

function limitSchema(): z.ZodType<number | undefined> {
  return z.number().int().optional().refine(value => value === undefined || value >= 1, "Limit must be >= 1.").describe("The number of lines to read. Only provide if the file is too large to read at once.");
}

function lineNumbersSchema(sparse: boolean): z.ZodType<boolean | undefined> {
  const suffix = sparse ? "" : " Lines are numbered starting at 1, using the format LINE_NUMBER|LINE_CONTENT.";
  return z.boolean().optional().describe(`Whether to include line numbers in the output.${suffix} Prefer using this only when needed, e.g. for citing codeblocks to the user. Defaults to false.`);
}

function parametersSchema(version: string, includeLineNumbers: boolean, includeNegativeOffset: boolean, sparse: boolean): z.ZodTypeAny {
  const lineNumberField = includeLineNumbers ? { include_line_numbers: lineNumbersSchema(sparse) } : {};
  if (version === "dsv3-1018") {
    return z.object({
      target_file: z.string().describe("The path of the file to read. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is."),
      offset: positiveIntegerSchema("The line number to start reading from. Only provide if the file is too large to read at once."),
      limit: limitSchema(),
      ...lineNumberField,
    });
  }
  if (version === "haiku") {
    return z.object({
      path: z.string().describe("The absolute path of the file to read."),
      line_range: z.array(z.number().int()).min(2).max(2).optional(),
      ...lineNumberField,
    });
  }
  return z.object({
    path: z.string().describe("The absolute path of the file to read."),
    offset: positiveIntegerSchema("The line number to start reading from. Only provide if the file is too large to read at once.", version === "cursor-0226" || includeNegativeOffset),
    limit: limitSchema(),
    ...lineNumberField,
  });
}

function toolName(version: string): string {
  if (version === "dsv3-1018") return "read_file";
  if (version === "gpt5-codex" || version === "codex-cloud") return "ReadFile";
  if (version === "cursor-0226" || version === "dsv3-1205" || version === "latest" || version === "haiku") return "Read";
  throw new Error(`Unhandled version: ${version}`);
}

function toolDescription(version: string, minimal: boolean, explicitOffsetLimit: boolean, includeLineNumbers: boolean, sparse: boolean): string {
  if (minimal) return "View an image on the local filesystem. This tool can only view IMAGE files. For normal file reads use the Shell tool.";
  const usage = explicitOffsetLimit
    ? "- Omit offset and limit to read the entire file.\n- Provide offset and limit to read a specific line range (especially for long files)."
    : "- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters.";
  const numbers = includeLineNumbers && !sparse ? "\n- Lines in the output are numbered starting at 1, using following format: LINE_NUMBER|LINE_CONTENT" : "";
  const base = `Reads a file from the local filesystem. You can access any file directly by using this tool.\nIf the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n${usage}${numbers}\n- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.\n- If you read a file that exists but has empty contents you will receive 'File is empty.'`;
  if (version === "cursor-0226") return "Reads a file from the local filesystem. This tool can also read image files when called with the appropriate path. Formats supported: jpeg/jpg, png, gif, webp.";
  if (version === "dsv3-1018") return base;
  if (version === "dsv3-1205") return `${base}\n\nImage Support:\n- This tool can also read image files when called with the appropriate path.\n- Supported image formats: jpeg/jpg, png, gif, webp.`;
  if (version === "gpt5-codex" || version === "codex-cloud" || version === "latest" || version === "haiku") return `${base}\n\nImage Support:\n- This tool can also read image files when called with the appropriate path.\n- Supported image formats: jpeg/jpg, png, gif, webp.\n\nPDF Support:\n- PDF files are converted into text content automatically (subject to the same character limits as other files).`;
  throw new Error(`Unhandled version: ${version}`);
}

function cursorRuleReminder(rules: readonly CursorRule[]): string | undefined {
  if (rules.length === 0) return undefined;
  return ["The following cursor rule files are relevant to the files you just read:", ...rules.map(rule => `- ${rule.fullPath ?? "(unknown rule path)"}\n${rule.content.trimEnd() || "(Rule file is empty.)"}`), "Consider these rules if they affect your changes."].join("\n\n");
}

function skillReminder(skills: readonly ReadSkill[]): string | undefined {
  if (skills.length === 0) return undefined;
  return ["The following skills may be relevant to the files you just read:", ...skills.map(skill => `- ${skill.fullPath ?? "(unknown skill path)"}\n${skill.description || "(No description)"}`)].join("\n\n");
}

function mergeReminders(content: string, rules: readonly CursorRule[], skills: readonly ReadSkill[]): string {
  const additions = [cursorRuleReminder(rules), skillReminder(skills)].filter((value): value is string => value !== undefined);
  return additions.length === 0 ? content : `${content}\n\n${additions.join("\n\n")}`;
}

export function createReadTool(
  resourceAccessor: ReadResourceAccessor,
  formattingOptions: ReadFormattingOptions,
  promptVersion = "latest",
  options: ReadToolOptions = {},
): Record<string, unknown> {
  const readExecutor = options.preferRedactedRead === true
    ? resourceAccessor.get(redactedReadExecutorResource)
    : resourceAccessor.get(readExecutorResource);
  const minimal = options.useMinimalHarness === true;
  if (!["dsv3-1018", "dsv3-1205", "gpt5-codex", "codex-cloud", "cursor-0226", "latest", "haiku"].includes(promptVersion) && !minimal) throw new Error(`Unhandled version: ${promptVersion}`);
  const includeLineNumbersArg = options.enableLineNumbersArg === true;
  const sparse = formattingOptions.useSparseReadLineNumbers === true;
  const schema = minimal ? z.object({ path: z.string().describe("The absolute path of the image to view.") }) : parametersSchema(promptVersion, includeLineNumbersArg, options.enableNegativeOffset === true, sparse);
  const name = options.toolName ?? (minimal ? "ViewImage" : toolName(promptVersion));
  const description = options.toolDescription ?? toolDescription(promptVersion, minimal, options.useExplicitOffsetLimitDescription === true, !includeLineNumbersArg, sparse);

  const execute = async (parentContext: Context, interactionHandler: ReadInteractionHandler, rawArgs: ReadArgsLike, meta: ReadMetadata): Promise<ReadToolResult> => {
    using span = createSpan(parentContext.withName("readExecute"));
    const originalPath = "target_file" in rawArgs ? rawArgs.target_file : rawArgs.path;
    if (typeof originalPath !== "string") throw new ToolCallUnexpectedEnvironmentError("Read path is missing");
    const filePath = maybeRedirectWorktriesPath(originalPath);
    trackMcpDirectoryAccessIfApplicable(span.ctx, filePath, "read");
    if (isAgentTranscriptPath(filePath)) {
      const conversationId = getConversationId(span.ctx);
      const leaf = stripKnownTranscriptExtension(lastPathComponent(filePath));
      const ownTranscript = conversationId === undefined ? undefined : leaf === conversationId || leaf === getSafeConversationId(conversationId);
      // The artifact records this access for diagnostics; the path itself is not redacted here.
      void ownTranscript;
    }
    if (UNSUPPORTED_BINARY_EXTENSIONS.test(filePath)) {
      const extension = filePath.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? "unknown";
      return new ReadToolResult({ result: { case: "error", value: new ReadToolError({ errorMessage: `Cannot read binary files of type ${extension}` }) } });
    }
    let offset: number | undefined;
    let limit: number | undefined;
    if ("line_range" in rawArgs && rawArgs.line_range !== undefined) {
      offset = rawArgs.line_range[0];
      limit = rawArgs.line_range[1] - rawArgs.line_range[0] + 1;
    } else {
      offset = "offset" in rawArgs ? rawArgs.offset : undefined;
      limit = "limit" in rawArgs ? rawArgs.limit : undefined;
    }
    const includeLineNumbers = "include_line_numbers" in rawArgs ? rawArgs.include_line_numbers : undefined;
    const baseToolCall = new ReadToolCall({ args: new ReadToolArgs({ path: filePath, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }), ...(includeLineNumbers === undefined ? {} : { includeLineNumbers }) }) });
    let errorCount = 0;
    let blobBackedReturnedByteCount: number | undefined;
    const result = await interactionHandler.executeToolCall(span.ctx, createReadToolCall(baseToolCall), meta.toolCallId, async context => {
      const execResult = await readExecutor.execute(context, new ReadArgs({ path: filePath, toolCallId: meta.toolCallId, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) }), {
        execId: generateSeededUuid(meta.toolCallId),
        ...(meta.hookContextCollector === undefined ? {} : { hookContextCollector: meta.hookContextCollector }),
      });
      if (execResult.result.case !== "success") {
        errorCount += 1;
        switch (execResult.result.case) {
          case "error": throw new ToolCallError({ clientVisibleErrorMessage: execResult.result.value.error, modelVisibleErrorMessage: execResult.result.value.error, error: execResult.result.value.error });
          case "rejected": throw new ToolCallRejectedError(execResult.result.value.reason || "Read operation rejected");
          case "fileNotFound": throw new ToolCallUnexpectedEnvironmentError("File not found");
          case "permissionDenied": throw new ToolCallUnexpectedEnvironmentError("Permission denied");
          case "invalidFile": throw new ToolCallUnexpectedEnvironmentError(execResult.result.value.reason || "Path is not a valid file to read");
          case undefined: throw new Error("Unknown error");
        }
      }
      const success = execResult.result.value;
      const resolvedPath = success.path;
      const fileSize = Number(success.fileSize);
      const output = success.output;
      let pdfContentOverride: string | undefined;
      if (output.case === "data") {
        if (isPdfBinary(output.value, resolvedPath)) {
          const extractor = options.pdfTextExtractor;
          if (extractor === undefined) throw new TypeError("Read PDF worker is not bound");
          const cached = pdfTextCache.get(resolvedPath);
          pdfContentOverride = cached ?? normalizeLineEndings(await extractor(output.value));
          if (cached === undefined) pdfTextCache.set(resolvedPath, pdfContentOverride);
        } else {
          const blobStore = meta.stateHandler?.getBlobStore?.();
          if (blobStore !== undefined) {
            blobBackedReturnedByteCount = output.value.byteLength;
            const blobId = success.outputBlobId && success.outputBlobId.length > 0 ? success.outputBlobId : await getBlobId(output.value);
            if (success.outputBlobId && success.outputBlobId.length > 0) await blobStore.setBlobLocallyOnly(context, blobId, output.value);
            else await blobStore.setBlob(context, blobId, output.value);
            return new ReadToolResult({ result: { case: "success", value: new ReadToolSuccess({ output: { case: "dataBlobId", value: blobId }, fileSize, path: resolvedPath }) } });
          }
          return new ReadToolResult({ result: { case: "success", value: new ReadToolSuccess({ output: { case: "data", value: output.value }, fileSize, path: resolvedPath }) } });
        }
      }
      if (pdfContentOverride === undefined && output.case !== "content") {
        errorCount += 1;
        throw new ToolCallUnexpectedEnvironmentError("Unknown output type");
      }
      const content = pdfContentOverride ?? (output.case === "content" ? output.value : "");
      if (content === "" && success.rangeApplied !== true) return createSuccessResult("", 0, fileSize, resolvedPath, undefined, includeLineNumbers);
      const totalLines = success.rangeApplied === true ? success.totalLines : content.split("\n").length;
      if (success.rangeApplied === true) {
        const executorSlice = computeReadSlice(totalLines, offset, limit);
        const executorRange = executorSlice?.readRange ?? new ReadRange({ startLine: 1, endLine: totalLines });
        return createSuccessResult(content, totalLines, fileSize, resolvedPath, executorRange, includeLineNumbers);
      }
      const slice = computeReadSlice(totalLines, offset, limit);
      if (slice !== undefined) return createSuccessResult(content.split("\n").slice(slice.startIndex, slice.endIndex).join("\n"), totalLines, fileSize, resolvedPath, slice.readRange, includeLineNumbers);
      const readRange = new ReadRange({ startLine: 1, endLine: totalLines });
      const blobStore = meta.stateHandler?.getBlobStore?.();
      if (blobStore !== undefined && content.length > LARGE_TEXT_BLOB_THRESHOLD && content.length <= READ_CHAR_HARD_LIMIT) {
        const contentBytes = new TextEncoder().encode(content);
        blobBackedReturnedByteCount = contentBytes.byteLength;
        const blobId = success.outputBlobId && success.outputBlobId.length > 0 ? success.outputBlobId : await getBlobId(contentBytes);
        if (success.outputBlobId && success.outputBlobId.length > 0) await blobStore.setBlobLocallyOnly(context, blobId, contentBytes);
        else await blobStore.setBlob(context, blobId, contentBytes);
        return new ReadToolResult({ result: { case: "success", value: new ReadToolSuccess({ output: { case: "contentBlobId", value: blobId }, totalLines, fileSize, path: resolvedPath, readRange, ...(includeLineNumbers === undefined ? {} : { includeLineNumbers }) }) } });
      }
      return createSuccessResult(content, totalLines, fileSize, resolvedPath, readRange, includeLineNumbers);
    }, resultValue => createReadToolCall(new ReadToolCall({ ...baseToolCall, result: resultValue })), meta.hookContextCollector);
    if (result.result.case === "success") {
      const resolvedPath = result.result.value.path;
      meta.stateHandler?.recordReadPath?.(safeString(resolvedPath));
      meta.stepReadPathDedup?.add(resolvedPath);
      const relatedRules = (meta.cursorRules ?? []).filter(rule => rule.fullPath !== undefined && normalizeComparablePath(rule.fullPath) === normalizeComparablePath(resolvedPath));
      result.result.value.relatedCursorRules = relatedRules;
      result.result.value.relatedCursorRulePaths = relatedRules.flatMap(rule => rule.fullPath === undefined ? [] : [rule.fullPath]);
      const eligibleSkills = filterByAgentEnvironment(Array.from(meta.agentSkills ?? []), meta.stateHandler?.agentType);
      const relatedSkills = eligibleSkills.filter(skill => skill.disableModelInvocation !== true && skill.parseError === undefined && skill.fullPath !== undefined && normalizeComparablePath(skill.fullPath) === normalizeComparablePath(resolvedPath));
      relatedSkillsBySuccess.set(result.result.value, relatedSkills);
      if (resolvedPath.endsWith("SKILL.md")) {
        const skill = matchingSkill(resolvedPath, meta.agentSkills);
        const tracker = getAgentEventTracker(span.ctx);
        tracker.trackSkillUsed(span.ctx, {});
        recordSkillApplied(span.ctx, { entrypoint: "agent_read", ...(meta.stateHandler === undefined ? {} : { stateHandler: meta.stateHandler }), skillId: skillIdFromPath(resolvedPath), skillSource: getSkillSourceFromPath(resolvedPath), ...(skill?.plugin === undefined ? {} : { plugin: skill.plugin }), ...(skill?.marketplace === undefined ? {} : { marketplace: skill.marketplace }), ...(skill?.pluginId === undefined ? {} : { pluginId: skill.pluginId }), ...(skill?.marketplaceId === undefined ? {} : { marketplaceId: skill.marketplaceId }) });
      }
    }
    readTotalCounter.increment(span.ctx, 1);
    readErrorsDistribution.histogram(span.ctx, errorCount);
    if (isMcpReadPath(filePath) && result.result.case === "success" && result.result.value.output.case === "content") trackMcpDirectoryResponseBytes(span.ctx, Buffer.byteLength(result.result.value.output.value, "utf8"), "read");
    void blobBackedReturnedByteCount;
    return result;
  };

  const render = async (context: Context, value: ReadToolResult, props: ReadRenderProps = {}): Promise<unknown> => {
    const result = value.result;
    const hydratedBlobs = new Map<string, Uint8Array>();
    if (result?.case === "success" && (result.value.output.case === "dataBlobId" || result.value.output.case === "contentBlobId")) {
      const blobId = result.value.output.value;
      const blobStore = props.blobStore;
      if (blobStore === undefined) throw new Error("Cannot hydrate blobs for tool Read: no blob store available");
      const blob = await blobStore.getBlob(context, blobId);
      if (blob === undefined) throw new Error(`Failed to hydrate blob ${toHex(blobId)} for tool Read`);
      hydratedBlobs.set(toHex(blobId), blob);
    }
    if (result === undefined) return createStringResult("Unknown error", true);
    if (result.case === "error") return createStringResult(`Error: ${result.value.errorMessage}`, true);
    if (result.case !== "success") return createStringResult("Unknown error", true);
    const success = result.value;
    if (success.isEmpty) return createStringResult("File is empty.");
    if (success.exceededLimit) return createStringResult(`File content (${success.fileSize} characters) exceeds maximum allowed characters (${READ_CHAR_HARD_LIMIT} characters).\nPlease use offset and limit parameters to read specific portions of the file, or use the 'grep' tool to search for specific content.`);
    const output = success.output;
    if (output.case === "data" || output.case === "dataBlobId") {
      const bytes = output.case === "data" ? output.value : hydratedBlobs.get(toHex(output.value));
      if (bytes === undefined) throw new Error(`Image blob not hydrated for render: ${toHex(output.value)} (path: ${success.path})`);
      const mimeType = detectImageMimeType(bytes, success.path);
      if (mimeType === undefined) return createStringResult(`Read binary file: ${success.path}`);
      return createImageResult(Buffer.from(bytes).toString("base64"), mimeType, `Read image file: ${success.path}`);
    }
    if (output.case !== "content" && output.case !== "contentBlobId") return createStringResult("Unknown error: no output case", true);
    const rawContent = output.case === "content" ? output.value : utf8Serde.deserialize(hydratedBlobs.get(toHex(output.value)) ?? new Uint8Array());
    if (isJupyterNotebook(success.path)) return createStringResult(mergeReminders(formatNotebookForLLM(rawContent), [], relatedSkillsBySuccess.get(success) ?? []));
    const includeLineNumbers = success.includeLineNumbers ?? formattingOptions.enableLineNumbers ?? false;
    const sparseLineNumbers = sparse
      ? READ_LINE_NUMBER_INTERVAL
      : formattingOptions.sparseLineNumbers;
    const finalFormattingOptions = {
      ...formattingOptions,
      enableLineNumbers: includeLineNumbers,
      ...(sparseLineNumbers === undefined ? {} : { sparseLineNumbers }),
    };
    const formatted = formatCodeBlock({ content: rawContent, filePath: success.path, startLineNumber: success.readRange?.startLine ?? 1, totalLineNumbersInFile: success.totalLines, formattingOptions: finalFormattingOptions }, { addAmountOfOmittedLines: success.readRange !== undefined && (success.readRange.startLine > 1 || success.readRange.endLine < success.totalLines) });
    return createStringResult(mergeReminders(formatted, success.relatedCursorRules, relatedSkillsBySuccess.get(success) ?? []));
  };

  return createZodAgentTool(options.toolIdentifier ?? "READ", {
    name,
    descriptionGenerator: () => description,
    parameters: schema,
    execute: withSafeParsedArgs(schema, execute, createReadToolCall(new ReadToolCall())),
    render,
    serializeError: (error: unknown) => createReadToolCall(new ReadToolCall({ result: new ReadToolResult({ result: { case: "error", value: new ReadToolError({ errorMessage: error instanceof Error ? error.message : String(error) }) } }) })),
  });
}

interface ReadArgsLike {
  readonly path?: string;
  readonly target_file?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly line_range?: readonly [number, number];
  readonly include_line_numbers?: boolean;
}

interface ReadRenderProps {
  readonly blobStore?: BlobStore<Context>;
}

function isMcpReadPath(filePath: string): boolean {
  return filePath.includes("/mcps/");
}
