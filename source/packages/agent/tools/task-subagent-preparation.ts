import path from "node:path";
import mimeTypesModule from "mime-types";

import { isGeminiModelId, isSignedUrlStorageAllowed, GEMINI_VIDEO_SUBAGENT_MAX_BYTES, getInlineVideoMaxBytes, getSignedUrlVideoMaxBytes, uploadAttachedMediaToSignedUrl } from "../attached-media.js";
import type { Context } from "../../context/core.js";
import { ConversationStateStructure, PreparedTaskSubagent, SubagentCredentials, SubagentExecutionEnvironment, TaskToolCallArgsProto } from "../../proto/generated/agent/v1/agent_pb.js";
import type { AttachedMediaUrlProvider } from "../context-processing-video-data.js";
import { detectImageMimeType } from "./core/read/image-utils.js";
import { requestContextExecutorResource } from "../../agent-exec/request-context.js";
import { readExecutorResource } from "../../agent-exec/read.js";
import { RequestContextArgs, type RequestContextResult } from "../../proto/generated/agent/v1/request_context_exec_pb.js";
import { ReadArgs, type ReadResult } from "../../proto/generated/agent/v1/read_exec_pb.js";
import type { SubagentPersistedState } from "../../proto/generated/agent/v1/agent_pb.js";
import type { SubagentType } from "../../proto/generated/agent/v1/subagents_pb.js";
import { SelectedContext, SelectedImage, SelectedImage_BlobIdWithData, SelectedVideo, SelectedVideo_BlobIdWithData, SelectedVideo_SignedUrl, type SelectedContext as SelectedContextValue, type SelectedCursorCommand } from "../../proto/generated/agent/v1/selected_context_pb.js";
import type { PrivacyMode } from "../../redaction/privacy-mode.js";
import { GENERAL_PURPOSE_SUBAGENT_TYPE, applyConversationStateMapping, getSubagentTypeName, isGeminiVideoSubagentType } from "./core/subagent/subagent-config.js";
import { computeSubagentRequestId, generateSeededUuid, ToolCallArgParseError } from "./common.js";
import { getRequestId, getRootParentRequestId } from "../utils/request-id.js";
import { SubagentModelForcePolicy } from "./subagent-model-force-policy.js";
import {
  resolveSubagentModel,
  getEffectiveReadonlyForSubagent,
  shouldUseAskModeForSubagent,
  taskEnvironmentToProto,
  targetMachineToEnvironment,
  targetMachineFromLegacyArgs,
  targetMachineFromProto,
  targetMachineToProto,
  createUserMessageAction,
  type TaskEnvironment,
  type TaskTargetMachine,
  type TaskSubagentModelConfig,
} from "./task-cluster-internal.js";

interface MimeTypesModule {
  lookup(filePath: string): string | false;
}

const mimeTypes = mimeTypesModule as MimeTypesModule;

export type RawTaskEnvironmentArgs = {
  readonly environment?: TaskEnvironment;
  readonly machine?: TaskTargetMachine;
};

export function protoEnvironmentToTaskEnvironment(
  environment: SubagentExecutionEnvironment,
): TaskEnvironment {
  switch (environment) {
    case SubagentExecutionEnvironment.CLOUD:
      return "cloud";
    case SubagentExecutionEnvironment.LOCAL:
      return "local";
    default:
      return undefined;
  }
}

export function getEffectiveSubagentEnvironment(
  rawArgs: RawTaskEnvironmentArgs,
  restoredState: Pick<
    SubagentPersistedState,
    "machine" | "environment" | "cloudSubagent"
  > | undefined,
): SubagentExecutionEnvironment {
  if (rawArgs.machine !== undefined) {
    return targetMachineToEnvironment(rawArgs.machine);
  }
  const requestedEnvironment = taskEnvironmentToProto(rawArgs.environment);
  if (requestedEnvironment !== SubagentExecutionEnvironment.UNSPECIFIED) {
    return requestedEnvironment;
  }
  const restoredMachine = targetMachineFromProto(restoredState?.machine);
  if (restoredMachine !== undefined) {
    return targetMachineToEnvironment(restoredMachine);
  }
  if (restoredState?.environment === SubagentExecutionEnvironment.CLOUD) {
    return SubagentExecutionEnvironment.CLOUD;
  }
  if (restoredState?.environment === SubagentExecutionEnvironment.LOCAL) {
    return SubagentExecutionEnvironment.LOCAL;
  }
  if (restoredState?.cloudSubagent !== undefined) {
    return SubagentExecutionEnvironment.CLOUD;
  }
  return SubagentExecutionEnvironment.UNSPECIFIED;
}

export interface CanonicalSubagentIdResolver {
  resolveSubagentId?: (subagentIdOrBcId: string) => string | undefined;
}

export function resolveCanonicalSubagentId(
  parentState: CanonicalSubagentIdResolver,
  subagentIdOrBcId: string,
): string {
  return parentState.resolveSubagentId?.(subagentIdOrBcId) ?? subagentIdOrBcId;
}

const VIDEO_MIME_MAP: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  m4v: "video/x-m4v",
};

export function getVideoMimeTypeFromPath(filePath: string): string | undefined {
  const extension = filePath.split(".").pop()?.toLowerCase();
  return extension === undefined ? undefined : VIDEO_MIME_MAP[extension];
}

export function getPotentialVideoMimeTypeFromPath(
  filePath: string,
): string | undefined {
  const mappedMime = getVideoMimeTypeFromPath(filePath);
  if (mappedMime !== undefined) {
    return mappedMime;
  }
  const lookupMime = mimeTypes.lookup(filePath);
  return typeof lookupMime === "string" && lookupMime.startsWith("video/")
    ? lookupMime
    : undefined;
}

export interface AttachmentPathEnvironment {
  readonly projectFolder?: string;
  readonly workspacePaths: readonly string[];
  readonly artifactsFolder?: string;
}

export interface AttachmentPathRequestContext {
  readonly env?: AttachmentPathEnvironment;
}

export function isPathWithinPrefix2(args: {
  readonly targetPath: string;
  readonly prefix: string;
}): boolean {
  const resolvedTarget = path.resolve(args.targetPath);
  const resolvedPrefix = path.resolve(args.prefix);
  return (
    resolvedTarget === resolvedPrefix ||
    resolvedTarget.startsWith(resolvedPrefix + path.sep)
  );
}

export function untrustedAttachmentPathError(attachmentPath: string): Error {
  return new Error(
    `Attachment path is not trusted: ${attachmentPath}. Only videos the user attached to this conversation, or files under this agent's own uploads/artifacts roots, can be passed in file_attachments — copying the file somewhere else, onto the user's computer especially, cannot make it trusted.`,
  );
}

export function resolveTrustedAttachmentPath(args: {
  readonly attachmentPath: string;
  readonly requestContext: AttachmentPathRequestContext;
  readonly userAttachedVideoPaths?: readonly string[];
  readonly trustedVideoAttachmentRoots?: readonly string[];
}): string | undefined {
  const posixPath = path.posix.normalize(args.attachmentPath);
  if (
    (args.trustedVideoAttachmentRoots ?? []).some(
      (root) =>
        root.startsWith("/") &&
        root.length > 1 &&
        posixPath.startsWith(`${root}/`),
    )
  ) {
    return posixPath;
  }
  const canonicalPath = path.resolve(args.attachmentPath);
  const env = args.requestContext.env;
  const allowedPrefixes = [
    ...(env?.projectFolder !== undefined
      ? [
          path.join(env.projectFolder, "uploads"),
          path.join(env.projectFolder, "attachments"),
        ]
      : []),
    ...(env?.workspacePaths.flatMap((workspacePath) => [
      path.join(workspacePath, "uploads"),
      path.join(workspacePath, "attachments"),
    ]) ?? []),
    env?.artifactsFolder,
  ].filter((prefix): prefix is string => prefix !== undefined);
  if (
    allowedPrefixes.some((prefix) =>
      isPathWithinPrefix2({ targetPath: canonicalPath, prefix }),
    )
  ) {
    return canonicalPath;
  }
  const userAttachedPaths = (args.userAttachedVideoPaths ?? []).map((attachedPath) =>
    path.resolve(attachedPath),
  );
  return userAttachedPaths.includes(canonicalPath) ? canonicalPath : undefined;
}

export interface AttachmentRequestContext {
  readonly env?: AttachmentPathEnvironment;
}

export function attachmentPathEnvironment(
  requestContext: AttachmentRequestContext,
): AttachmentPathEnvironment {
  return requestContext.env ?? { workspacePaths: [] };
}

interface AttachmentResourceAccessor {
  get(resource: typeof requestContextExecutorResource): {
    execute(ctx: Context, args: RequestContextArgs): Promise<RequestContextResult>;
  };
  get(resource: typeof readExecutorResource): {
    execute(
      ctx: Context,
      args: ReadArgs,
      meta: { readonly execId: string },
    ): Promise<ReadResult>;
  };
}

interface AttachmentRequestContextResult {
  readonly requestContext: AttachmentRequestContext;
}

async function getRequestContextForAttachmentValidation(args: {
  readonly ctx: Context;
  readonly resourceAccessor: AttachmentResourceAccessor;
}): Promise<AttachmentRequestContext> {
  const requestContextExecutor = args.resourceAccessor.get(requestContextExecutorResource);
  const requestContextResult = await requestContextExecutor.execute(
    args.ctx,
    new RequestContextArgs(),
  );
  if (
    requestContextResult.result.case !== "success" ||
    requestContextResult.result.value.requestContext === undefined
  ) {
    throw new Error("Failed to validate attachment paths");
  }
  return requestContextResult.result.value.requestContext;
}

export interface AttachmentProcessingOptions {
  readonly resolvedModelId?: string;
  readonly privacyMode?: PrivacyMode;
  readonly attachedMediaUrlProvider?: AttachedMediaUrlProvider;
  readonly conversationId?: string;
  readonly inlineVideoMaxBytes?: number;
  readonly signedUrlVideoMaxBytes?: number;
  readonly subagentType?: SubagentType;
  readonly useGeminiDeveloperVideoUpload?: boolean;
  readonly skipTrustedPathValidation?: boolean;
  readonly userAttachedVideoPaths?: readonly string[];
  readonly trustedVideoAttachmentRoots?: readonly string[];
}

export interface PreparedAttachmentContextArgs {
  readonly ctx: Context;
  readonly attachmentPaths: readonly string[];
  readonly resourceAccessor: AttachmentResourceAccessor;
  readonly toolCallId: string;
  readonly options?: AttachmentProcessingOptions;
}

export async function buildClientSubagentAttachmentsContext(
  ctx: Context,
  attachmentPaths: readonly string[],
  resourceAccessor: AttachmentResourceAccessor,
  toolCallId: string,
  options?: AttachmentProcessingOptions,
): Promise<SelectedContextValue | undefined> {
  if (attachmentPaths.length === 0) {
    return undefined;
  }
  const videoPaths: string[] = [];
  const nonVideoPaths: string[] = [];
  for (const attachmentPath of attachmentPaths) {
    if (getPotentialVideoMimeTypeFromPath(attachmentPath) !== undefined) {
      videoPaths.push(attachmentPath);
    } else {
      nonVideoPaths.push(attachmentPath);
    }
  }
  const selectedContext =
    (nonVideoPaths.length > 0
      ? await processAttachments(
          ctx,
          nonVideoPaths,
          resourceAccessor,
          toolCallId,
          options,
        )
      : undefined) ?? new SelectedContext();
  if (videoPaths.length === 0) {
    return selectedContext;
  }
  const requestContext = await getRequestContextForAttachmentValidation({
    ctx,
    resourceAccessor,
  });
  const resolvedModelId = options?.resolvedModelId?.trim();
  if (
    resolvedModelId !== undefined &&
    resolvedModelId.length > 0 &&
    !isGeminiModelId(resolvedModelId)
  ) {
    throw new Error("Video attachments are only supported for Gemini models");
  }
  const selectedVideos = [...selectedContext.selectedVideos];
  for (const rawFilePath of videoPaths) {
    const trustedPathArgs = {
      attachmentPath: rawFilePath,
      requestContext,
      ...(options?.userAttachedVideoPaths !== undefined
        ? { userAttachedVideoPaths: options.userAttachedVideoPaths }
        : {}),
      ...(options?.trustedVideoAttachmentRoots !== undefined
        ? { trustedVideoAttachmentRoots: options.trustedVideoAttachmentRoots }
        : {}),
    };
    const filePath = resolveTrustedAttachmentPath(trustedPathArgs);
    if (filePath === undefined) {
      throw untrustedAttachmentPathError(rawFilePath);
    }
    const mimeType = getPotentialVideoMimeTypeFromPath(filePath);
    if (mimeType === undefined) {
      throw new Error(`Could not detect mime type for attachment: ${filePath}`);
    }
    selectedVideos.push(
      new SelectedVideo({
        uuid: generateSeededUuid(`video-${toolCallId}-${filePath}`),
        path: filePath,
        mimeType,
        filename: path.basename(filePath),
        fps: 4,
      }),
    );
  }
  return new SelectedContext({ ...selectedContext, selectedVideos });
}

export interface ConversationStateParent {
  getConversationState(ctx: Context): Promise<ConversationStateStructure>;
  restoreSubagentState(
    ctx: Context,
    subagentId: string,
  ): Pick<SubagentPersistedState, "conversationState" | "cloudSubagent" | "subagentType" | "modelId" | "machine" | "environment" | "firstClassBcId" | "cloudRequestedEnvironmentBuildId"> | undefined;
}

export interface ConversationStateSubagentConfig {
  readonly conversationStateMapper?: ((
    callerState: ConversationStateStructure,
  ) => ConversationStateStructure) | undefined;
}

export async function resolveSubagentConversationState(
  ctx: Context,
  subagentConfig: ConversationStateSubagentConfig,
  parentState: ConversationStateParent,
  subagentIdToResume: string | undefined,
  isSelfForkRequested: boolean,
  toolCallId: string,
  typeName: string,
): Promise<ConversationStateStructure> {
  if (isSelfForkRequested) {
    return parentState.getConversationState(ctx);
  }
  if (subagentIdToResume !== undefined) {
    const restoredState = parentState.restoreSubagentState(ctx, subagentIdToResume);
    if (restoredState?.conversationState !== undefined) {
      return restoredState.conversationState;
    }
    if (restoredState?.cloudSubagent !== undefined) {
      return new ConversationStateStructure();
    }
  }
  return applyConversationStateMapping(
    subagentConfig,
    await parentState.getConversationState(ctx),
  );
}

export interface PriorSubagentModelOptions {
  readonly isModelBlocked: (modelId: string) => boolean;
  readonly requiresMaxMode?: (modelId: string) => Promise<boolean>;
  readonly parentMaxMode: boolean;
}

export async function isPriorSubagentModelUsable(
  modelId: string,
  options: PriorSubagentModelOptions,
): Promise<boolean> {
  if (options.isModelBlocked(modelId)) {
    return false;
  }
  if (options.requiresMaxMode === undefined) {
    return true;
  }
  const modelRequiresMaxMode = await options.requiresMaxMode(modelId);
  return options.parentMaxMode || !modelRequiresMaxMode;
}

export interface TaskRawArguments {
  readonly description?: string;
  readonly prompt: string;
  readonly model?: string;
  readonly resume?: string;
  readonly subagent_type?: string;
  readonly file_attachments?: readonly string[];
  readonly environment?: TaskEnvironment;
  readonly cloud_base_branch?: string;
  readonly cloud_requested_environment_build_id?: string;
  readonly machine?: TaskTargetMachine;
  readonly run_in_background?: boolean;
}

export interface TaskResolutionParentState extends ConversationStateParent {
  resolveSubagentId?: (subagentIdOrBcId: string) => string | undefined;
  getSubagentIdToResume?: (typeName: string, mode: string) => string | undefined;
}

export interface TaskResolutionMeta {
  readonly toolCallId: string;
}

export interface TaskResolutionModelInfo {
  readonly modelName: string;
}

export interface TaskResolutionOptions {
  readonly forceModelId?: string;
  readonly subagentModelForcePolicy: (typeof SubagentModelForcePolicy)[keyof typeof SubagentModelForcePolicy];
  readonly parentRequestedModelName?: string;
  readonly parentModelParameters?: readonly unknown[];
  readonly parentMaxMode: boolean;
  readonly subagentModels: import("./core/subagent/models.js").SubagentModels;
  readonly isModelBlocked: (modelId: string) => boolean;
  readonly isModelValid: (modelId: string) => boolean;
  readonly requiresMaxMode?: (modelId: string) => Promise<boolean>;
  readonly compareModelCosts: (candidateModelId: string, parentModelId: string) => number;
  readonly enableExploreParentModelInheritance?: boolean;
}

export interface TaskSubagentResolution {
  readonly subagentConfig: TaskSubagentModelConfig;
  readonly effectiveReadonly: boolean;
  readonly useAskModeForSubagent: boolean;
  readonly typeName: string;
  readonly analyticsSubagentType: string;
  readonly resolvedModelId: string;
  readonly resolvedModelParameters?: readonly unknown[] | undefined;
  readonly subagentIdToResume?: string | undefined;
  readonly subagentId: string;
  readonly isResume: boolean;
  readonly parentRequestId?: string | undefined;
  readonly rootParentRequestId?: string | undefined;
  readonly subagentRequestId: string;
  readonly isSelfForkRequested: boolean;
  readonly effectiveEnvironment: SubagentExecutionEnvironment;
  readonly effectiveTargetMachine: TaskTargetMachine;
  readonly cloudSubagentBcId?: string | undefined;
  readonly cloudRequestedEnvironmentBuildId?: string | undefined;
}

function findSubagentConfigByName(
  configs: readonly TaskSubagentModelConfig[],
  name: string | undefined,
): TaskSubagentModelConfig | undefined {
  if (name === undefined) return undefined;
  const normalizedInput = name.trim().toLowerCase().replace(/[-_]/g, "");
  return configs.find(config => getSubagentTypeName(config.subagent_type).trim().toLowerCase().replace(/[-_]/g, "") === normalizedInput);
}

function isResumeSelfForkRequest(resume: string | undefined): boolean {
  return resume?.trim().toLowerCase() === "self";
}

export async function resolveTaskSubagentConfig(args: {
  readonly ctx: Context;
  readonly rawArgs: TaskRawArguments;
  readonly meta: TaskResolutionMeta;
  readonly subagentConfigs: readonly TaskSubagentModelConfig[];
  readonly parentState: TaskResolutionParentState;
  readonly parentModelInfo: TaskResolutionModelInfo;
  readonly options: TaskResolutionOptions;
}): Promise<TaskSubagentResolution> {
  const { ctx, rawArgs, meta, subagentConfigs, parentState, parentModelInfo, options } = args;
  const defaultConfig = findSubagentConfigByName(subagentConfigs, GENERAL_PURPOSE_SUBAGENT_TYPE) ?? subagentConfigs[0];
  if (defaultConfig === undefined) throw new ToolCallArgParseError("No subagent types are available.");
  const requestedSubagentConfig = findSubagentConfigByName(subagentConfigs, rawArgs.subagent_type) ?? defaultConfig;
  const effectiveResumeMode = requestedSubagentConfig.resumeModeOverride ?? "DEFAULT";
  const requestedTypeName = getSubagentTypeName(requestedSubagentConfig.subagent_type);
  const subagentRequestId = computeSubagentRequestId(meta.toolCallId);
  const isSelfForkRequested = isResumeSelfForkRequest(rawArgs.resume);
  let subagentIdToResume: string | undefined;
  if (!isSelfForkRequested) {
    if (effectiveResumeMode !== "DEFAULT") subagentIdToResume = parentState.getSubagentIdToResume?.(requestedTypeName, effectiveResumeMode);
    else if (rawArgs.resume !== undefined && rawArgs.resume.length > 0) subagentIdToResume = resolveCanonicalSubagentId(parentState, rawArgs.resume);
  }
  const restoredSubagentState = subagentIdToResume === undefined ? undefined : parentState.restoreSubagentState(ctx, subagentIdToResume);
  const persistedTypeName = restoredSubagentState?.subagentType === undefined ? undefined : getSubagentTypeName(restoredSubagentState.subagentType);
  const persistedSubagentConfig = findSubagentConfigByName(subagentConfigs, persistedTypeName);
  if (persistedTypeName !== undefined && persistedSubagentConfig === undefined) throw new ToolCallArgParseError(`Cannot resume subagent of type "${persistedTypeName}" because that subagent type is not available.`);
  const subagentConfig = persistedSubagentConfig ?? requestedSubagentConfig;
  const effectiveReadonly = getEffectiveReadonlyForSubagent(subagentConfig);
  const useAskModeForSubagent = shouldUseAskModeForSubagent(effectiveReadonly, subagentConfig);
  const typeName = getSubagentTypeName(subagentConfig.subagent_type);
  const analyticsSubagentType = subagentConfig.subagent_type.type.case === "custom" ? "custom" : typeName;
  const effectiveEnvironment = getEffectiveSubagentEnvironment(rawArgs, restoredSubagentState);
  const requestedTargetMachine = rawArgs.machine ?? targetMachineFromProto(restoredSubagentState?.machine) ?? (effectiveEnvironment === SubagentExecutionEnvironment.CLOUD
    ? targetMachineFromLegacyArgs({ environment: "cloud", cloud_base_branch: rawArgs.cloud_base_branch, cloud_requested_environment_build_id: rawArgs.cloud_requested_environment_build_id })
    : { type: "same_machine" });
  const priorModelId = isSelfForkRequested ? options.parentRequestedModelName ?? parentModelInfo.modelName : restoredSubagentState?.modelId?.trim() || undefined;
  if (priorModelId !== undefined && options.subagentModelForcePolicy === SubagentModelForcePolicy.ParentPin && options.forceModelId !== undefined && priorModelId !== options.forceModelId) throw new ToolCallArgParseError(`Cannot resume subagent with model "${priorModelId}" because the active policy requires model "${options.forceModelId}".`);
  const resolvedModelId = priorModelId ?? await resolveSubagentModel({
    subagentConfig,
    forceModelId: options.forceModelId,
    subagentModelForcePolicy: options.subagentModelForcePolicy,
    requestedModel: rawArgs.model,
    parentModelId: options.parentRequestedModelName ?? parentModelInfo.modelName,
    enableExploreParentModelInheritance: options.enableExploreParentModelInheritance,
    parentMaxMode: options.parentMaxMode,
    subagentModels: options.subagentModels,
    isModelBlocked: options.isModelBlocked,
    isModelValid: options.isModelValid,
    requiresMaxMode: options.requiresMaxMode,
    compareModelCosts: options.compareModelCosts,
  });
  if (priorModelId !== undefined && !await isPriorSubagentModelUsable(priorModelId, options)) throw new ToolCallArgParseError(`Cannot resume subagent with model "${priorModelId}" because it is blocked or unavailable.`);
  const subagentId = subagentIdToResume ?? generateSeededUuid(`subagent-${typeName}-${meta.toolCallId}`);
  const parentRequestId = getRequestId(ctx);
  const rootParentRequestId = getRootParentRequestId(ctx) ?? parentRequestId;
  const cloudSubagentBcId = restoredSubagentState?.cloudSubagent?.bcId?.trim() || restoredSubagentState?.firstClassBcId?.trim() || undefined;
  const cloudRequestedEnvironmentBuildId = requestedTargetMachine.type === "new_cloud_vm" ? requestedTargetMachine.environment_build_id?.trim() || rawArgs.cloud_requested_environment_build_id?.trim() || restoredSubagentState?.cloudRequestedEnvironmentBuildId?.trim() || undefined : undefined;
  const effectiveTargetMachine = requestedTargetMachine.type === "new_cloud_vm" && cloudRequestedEnvironmentBuildId !== requestedTargetMachine.environment_build_id
    ? { ...requestedTargetMachine, ...(cloudRequestedEnvironmentBuildId !== undefined ? { environment_build_id: cloudRequestedEnvironmentBuildId } : {}) }
    : requestedTargetMachine;
  const parentModelIdForParameters = options.parentRequestedModelName ?? parentModelInfo.modelName;
  const resolvedModelParameters = resolvedModelId === parentModelIdForParameters && (options.parentModelParameters?.length ?? 0) > 0 ? options.parentModelParameters : undefined;
  return { subagentConfig, effectiveReadonly, useAskModeForSubagent, typeName, analyticsSubagentType, resolvedModelId, resolvedModelParameters, subagentIdToResume, subagentId, isResume: subagentIdToResume !== undefined, parentRequestId, rootParentRequestId, subagentRequestId, isSelfForkRequested, effectiveEnvironment, effectiveTargetMachine, cloudSubagentBcId, cloudRequestedEnvironmentBuildId };
}

export interface PrepareTaskSubagentArgs {
  readonly resolved: TaskSubagentResolution;
  readonly ctx: Context;
  readonly rawArgs: TaskRawArguments;
  readonly meta: TaskResolutionMeta;
  readonly parentState: ConversationStateParent;
  readonly resourceAccessor: AttachmentResourceAccessor;
  readonly parentModelInfo: TaskResolutionModelInfo;
  readonly subagentCredentials?: SubagentCredentials["credentials"] | undefined;
  readonly enableExecuteHookExec?: boolean | undefined;
  readonly configuredSteps?: readonly string[] | undefined;
  readonly readonlyShellEnabled?: boolean | undefined;
  readonly toolName?: string | undefined;
  readonly parentCursorCommands?: readonly SelectedCursorCommand[] | undefined;
  readonly privacyMode?: PrivacyMode | undefined;
  readonly attachedMediaUrlProvider?: AttachedMediaUrlProvider | undefined;
  readonly geminiVideoAttachedMediaUrlProvider?: AttachedMediaUrlProvider | undefined;
  readonly inlineVideoMaxBytes?: number | undefined;
  readonly signedUrlVideoMaxBytes?: number | undefined;
}

export async function prepareTaskSubagent(args: PrepareTaskSubagentArgs): Promise<InstanceType<typeof PreparedTaskSubagent>> {
  const { resolved, ctx, rawArgs, meta, parentState, resourceAccessor, parentModelInfo } = args;
  const { subagentConfig, typeName, resolvedModelId, subagentIdToResume, subagentId, isResume, isSelfForkRequested, useAskModeForSubagent, effectiveReadonly, analyticsSubagentType, parentRequestId, rootParentRequestId, subagentRequestId, cloudSubagentBcId, cloudRequestedEnvironmentBuildId } = resolved;
  let selectedContext: SelectedContextValue | undefined;
  if (rawArgs.file_attachments !== undefined && rawArgs.file_attachments.length > 0) {
    const selectedMediaProvider = isGeminiVideoSubagentType(subagentConfig.subagent_type) ? args.geminiVideoAttachedMediaUrlProvider ?? args.attachedMediaUrlProvider : args.attachedMediaUrlProvider;
    selectedContext = await processAttachments(ctx, rawArgs.file_attachments, resourceAccessor, meta.toolCallId, {
      resolvedModelId,
      ...(args.privacyMode !== undefined ? { privacyMode: args.privacyMode } : {}),
      ...(selectedMediaProvider !== undefined ? { attachedMediaUrlProvider: selectedMediaProvider } : {}),
      ...(args.inlineVideoMaxBytes !== undefined ? { inlineVideoMaxBytes: args.inlineVideoMaxBytes } : {}),
      ...(args.signedUrlVideoMaxBytes !== undefined ? { signedUrlVideoMaxBytes: args.signedUrlVideoMaxBytes } : {}),
      subagentType: subagentConfig.subagent_type,
      useGeminiDeveloperVideoUpload: isGeminiVideoSubagentType(subagentConfig.subagent_type) && args.geminiVideoAttachedMediaUrlProvider !== undefined,
      skipTrustedPathValidation: true,
    });
  }
  if (args.parentCursorCommands !== undefined && args.parentCursorCommands.length > 0) {
    selectedContext = selectedContext ?? new SelectedContext();
    selectedContext.cursorCommands = [...args.parentCursorCommands];
  }
  const initialAction = createUserMessageAction(subagentConfig, rawArgs.prompt, generateSeededUuid(meta.toolCallId), useAskModeForSubagent, selectedContext);
  const conversationState = await resolveSubagentConversationState(ctx, subagentConfig, parentState, subagentIdToResume, isSelfForkRequested, meta.toolCallId, typeName);
  const shouldPersistSubagentCredentials = resolved.effectiveEnvironment !== SubagentExecutionEnvironment.CLOUD;
  return new PreparedTaskSubagent({
    subagentId,
    subagentTypeName: typeName,
    subagentType: subagentConfig.subagent_type,
    analyticsSubagentType,
    resolvedModelId,
    effectiveReadonly,
    useAskModeForSubagent,
    conversationState,
    initialAction,
    initialTurnsCount: conversationState.turns.length,
    subagentRequestId,
    ...(cloudSubagentBcId !== undefined ? { cloudSubagentBcId } : {}),
    toolCallId: meta.toolCallId,
    isResume,
    ...(parentRequestId !== undefined ? { parentRequestId } : {}),
    ...(rootParentRequestId !== undefined ? { rootParentRequestId } : {}),
    taskPrompt: rawArgs.prompt,
    taskDescription: rawArgs.description ?? "",
    ...(selectedContext !== undefined ? { selectedContext } : {}),
    ...(subagentConfig.plugin !== undefined ? { plugin: subagentConfig.plugin } : {}),
    ...(subagentConfig.marketplace !== undefined ? { marketplace: subagentConfig.marketplace } : {}),
    ...(subagentConfig.pluginId !== undefined ? { pluginId: subagentConfig.pluginId } : {}),
    ...(subagentConfig.marketplaceId !== undefined ? { marketplaceId: subagentConfig.marketplaceId } : {}),
    ...(subagentConfig.subagentSource !== undefined ? { subagentSource: subagentConfig.subagentSource } : {}),
    rawArgs: new TaskToolCallArgsProto({
      description: rawArgs.description ?? "",
      prompt: rawArgs.prompt,
      ...(rawArgs.model !== undefined ? { model: rawArgs.model } : {}),
      subagentType: rawArgs.subagent_type ?? typeName,
      ...(rawArgs.resume !== undefined ? { resume: rawArgs.resume } : {}),
      ...(rawArgs.run_in_background !== undefined ? { runInBackground: rawArgs.run_in_background } : {}),
      attachments: rawArgs.file_attachments === undefined ? [] : [...rawArgs.file_attachments],
      environment: resolved.effectiveEnvironment,
      ...((rawArgs.cloud_base_branch ?? (resolved.effectiveTargetMachine.type === "new_cloud_vm" ? resolved.effectiveTargetMachine.base_branch : undefined)) !== undefined ? { cloudBaseBranch: rawArgs.cloud_base_branch ?? (resolved.effectiveTargetMachine.type === "new_cloud_vm" ? resolved.effectiveTargetMachine.base_branch : "") } : {}),
      ...(cloudRequestedEnvironmentBuildId !== undefined ? { cloudRequestedEnvironmentBuildId } : {}),
      machine: targetMachineToProto(resolved.effectiveTargetMachine),
    }),
    parentModelName: parentModelInfo.modelName,
    ...(args.subagentCredentials !== undefined && shouldPersistSubagentCredentials ? { subagentCredentials: new SubagentCredentials({ credentials: args.subagentCredentials }) } : {}),
    ...(subagentConfig.resultSuffix !== undefined ? { resultSuffix: subagentConfig.resultSuffix } : {}),
    enableExecuteHookExec: args.enableExecuteHookExec ?? false,
    configuredSteps: args.configuredSteps === undefined ? [] : [...args.configuredSteps],
    readonlyShellEnabled: args.readonlyShellEnabled ?? false,
    toolName: args.toolName ?? "Task",
    preparedTimestampUnixMs: BigInt(Date.now()),
  });
}

export function buildPreparedTaskToolHookInput(prepared: InstanceType<typeof PreparedTaskSubagent>): {
  readonly description: string | undefined;
  readonly prompt: string | undefined;
  readonly model: string | undefined;
  readonly resume: string | undefined;
  readonly environment: TaskEnvironment;
  readonly cloud_base_branch: string | undefined;
  readonly cloud_requested_environment_build_id: string | undefined;
  readonly machine: TaskTargetMachine | undefined;
  readonly subagent_type: string;
  readonly run_in_background: boolean | undefined;
  readonly file_attachments: readonly string[] | undefined;
} {
  const raw = prepared.rawArgs;
  if (raw === undefined) {
    return {
      description: undefined,
      prompt: undefined,
      model: undefined,
      resume: undefined,
      environment: undefined,
      cloud_base_branch: undefined,
      cloud_requested_environment_build_id: undefined,
      machine: undefined,
      subagent_type: prepared.subagentTypeName,
      run_in_background: undefined,
      file_attachments: undefined,
    };
  }
  return {
    description: raw.description,
    prompt: raw.prompt,
    model: raw.model,
    resume: raw.resume,
    environment: protoEnvironmentToTaskEnvironment(raw.environment),
    cloud_base_branch: raw.cloudBaseBranch,
    cloud_requested_environment_build_id: raw.cloudRequestedEnvironmentBuildId,
    machine: targetMachineFromProto(raw.machine),
    subagent_type: prepared.subagentTypeName,
    run_in_background: raw.runInBackground,
    file_attachments: raw.attachments.length > 0 ? raw.attachments : undefined,
  };
}

async function processAttachments(
  ctx: Context,
  attachmentPaths: readonly string[],
  resourceAccessor: AttachmentResourceAccessor,
  toolCallId: string,
  options?: AttachmentProcessingOptions,
): Promise<SelectedContextValue | undefined> {
  if (attachmentPaths.length === 0) {
    return undefined;
  }
  const hasVideoAttachment = attachmentPaths.some(
    (attachmentPath) => getPotentialVideoMimeTypeFromPath(attachmentPath) !== undefined,
  );
  const requestContext =
    options?.skipTrustedPathValidation === true || !hasVideoAttachment
      ? undefined
      : await getRequestContextForAttachmentValidation({ ctx, resourceAccessor });
  const readExecutor = resourceAccessor.get(readExecutorResource);
  const selectedImages: InstanceType<typeof SelectedImage>[] = [];
  const selectedVideos: InstanceType<typeof SelectedVideo>[] = [];
  for (const rawFilePath of attachmentPaths) {
    const filePath =
      requestContext !== undefined &&
      getPotentialVideoMimeTypeFromPath(rawFilePath) !== undefined
        ? resolveTrustedAttachmentPath({
            attachmentPath: rawFilePath,
            requestContext,
          })
        : rawFilePath;
    if (filePath === undefined) {
      throw untrustedAttachmentPathError(rawFilePath);
    }
    const execResult = await readExecutor.execute(
      ctx,
      new ReadArgs({ path: filePath, toolCallId }),
      { execId: generateSeededUuid(`${toolCallId}:${filePath}`) },
    );
    if (execResult.result.case !== "success") {
      throw new Error(`Failed to read attachment: ${filePath}`);
    }
    const output = execResult.result.value.output;
    if (output.case !== "data") {
      throw new Error(`Attachment is not binary data: ${filePath}`);
    }
    const binaryData = output.value;
    const detectedImageMime = detectImageMimeType(binaryData, filePath);
    const videoMime = getPotentialVideoMimeTypeFromPath(filePath);
    const lookupMime = mimeTypes.lookup(filePath);
    const mimeType =
      detectedImageMime ??
      videoMime ??
      (typeof lookupMime === "string" ? lookupMime : undefined);
    if (!mimeType) {
      throw new Error(`Could not detect mime type for attachment: ${filePath}`);
    }
    const outputBlobId = execResult.result.value.outputBlobId;
    const imageDataOrBlobId: SelectedImage["dataOrBlobId"] =
      outputBlobId !== undefined && outputBlobId.length > 0
        ? {
            case: "blobIdWithData",
            value: new SelectedImage_BlobIdWithData({
              blobId: new Uint8Array(outputBlobId),
              data: new Uint8Array(binaryData),
            }),
          }
        : { case: "data", value: new Uint8Array(binaryData) };
    const videoDataOrBlobId: SelectedVideo["dataOrBlobId"] =
      outputBlobId !== undefined && outputBlobId.length > 0
        ? {
            case: "blobIdWithData",
            value: new SelectedVideo_BlobIdWithData({
              blobId: new Uint8Array(outputBlobId),
              data: new Uint8Array(binaryData),
            }),
          }
        : { case: "data", value: new Uint8Array(binaryData) };
    if (mimeType.startsWith("video/")) {
      const resolvedModelId = options?.resolvedModelId?.trim();
      if (
        resolvedModelId !== undefined &&
        resolvedModelId.length > 0 &&
        !isGeminiModelId(resolvedModelId)
      ) {
        throw new Error("Video attachments are only supported for Gemini models");
      }
      const useSignedUrl =
        options?.privacyMode !== undefined &&
        isSignedUrlStorageAllowed(options.privacyMode) &&
        options.attachedMediaUrlProvider !== undefined;
      const maxVideoBytes = useSignedUrl
        ? options?.useGeminiDeveloperVideoUpload === true &&
          isGeminiVideoSubagentType(options.subagentType)
          ? GEMINI_VIDEO_SUBAGENT_MAX_BYTES
          : options?.signedUrlVideoMaxBytes ?? getSignedUrlVideoMaxBytes({})
        : options?.inlineVideoMaxBytes ?? getInlineVideoMaxBytes({});
      if (binaryData.length > maxVideoBytes) {
        throw new Error(
          `Video exceeds maximum size of ${maxVideoBytes} bytes (${Math.round(maxVideoBytes / 1024 / 1024)}MB)`,
        );
      }
      if (useSignedUrl) {
        const conversationId = options.conversationId ?? "";
        const signedUrls = await options.attachedMediaUrlProvider.getSignedUrlForAttachedMedia(
          ctx,
          {
            conversationId,
            mimeType,
            contentLengthBytes: binaryData.length,
          },
        );
        await uploadAttachedMediaToSignedUrl({
          putUrl: signedUrls.putUrl,
          data: new Uint8Array(binaryData),
          mimeType,
          signal: ctx.signal,
        });
        selectedVideos.push(
          new SelectedVideo({
            dataOrBlobId: {
              case: "signedUrl",
              value: new SelectedVideo_SignedUrl({
                url: signedUrls.getUrl,
                key: signedUrls.key,
                expiresAtUnixMs: signedUrls.expiresAtUnixMs,
                refreshAfterUnixMs: signedUrls.refreshAfterUnixMs,
                conversationId,
              }),
            },
            uuid: generateSeededUuid(`video-${filePath}`),
            path: filePath,
            mimeType,
            fps: 4,
          }),
        );
      } else {
        selectedVideos.push(
          new SelectedVideo({
            dataOrBlobId: videoDataOrBlobId,
            uuid: generateSeededUuid(`video-${filePath}`),
            path: filePath,
            mimeType,
            fps: 4,
          }),
        );
      }
    } else if (mimeType.startsWith("image/")) {
      selectedImages.push(
        new SelectedImage({
          dataOrBlobId: imageDataOrBlobId,
          uuid: generateSeededUuid(`image-${filePath}`),
          path: filePath,
          mimeType,
        }),
      );
    } else {
      throw new Error(
        `Attachment must be image/* or video/*; got ${mimeType} for ${filePath}`,
      );
    }
  }
  if (selectedImages.length === 0 && selectedVideos.length === 0) {
    return undefined;
  }
  return new SelectedContext({ selectedImages, selectedVideos });
}
