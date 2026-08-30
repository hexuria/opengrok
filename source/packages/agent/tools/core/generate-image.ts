import { Buffer } from "node:buffer";
import { basename, extname, join } from "node:path";
import { ToolCall } from "../../../proto/generated/agent/v1/agent_pb.js";
import {
  GenerateImageArgs,
  GenerateImageError,
  GenerateImageResult,
  GenerateImageSuccess,
  GenerateImageToolCall,
} from "../../../proto/generated/agent/v1/generate_image_tool_pb.js";
import { ReadArgs, type ReadResult } from "../../../proto/generated/agent/v1/read_exec_pb.js";
import { WriteArgs, type WriteResult } from "../../../proto/generated/agent/v1/write_exec_pb.js";
import type { Context } from "../../../context/core.js";
import { getAbortReasonInfo } from "../../../context/abort-reason.js";
import { createSpan } from "../../../context/otel.js";
import { createLogger } from "../../../context/logger.js";
import { createCounter, createHistogram } from "../../../metrics/index.js";
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../../../redaction/privacy-mode.js";
import { DataClassification } from "../../../redaction/classification.js";
import { formatRedacted, shouldRedact } from "../../../redaction/shouldRedact.js";
import { resizeImageBufferIfNeeded } from "../../../utils/image-resize.js";
import { createImageResult, createStringResult } from "../../../chat-inference/prompt-executor.js";
import { readExecutorResource, type ReadExecutor } from "../../../agent-exec/read.js";
import { writeExecutorResource, type WriteExecutor } from "../../../agent-exec/write.js";
import type { ResourceAccessor } from "../../../agent-exec/resource-provider.js";
import type { RemoteExecManager } from "../../../agent-exec/remote.js";
import {
  ASK_MODE_MODEL_ERROR,
  CustomToolCallError,
  ToolCallAbortedError,
  ToolCallError,
  ToolCallRejectedError,
  ToolCallUnexpectedEnvironmentError,
  createZodAgentTool,
  withSafeParsedArgs,
} from "../common.js";
import { ToolErrorClassification } from "../core.js";
import { z } from "zod";

const logger = createLogger("agent/tools/generate-image");
const MAX_CONCURRENT_IMAGE_GENERATIONS = 2;
const SHORT_PROMPT_WORD_THRESHOLD = 5;
const VERY_SHORT_PROMPT_WORD_THRESHOLD = 3;
const MODEL_RESTRICTED_ERROR = "GenerateImage is not available for the current selected model. If important to generate an image (e.g. the user asked for it), then ask the user to switch models.";
const NO_PROJECT_FOLDER_ERROR = "generate_image needs a workspace/project folder so it has somewhere to save the PNG. Open a folder or run from a workspace, then try again.";
const CONTENT_SAFETY_BLOCKED_ERROR = "The image generation was blocked due to content safety policies.";
const DEFAULT_SUSPICIOUS_KEYWORDS = ["ignore", "skip", "stop", "noop"] as const;
const SUPPORTED_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"] as const;

const generateImageWriteResultCounter = createCounter("agent.tools.generate_image.write_result", {
  description: "Generate image write results by case and location",
  labelNames: ["result", "location", "operation", "is_readonly"],
});
const generateImageAbortCounter = createCounter("agent.tools.generate_image.abort", {
  description: "Generate image aborts by phase and normalized reason",
  labelNames: ["phase", "abort_reason_type"],
});
const generateImageExecuteFinishCounter = createCounter("agent.tools.generate_image.execute.finished", {
  description: "Generate image tool execute outcomes",
  labelNames: ["outcome"],
});
const generateImageExecuteErrorCounter = createCounter("agent.tools.generate_image.execute.error", {
  description: "Generate image tool execute failures by stage",
  labelNames: ["stage"],
});
const generateImageExecuteDurationMs = createHistogram("agent.tools.generate_image.execute.duration_ms", {
  description: "End-to-end generate image execute latency in milliseconds",
  labelNames: ["outcome"],
});
const generateImageRenderFinishCounter = createCounter("agent.tools.generate_image.render.finished", {
  description: "Generate image tool render outcomes",
  labelNames: ["outcome"],
});
const generateImageShortPromptCounter = createCounter("agent.tools.generate_image.short_prompt", {
  description: "Generate image invocations where the description was rejected as too short or suspicious",
  labelNames: ["word_count"],
});

function recordGenerateImageExecuteError(context: Context, stage: GenerateImageErrorStage): void {
  generateImageExecuteErrorCounter.increment(context, 1, { stage });
}

function recordGenerateImageExecuteFinish(context: Context, outcome: string): void {
  generateImageExecuteFinishCounter.increment(context, 1, { outcome });
}

function recordGenerateImageRenderFinish(context: Context, outcome: string): void {
  generateImageRenderFinishCounter.increment(context, 1, { outcome });
}

function isResizeImageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("resize") || message.includes("sharp");
}

type GenerateImageErrorStage = "project_folder" | "provider_inference" | "write_output" | "read_reference_images";

function classifyErrorFinishReason(stage: GenerateImageErrorStage): string {
  switch (stage) {
    case "project_folder": return "missing_project_folder";
    case "provider_inference": return "provider_error";
    case "write_output": return "write_error";
    case "read_reference_images": return "internal_error";
  }
}

function classifyAbortFinishReason(reasonInfo: ReturnType<typeof getAbortReasonInfo>): string {
  const errorName = reasonInfo.abortReasonName ?? "";
  const details = `${reasonInfo.abortReasonName ?? ""} ${reasonInfo.abortReasonMessage ?? ""}`.toLowerCase();
  if (errorName === "ToolCallAbortedError" || /user|cancel|cancelled|canceled/.test(details)) return "user_abort";
  if (/disconnect|connection|socket|client closed|broken pipe|econnreset/.test(details)) return "client_disconnect";
  if (/timeout|timed out|deadline|etimedout/.test(details)) return "request_timeout";
  return "internal_error";
}

function classifyAbortFinish(reason: unknown): { reasonInfo: ReturnType<typeof getAbortReasonInfo>; finishOutcome: string } {
  const reasonInfo = getAbortReasonInfo(reason);
  return { reasonInfo, finishOutcome: classifyAbortFinishReason(reasonInfo) };
}

function getPermissionLabels(writeResult: WriteResult): { operation: string; isReadonly: string } {
  if (writeResult.result.case !== "permissionDenied") return { operation: "n/a", isReadonly: "n/a" };
  return {
    operation: writeResult.result.value.operation || "unknown",
    isReadonly: writeResult.result.value.isReadonly ? "true" : "false",
  };
}

export interface GenerateImageRequestContext {
  readonly env?: {
    readonly projectFolder?: string;
    readonly artifactsFolder?: string;
    readonly workspacePaths?: readonly string[];
  };
}

export interface GenerateImageStateHandler {
  isDsv3?(): boolean;
  getPrivacyMode?(): PrivacyModeValue;
  addTurnUsage?(usage: unknown): void;
}

export interface GeneratedImageToolResult {
  readonly filePath: string;
  readonly imageData: string;
  readonly usage?: unknown;
}

export interface GenerateImageService {
  (
    context: Context,
    description: string,
    filename?: string,
    referenceImages?: readonly unknown[],
    aspectRatio?: string,
  ): Promise<GeneratedImageToolResult>;
}

export interface GenerateImageToolDependencies {
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly generateImageService: GenerateImageService;
  readonly promptVersion?: string;
  readonly requestContext?: GenerateImageRequestContext;
  readonly imageGenerationConcurrencyLimiter?: ImageGenerationConcurrencyLimiter;
  readonly isReadonly?: boolean;
  readonly suspiciousKeywords?: readonly string[];
  readonly isModelRestricted?: boolean;
}

export interface ImageGenerationConcurrencyLimiter {
  acquire(): Promise<void>;
  release(): void;
}

export function createImageGenerationConcurrencyLimiter(
  maxConcurrent = MAX_CONCURRENT_IMAGE_GENERATIONS,
): ImageGenerationConcurrencyLimiter {
  const limit = Math.trunc(Number(maxConcurrent));
  if (!Number.isFinite(limit) || limit < 1) {
    throw new RangeError(`createImageGenerationConcurrencyLimiter: maxConcurrent must be a finite number >= 1, got ${maxConcurrent}`);
  }
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire() {
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise<void>(resolve => waiters.push(resolve));
    },
    release() {
      const next = waiters.shift();
      if (next !== undefined) next();
      else if (active > 0) active -= 1;
    },
  };
}

function createGenerateImageToolCall(toolCall: GenerateImageToolCall): ToolCall {
  return new ToolCall({ tool: { case: "generateImageToolCall", value: toolCall } });
}

function getToolName(promptVersion: string): string {
  switch (promptVersion) {
    case "dsv3-1018": return "generate_image";
    case "cursor-0226":
    case "dsv3-1205":
    case "latest":
    case "gpt5-codex":
    case "codex-cloud":
    case "haiku": return "GenerateImage";
    default: throw new Error(`Unhandled version: ${promptVersion}`);
  }
}

function getDescription(promptVersion: string): string {
  switch (promptVersion) {
    case "cursor-0226":
    case "dsv3-1205":
    case "gpt5-codex":
    case "codex-cloud":
    case "dsv3-1018":
    case "latest":
    case "haiku":
      return `Generate an image file from a text description.

STRICT INVOCATION RULES (must follow):
- Only use this tool when the user explicitly asks for an image. Do not generate images "just to be helpful".
- Do not use this tool for data heavy visualizations such as charts, plots, tables.

General guidelines:
- Provide a concrete description first: subject(s), layout, style, colors, text (if any), and constraints.
- If the user requests an aspect ratio, set \`aspect_ratio\` to one of "1:1", "4:3", "3:4", "16:9", or "9:16".
- If the user provides reference images, include them in \`reference_image_paths\`.
- Do not repeat generated images as Markdown in your response; the client displays tool-generated images automatically.
`;
    default: throw new Error(`Unhandled version: ${promptVersion}`);
  }
}

function getImageMimeTypeFromPath(imagePath: string): string {
  switch (extname(imagePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return "image/png";
  }
}

function redactPath(path: string, privacyMode: PrivacyModeValue, fieldName: string): string {
  return shouldRedact(privacyMode, DataClassification.PATH) ? formatRedacted(fieldName) : path;
}

function redactPathForLog(path: string, privacyMode: PrivacyModeValue, fieldName: string): string {
  return redactPath(path, privacyMode, fieldName);
}

interface ProviderErrorFields {
  code?: string;
  message?: string;
}

function parseProviderErrorFields(responseData: unknown): ProviderErrorFields {
  const topErrorSchema = z.object({
    error: z.object({
      message: z.string().optional(),
      provider: z.object({ body: z.string().optional() }).optional(),
    }).optional(),
  });
  const nestedProviderErrorSchema = z.object({
    error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
  });
  const topParsed = topErrorSchema.safeParse(responseData);
  if (!topParsed.success || topParsed.data.error === undefined) return {};
  const topError = topParsed.data.error;
  let nestedCode: string | undefined;
  let nestedMessage: string | undefined;
  const providerBody = topError.provider?.body;
  if (providerBody !== undefined) {
    let nestedJson: unknown;
    try { nestedJson = JSON.parse(providerBody); } catch { nestedJson = undefined; }
    const nestedParsed = nestedProviderErrorSchema.safeParse(nestedJson);
    if (nestedParsed.success) {
      nestedCode = nestedParsed.data.error?.code?.trim();
      nestedMessage = nestedParsed.data.error?.message?.trim();
    }
  }
  const fields: ProviderErrorFields = {};
  const code = nestedCode !== undefined && nestedCode.length > 0 ? nestedCode : undefined;
  const message = nestedMessage !== undefined && nestedMessage.length > 0
    ? nestedMessage
    : topError.message !== undefined && topError.message.trim().length > 0 ? topError.message.trim() : undefined;
  if (code !== undefined) fields.code = code;
  if (message !== undefined) fields.message = message;
  return fields;
}

function extractProviderErrorSummary(responseData: unknown): string | undefined {
  const { message: providerMessage, code: providerCode } = parseProviderErrorFields(responseData);
  if (providerMessage === undefined && providerCode === undefined) return undefined;
  const metadata = providerCode === undefined ? "" : ` (code=${providerCode})`;
  return `${providerMessage ?? "Image generation request rejected by provider"}${metadata}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function isContentSafetyBlockedError(error: unknown): boolean {
  if (error instanceof Error && error.name === "ImageGenerationContentSafetyError") return true;
  const record = asRecord(error);
  if (record === undefined) return false;
  const response = asRecord(record.response);
  const fields = parseProviderErrorFields(response?.data);
  if (fields.code === "moderation_blocked") return true;
  return record.cause === undefined ? false : isContentSafetyBlockedError(record.cause);
}

function getProviderResponseStatusCode(error: unknown): number | undefined {
  const record = asRecord(error);
  if (record === undefined) return undefined;
  const response = asRecord(record.response);
  if (typeof response?.status === "number") return response.status;
  return record.cause === undefined ? undefined : getProviderResponseStatusCode(record.cause);
}

function getProviderResponseDetails(error: unknown): string | undefined {
  const record = asRecord(error);
  if (record === undefined) return undefined;
  const response = asRecord(record.response);
  const status = typeof response?.status === "number" ? response.status : undefined;
  const statusText = typeof response?.statusText === "string" ? response.statusText : undefined;
  const providerErrorSummary = extractProviderErrorSummary(response?.data);
  if (status !== undefined || providerErrorSummary !== undefined) {
    const pieces: string[] = [];
    if (status !== undefined) pieces.push(statusText !== undefined && statusText.trim().length > 0 ? `status=${status} ${statusText}` : `status=${status}`);
    if (providerErrorSummary !== undefined) pieces.push(`provider_error=${providerErrorSummary}`);
    return pieces.join(", ");
  }
  return record.cause === undefined ? undefined : getProviderResponseDetails(record.cause);
}

function getGenerateImageBaseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getGenerateImageDetailedErrorMessage(error: unknown): string {
  const baseMessage = getGenerateImageBaseErrorMessage(error);
  const providerDetails = getProviderResponseDetails(error);
  if (providerDetails === undefined || baseMessage.includes(providerDetails)) return baseMessage;
  return `${baseMessage}. ${providerDetails}`;
}

interface ReadReferenceImage {
  readonly data: string;
  readonly mimeType: string;
}

async function readReferenceImages(
  context: Context,
  readExecutor: ReadExecutor,
  paths: readonly string[],
  toolCallId: string,
  privacyMode: PrivacyModeValue,
): Promise<readonly ReadReferenceImage[]> {
  if (paths.length === 0) return [];
  const results = await Promise.all(paths.map(async path => {
    const logImagePath = redactPathForLog(path, privacyMode, "image_path");
    try {
      const result = await readExecutor.execute(context, new ReadArgs({ path, toolCallId }));
      if (result.result.case !== "success") {
        logger.warn(context, "[generate-image] ref image read failed", { imagePath: logImagePath });
        return null;
      }
      const output = result.result.value.output;
      if (output.case !== "data" || !output.value || output.value.length === 0) {
        logger.warn(context, "[generate-image] ref image read empty", { imagePath: logImagePath });
        return null;
      }
      logger.info(context, "[generate-image] ref image read success", { imagePath: logImagePath, dataLength: output.value.length });
      return {
        data: Buffer.from(output.value).toString("base64"),
        mimeType: getImageMimeTypeFromPath(path),
      };
    } catch (error) {
      logger.error(context, "[generate-image] ref image read failed", { imagePath: logImagePath, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }));
  return results.filter((result): result is ReadReferenceImage => result !== null && result !== undefined);
}

function stripDataUriPrefix(imageData: string): string {
  return imageData.includes(",") ? imageData.split(",")[1] ?? "" : imageData;
}

function crossPlatformBasename(filePath: string): string {
  return basename(filePath.replaceAll("\\", "/"));
}

function getImageOutputPath(options: { projectFolder: string; filename: string; artifactsFolder?: string }): string {
  const { projectFolder, filename, artifactsFolder } = options;
  return join(artifactsFolder || projectFolder, "assets", filename);
}

async function writeGeneratedImage(
  context: Context,
  writeExecutor: WriteExecutor,
  options: {
    readonly projectFolder: string;
    readonly filePath: string;
    readonly imageData: string;
    readonly artifactsFolder?: string;
    readonly privacyMode?: PrivacyModeValue;
  },
): Promise<GenerateImageResult> {
  const { projectFolder, filePath, imageData, artifactsFolder } = options;
  const location = artifactsFolder ? "artifacts" : "project";
  const path = getImageOutputPath({ projectFolder, filename: crossPlatformBasename(filePath), ...(artifactsFolder === undefined ? {} : { artifactsFolder }) });
  const imageBytes = Buffer.from(stripDataUriPrefix(imageData), "base64");
  const privacyMode = options.privacyMode ?? PrivacyMode.UNSPECIFIED;
  const result = await writeExecutor.execute(context, new WriteArgs({
    path,
    fileBytes: new Uint8Array(imageBytes),
    returnFileContentAfterWrite: false,
  }));
  const resultCase = result.result.case ?? "undefined";
  const permissionLabels = getPermissionLabels(result);
  generateImageWriteResultCounter.increment(context, 1, {
    result: resultCase,
    location,
    operation: permissionLabels.operation,
    is_readonly: permissionLabels.isReadonly,
  });
  if (result.result.case === "success") {
    logger.info(context, "[generate-image] write success", { outputPath: redactPathForLog(path, privacyMode, "output_path"), size: imageBytes.length });
    return new GenerateImageResult({ result: { case: "success", value: new GenerateImageSuccess({ filePath: path, imageData: artifactsFolder ? "" : imageData }) } });
  }
  if (result.result.case === "permissionDenied" && result.result.value.isReadonly) {
    return new GenerateImageResult({ result: { case: "error", value: new GenerateImageError({ error: ASK_MODE_MODEL_ERROR }) } });
  }
  let errorDetail: string;
  let toThrow: Error;
  switch (result.result.case) {
    case "error":
      errorDetail = result.result.value.error;
      toThrow = new Error(`Failed to save generated image: ${errorDetail}`);
      break;
    case "permissionDenied":
      errorDetail = `permission denied (operation=${result.result.value.operation}, isReadonly=${result.result.value.isReadonly}, error=${result.result.value.error})`;
      toThrow = new ToolCallUnexpectedEnvironmentError(`Failed to save generated image: ${errorDetail}`);
      break;
    case "rejected": {
      errorDetail = `rejected (reason=${result.result.value.reason})`;
      const message = `Failed to save generated image: ${errorDetail}`;
      toThrow = result.result.value.reason.includes("Failed to find tool call context") ? new Error(message) : new ToolCallRejectedError(message);
      break;
    }
    case "noSpace":
      errorDetail = "No space left on device";
      toThrow = new CustomToolCallError(ToolErrorClassification.BAD_USER_DEVICE_STATE, { clientVisibleErrorMessage: `Failed to save generated image: ${errorDetail}`, modelVisibleErrorMessage: `Failed to save generated image: ${errorDetail}`, error: `Failed to save generated image: ${errorDetail}` });
      break;
    case undefined:
      errorDetail = "unknown result case";
      toThrow = new Error(`Failed to save generated image: ${errorDetail}`);
      break;
    default:
      errorDetail = "unhandled case";
      toThrow = new Error(`Failed to save generated image: ${errorDetail}`);
      break;
  }
  logger.error(context, "[generate-image] write failed", { outputPath: redactPathForLog(path, privacyMode, "output_path"), resultCase, error: errorDetail });
  throw toThrow;
}

function resultToString(result: GenerateImageResult): string {
  switch (result.result.case) {
    case "success": return `Successfully generated image at: ${result.result.value.filePath}
Always use this absolute path when referring to the image. Do not repeat this image as a Markdown reference; it is already displayed to the user.`;
    case "error": return `Failed to generate image, error: ${result.result.value.error}`;
    case undefined: return "An unknown error occurred.";
  }
}

function isGenerateImageToolDependencies(value: unknown): value is GenerateImageToolDependencies {
  return typeof value === "object" && value !== null && "resourceAccessor" in value && "generateImageService" in value;
}

export function createGenerateImageTool(
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  generateImageService: GenerateImageService,
  promptVersion?: string,
  requestContext?: GenerateImageRequestContext,
  imageGenerationConcurrencyLimiter?: ImageGenerationConcurrencyLimiter,
  isReadonly?: boolean,
  suspiciousKeywords?: readonly string[],
  isModelRestricted?: boolean,
): ReturnType<typeof createZodAgentTool>;
export function createGenerateImageTool(dependencies: GenerateImageToolDependencies): ReturnType<typeof createZodAgentTool>;
export function createGenerateImageTool(
  resourceAccessorOrDependencies: ResourceAccessor<RemoteExecManager> | GenerateImageToolDependencies,
  generateImageService?: GenerateImageService,
  promptVersion?: string,
  requestContext?: GenerateImageRequestContext,
  imageGenerationConcurrencyLimiter?: ImageGenerationConcurrencyLimiter,
  isReadonly?: boolean,
  suspiciousKeywords: readonly string[] = DEFAULT_SUSPICIOUS_KEYWORDS,
  isModelRestricted?: boolean,
): ReturnType<typeof createZodAgentTool> {
  let legacyObjectForm = false;
  if (isGenerateImageToolDependencies(resourceAccessorOrDependencies) && generateImageService === undefined) {
    legacyObjectForm = true;
    const dependencies = resourceAccessorOrDependencies;
    generateImageService = dependencies.generateImageService;
    promptVersion = dependencies.promptVersion;
    requestContext = dependencies.requestContext;
    imageGenerationConcurrencyLimiter = dependencies.imageGenerationConcurrencyLimiter;
    isReadonly = dependencies.isReadonly;
    suspiciousKeywords = dependencies.suspiciousKeywords ?? DEFAULT_SUSPICIOUS_KEYWORDS;
    isModelRestricted = dependencies.isModelRestricted;
    resourceAccessorOrDependencies = dependencies.resourceAccessor;
  }
  if (typeof generateImageService !== "function") throw new TypeError("createGenerateImageTool: generateImageService is required");
  const resourceAccessor = resourceAccessorOrDependencies as ResourceAccessor<RemoteExecManager>;
  const generateImage = generateImageService;
  const version = promptVersion ?? "latest";
  const suspiciousTerms = suspiciousKeywords;
  const parameters = z.object({
    description: z.string().describe("A detailed description of the image."),
    filename: z.string().optional().describe("Optional filename for the generated image (e.g., 'diagram.png'). Do not include a directory path - the tool automatically handles where to save and how to display the image. If not provided, a timestamped filename will be generated."),
    reference_image_paths: z.array(z.string()).optional().describe("Optional array of file paths to reference images as additional inputs."),
    aspect_ratio: z.enum(SUPPORTED_ASPECT_RATIOS).optional().describe('Optional aspect ratio for the generated image. Supported values are "1:1", "4:3", "3:4", "16:9", and "9:16".'),
  });
  const execute = async (
    parentContext: Context,
    interactionHandler: { executeToolCall: (context: Context, toolCall: ReturnType<typeof createGenerateImageToolCall>, toolCallId: string, run: (context: Context) => Promise<GenerateImageResult>, merge: (result: GenerateImageResult) => ReturnType<typeof createGenerateImageToolCall>) => Promise<GenerateImageResult> },
    rawArgs: z.infer<typeof parameters>,
    meta: { readonly toolCallId: string; readonly stateHandler?: GenerateImageStateHandler },
  ): Promise<GenerateImageResult> => {
    using span = createSpan(parentContext.withName("generateImageExecute"));
    const executeStartTimeMs = Date.now();
    let finishRecorded = false;
    let errorStage: GenerateImageErrorStage | undefined;
    let executeOutcome = "internal_error";
    const trimmedDescription = rawArgs.description.trim();
    const promptWords = trimmedDescription.length > 0 ? trimmedDescription.split(/\s+/) : [];
    const promptWordCount = promptWords.length;
    const lowerDescription = rawArgs.description.toLowerCase();
    const isSuspicious = promptWordCount <= VERY_SHORT_PROMPT_WORD_THRESHOLD || promptWordCount <= SHORT_PROMPT_WORD_THRESHOLD && suspiciousTerms.some(keyword => lowerDescription.includes(keyword));
    if (isModelRestricted) {
      executeOutcome = "model_restricted";
      recordGenerateImageExecuteFinish(parentContext, executeOutcome);
      finishRecorded = true;
      generateImageExecuteDurationMs.histogram(parentContext, Date.now() - executeStartTimeMs, { outcome: executeOutcome });
      return new GenerateImageResult({ result: { case: "error", value: new GenerateImageError({ error: MODEL_RESTRICTED_ERROR }) } });
    }
    if (isSuspicious) {
      generateImageShortPromptCounter.increment(parentContext, 1, { word_count: String(promptWordCount) });
      logger.warn(parentContext, "[generate-image] short/suspicious prompt rejected", { wordCount: promptWordCount });
      executeOutcome = "short_prompt_rejected";
      recordGenerateImageExecuteFinish(parentContext, executeOutcome);
      finishRecorded = true;
      generateImageExecuteDurationMs.histogram(parentContext, Date.now() - executeStartTimeMs, { outcome: executeOutcome });
      return new GenerateImageResult({ result: { case: "error", value: new GenerateImageError({ error: "Image generation was not performed — the tool call appears to be unintended. Do not retry or call GenerateImage again unless the user explicitly asks for an image." }) } });
    }
    if (isReadonly) {
      executeOutcome = "readonly_rejected";
      recordGenerateImageExecuteFinish(parentContext, executeOutcome);
      finishRecorded = true;
      generateImageExecuteDurationMs.histogram(parentContext, Date.now() - executeStartTimeMs, { outcome: executeOutcome });
      return new GenerateImageResult({ result: { case: "error", value: new GenerateImageError({ error: ASK_MODE_MODEL_ERROR }) } });
    }
    const baseArgs = new GenerateImageArgs({ description: rawArgs.description, referenceImagePaths: rawArgs.reference_image_paths ?? [], ...(rawArgs.filename === undefined ? {} : { filePath: rawArgs.filename }), ...(rawArgs.aspect_ratio === undefined ? {} : { aspectRatio: rawArgs.aspect_ratio }) });
    const baseToolCall = new GenerateImageToolCall({ args: baseArgs });
    try {
      const result = await interactionHandler.executeToolCall(span.ctx, createGenerateImageToolCall(baseToolCall), meta.toolCallId, async context => {
        const env = requestContext?.env;
        const projectFolder = env?.projectFolder || env?.artifactsFolder || env?.workspacePaths?.[0];
        if (projectFolder === undefined || projectFolder.trim().length === 0) {
          errorStage = "project_folder";
          recordGenerateImageExecuteError(context, "project_folder");
          logger.error(context, "[generate-image] no project folder available to save the generated image", { generate_image: { projectFolder: env?.projectFolder, artifactsFolder: env?.artifactsFolder, workspacePaths: env?.workspacePaths } });
          throw new ToolCallUnexpectedEnvironmentError(NO_PROJECT_FOLDER_ERROR);
        }
        const readExecutor = resourceAccessor.get(readExecutorResource);
        const writeExecutor = resourceAccessor.get(writeExecutorResource);
        const privacyMode = meta.stateHandler?.getPrivacyMode?.() ?? PrivacyMode.UNSPECIFIED;
        let references: readonly ReadReferenceImage[];
        try {
          references = await readReferenceImages(context, readExecutor, rawArgs.reference_image_paths ?? [], meta.toolCallId, privacyMode);
        } catch (error) {
          errorStage = "read_reference_images";
          recordGenerateImageExecuteError(context, "read_reference_images");
          throw error;
        }
        await imageGenerationConcurrencyLimiter?.acquire();
        try {
          let generated: GeneratedImageToolResult;
          try {
            generated = await generateImage(span.ctx, baseArgs.description, rawArgs.filename, references.length > 0 || legacyObjectForm ? references : undefined, rawArgs.aspect_ratio);
            if (generated.usage !== undefined) meta.stateHandler?.addTurnUsage?.(generated.usage);
          } catch (error) {
            errorStage = "provider_inference";
            recordGenerateImageExecuteError(context, "provider_inference");
            throw error;
          }
          try {
            return await writeGeneratedImage(context, writeExecutor, { projectFolder, filePath: generated.filePath, imageData: generated.imageData, ...(env?.artifactsFolder === undefined ? {} : { artifactsFolder: env.artifactsFolder }), privacyMode });
          } catch (error) {
            errorStage = "write_output";
            recordGenerateImageExecuteError(context, "write_output");
            throw error;
          }
        } finally {
          imageGenerationConcurrencyLimiter?.release();
        }
      }, result => createGenerateImageToolCall(new GenerateImageToolCall({ ...baseToolCall, result })));
      executeOutcome = "success";
      recordGenerateImageExecuteFinish(parentContext, executeOutcome);
      finishRecorded = true;
      return result;
    } catch (error) {
      const isAborted = parentContext.signal.aborted || error instanceof ToolCallAbortedError || error instanceof Error && error.name === "AbortError";
      if (isAborted) {
        const { reasonInfo, finishOutcome } = classifyAbortFinish(parentContext.reason);
        if (!finishRecorded) {
          executeOutcome = finishOutcome;
          recordGenerateImageExecuteFinish(parentContext, executeOutcome);
          finishRecorded = true;
        }
        generateImageAbortCounter.increment(parentContext, 1, { phase: "execute", abort_reason_type: finishOutcome });
        logger.warn(parentContext, "[generate-image] aborted", { ...reasonInfo, abortReason: finishOutcome });
      } else if (!finishRecorded) {
        const finishOutcome = errorStage === undefined ? "internal_error" : classifyErrorFinishReason(errorStage);
        executeOutcome = finishOutcome;
        recordGenerateImageExecuteFinish(parentContext, executeOutcome);
        finishRecorded = true;
      }
      if (!isAborted && isContentSafetyBlockedError(error)) throw new CustomToolCallError(ToolErrorClassification.INVALID_ARGS, { clientVisibleErrorMessage: CONTENT_SAFETY_BLOCKED_ERROR, modelVisibleErrorMessage: CONTENT_SAFETY_BLOCKED_ERROR, error: CONTENT_SAFETY_BLOCKED_ERROR });
      const providerDetails = getProviderResponseDetails(error);
      if (!isAborted && providerDetails !== undefined) {
        const baseMessage = getGenerateImageBaseErrorMessage(error);
        const classification = getProviderResponseStatusCode(error) === 400 ? ToolErrorClassification.INVALID_ARGS : ToolErrorClassification.PROVIDER_ERROR;
        throw new CustomToolCallError(classification, { clientVisibleErrorMessage: baseMessage, modelVisibleErrorMessage: baseMessage, error: getGenerateImageDetailedErrorMessage(error) });
      }
      throw error;
    } finally {
      if (!finishRecorded) recordGenerateImageExecuteFinish(parentContext, executeOutcome);
      generateImageExecuteDurationMs.histogram(parentContext, Date.now() - executeStartTimeMs, { outcome: executeOutcome });
    }
  };
  return createZodAgentTool("GENERATE_IMAGE", {
    name: getToolName(version),
    contextType: { type: "dynamic" },
    descriptionGenerator: () => getDescription(version),
    parameters,
    execute: withSafeParsedArgs(parameters, execute, createGenerateImageToolCall(new GenerateImageToolCall())),
    render: async (context: Context, result: GenerateImageResult) => {
      let renderOutcome = "internal_error";
      try {
        if (result.result.case === "success") {
          const { filePath, imageData } = result.result.value;
        const artifactsFolder = requestContext?.env?.artifactsFolder;
        if (artifactsFolder && filePath.startsWith(artifactsFolder)) {
          renderOutcome = "success";
          return createStringResult(`Successfully generated image. Display it in your response using:\n<img src="${filePath}" alt="Generated image" />`);
        }
          if (version === "dsv3-1018" || version === "dsv3-1205" || version === "cursor-0226") {
            renderOutcome = "success";
            return createStringResult(resultToString(result));
          }
          if (!imageData) {
            renderOutcome = "missing_image_data";
            return createStringResult("Failed to generate image: no image data returned");
          }
          try {
            const resized = await resizeImageBufferIfNeeded(Buffer.from(stripDataUriPrefix(imageData), "base64"));
            renderOutcome = "success";
            return createImageResult(Buffer.from(resized.data).toString("base64"), resized.mimeType, resultToString(result));
          } catch (error) {
            renderOutcome = isResizeImageError(error) ? "resize_error" : "internal_error";
            throw error;
          }
        }
        if (result.result.case === "error" && result.result.value.error === ASK_MODE_MODEL_ERROR) {
          renderOutcome = "success";
          return createStringResult(ASK_MODE_MODEL_ERROR);
        }
        renderOutcome = "success";
        return createStringResult(resultToString(result));
      } finally {
        recordGenerateImageRenderFinish(context, renderOutcome);
      }
    },
      serializeError: (error: unknown) => createGenerateImageToolCall(new GenerateImageToolCall({ result: new GenerateImageResult({ result: { case: "error", value: new GenerateImageError({ error: error instanceof ToolCallError ? error.clientVisibleErrorMessage : getGenerateImageBaseErrorMessage(error) }) } }) })),
  });
}
