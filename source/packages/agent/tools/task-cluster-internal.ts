import {
  CloudSubagentReference,
  AgentMode,
  ConversationStep,
  ConversationStateStructure,
  ConversationTurnStructure,
  ConversationAction,
  UserMessage,
  UserMessageAction,
  NewCloudVmTarget,
  SameMachineTarget,
  SelfHostedPoolTarget,
  SelfHostedWorkerLabel,
  SelfHostedWorkerTarget,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
  TargetMachine,
} from "../../proto/generated/agent/v1/agent_pb.js";
import type { SelectedContext } from "../../proto/generated/agent/v1/selected_context_pb.js";
import type { Context } from "../../context/core.js";
import { CustomSubagentPermissionMode } from "../../proto/generated/agent/v1/subagents_pb.js";
import { ToolCallArgParseError } from "./common.js";
import {
  canonicalSubagentComposerSlug,
  isComposerSubagentDefaultId,
  orderedExploreSubagentComposerIds,
  resolveTaskArgToSubagentComposerSlug,
} from "./composer-subagent-resolution.js";
import { tryResolveForcedSubagentModel } from "./subagent-forced-model-resolution.js";
import { SubagentModelForcePolicy } from "./subagent-model-force-policy.js";
import { getSubagentTypeName } from "./core/subagent/subagent-config.js";
import type { SubagentModels } from "./core/subagent/models.js";

/** The retained Task runtime uses these values before they are encoded in proto enums. */
export type TaskEnvironment = "cloud" | "local" | undefined;

export type TaskTargetMachine =
  | { readonly type: "same_machine" }
  | {
      readonly type: "new_cloud_vm";
      readonly base_branch?: string;
      readonly environment_build_id?: string;
    }
  | { readonly type: "self_hosted_worker"; readonly worker_id: string }
  | {
      readonly type: "self_hosted_pool";
      readonly pool?: string;
      readonly labels?: Readonly<Record<string, string>>;
    };

export type LegacyTaskTargetArgs = {
  readonly environment?: TaskEnvironment | undefined;
  readonly cloud_base_branch?: string | undefined;
  readonly cloud_requested_environment_build_id?: string | undefined;
};

export type TaskTargetValidationArgs = LegacyTaskTargetArgs & {
  readonly machine?: TaskTargetMachine;
};

export interface TaskSubagentConfigRuntime {
  readonly permissionMode: number;
  readonly computeAllowedWritePaths?: unknown;
  readonly systemReminder?: (() => string) | undefined;
  readonly resumeModeOverride?: "DEFAULT" | "LAST_AGENT" | "LAST_AGENT_SAME_TYPE" | undefined;
  readonly subagentSource?: string | undefined;
  readonly plugin?: string | undefined;
  readonly marketplace?: string | undefined;
  readonly pluginId?: string | undefined;
  readonly marketplaceId?: string | undefined;
  readonly resultSuffix?: string | undefined;
  readonly userRequestedModelId?: string | undefined;
  readonly forceDefaultModel?: boolean | undefined;
  readonly inheritParentModel?: boolean | undefined;
  readonly defaultModelIds?: readonly string[] | undefined;
  readonly isBackground?: boolean | undefined;
  readonly conversationStateMapper?: ((callerState: ConversationStateStructure) => ConversationStateStructure) | undefined;
}

export interface TaskSubagentModelConfig extends TaskSubagentConfigRuntime {
  readonly userRequestedModelId?: string;
  readonly forceDefaultModel?: boolean;
  readonly subagent_type: Parameters<typeof getSubagentTypeName>[0];
  readonly defaultModelIds?: readonly string[];
  readonly inheritParentModel?: boolean;
}

export interface ResolveSubagentModelArgs {
  readonly subagentConfig: TaskSubagentModelConfig;
  readonly requestedModel?: string | undefined;
  readonly parentModelId: string;
  readonly enableExploreParentModelInheritance?: boolean | undefined;
  readonly forceModelId?: string | undefined;
  readonly subagentModelForcePolicy: (typeof SubagentModelForcePolicy)[keyof typeof SubagentModelForcePolicy];
  readonly parentMaxMode: boolean;
  readonly subagentModels: SubagentModels;
  readonly isModelBlocked: (modelId: string) => boolean;
  readonly isModelValid?: ((modelId: string) => boolean) | undefined;
  readonly compareModelCosts: (candidateModelId: string, parentModelId: string) => number;
  readonly requiresMaxMode?: ((modelId: string) => Promise<boolean>) | undefined;
}

export async function resolveSubagentModel(
  args: ResolveSubagentModelArgs,
): Promise<string> {
  const {
    subagentConfig,
    requestedModel,
    parentModelId,
    enableExploreParentModelInheritance = false,
    forceModelId,
    subagentModelForcePolicy,
    parentMaxMode,
    subagentModels,
    isModelBlocked,
    isModelValid = () => true,
    compareModelCosts,
    requiresMaxMode,
  } = args;
  const userRequestedModelId = subagentConfig.userRequestedModelId;
  const forceDefaultModel = subagentConfig.forceDefaultModel === true;
  const isExploreSubagent = getSubagentTypeName(subagentConfig.subagent_type) === "explore";
  const allowedModelSlugs = [...subagentModels.modelsBySlug.keys()].sort();
  const allowedModelSlugList =
    allowedModelSlugs.length > 0 ? allowedModelSlugs.map((slug) => `- ${slug}`).join("\n") : "- (none)";
  const invalidRequestedModelError = (requestedModelValue: string, reason?: string) =>
    `Invalid model selection "${requestedModelValue}". ${reason ?? "Model could not be resolved to a valid subagent model."}\nAllowed model slugs:\n${allowedModelSlugList}\n\nThe \`model\` parameter is optional. If omitted, the subagent uses the same model as the parent agent.`;
  const noUsableModelError = () =>
    `No usable model is available for this subagent. The parent model "${parentModelId}" is blocked or unavailable, and no configured subagent default can be used.\nAllowed model slugs:\n${allowedModelSlugList}\n\nChoose a supported model with the \`model\` parameter or omit this subagent call.`;
  const parentIsGenericbaseModel = parentModelId.toLowerCase().startsWith("genericbase-");
  const parentIsAutoModel = ["default", "premium", "auto-low", "auto-medium", "auto-high"].includes(parentModelId.toLowerCase());
  const configuredDefaultModelIds = new Set((subagentConfig.defaultModelIds ?? []).map(canonicalSubagentComposerSlug));
  const isMaxModeCompatible = async (modelId: string) =>
    requiresMaxMode === undefined || parentMaxMode || !(await requiresMaxMode(modelId));
  let parentModelUsable: Promise<boolean> | undefined;
  const isParentModelUsable = () =>
    (parentModelUsable ??= (async () => !isModelBlocked(parentModelId) && await isMaxModeCompatible(parentModelId))());
  const logCandidate = (candidateModelId: string): string => {
    const canonicalCandidateModelId = canonicalSubagentComposerSlug(candidateModelId);
    const preserveGenericbase = parentIsGenericbaseModel &&
      (isComposerSubagentDefaultId(canonicalCandidateModelId) || configuredDefaultModelIds.has(canonicalCandidateModelId));
    return preserveGenericbase ? parentModelId : candidateModelId;
  };
  if (parentIsAutoModel && userRequestedModelId === undefined && requestedModel === undefined &&
      (subagentConfig.defaultModelIds?.length ?? 0) === 0 && await isParentModelUsable()) {
    return parentModelId;
  }
  const forcedModelId = await tryResolveForcedSubagentModel({
    subagentModelForcePolicy,
    forceModelId,
    userRequestedModelId,
    isModelBlocked,
    isModelValid,
    isMaxModeCompatible,
    logForcedModel: ({ candidateModelId }) => logCandidate(candidateModelId),
  });
  if (forcedModelId !== undefined) return forcedModelId;
  if (subagentModelForcePolicy === SubagentModelForcePolicy.ParentPin && forceModelId !== undefined) {
    throw new ToolCallArgParseError(noUsableModelError());
  }
  const requestedModelIsInherit = requestedModel?.trim().toLowerCase() === "inherit";
  let resolvedRequestedModelId: string | undefined;
  if (requestedModel !== undefined && !requestedModelIsInherit) {
    const trimmed = requestedModel.trim();
    if (trimmed.length === 0) {
      throw new ToolCallArgParseError(invalidRequestedModelError(requestedModel, "Model must be a non-empty string when provided."));
    }
    const matchesParent = !parentIsAutoModel && trimmed === parentModelId;
    const requestedId = matchesParent ? parentModelId : resolveTaskArgToSubagentComposerSlug(trimmed, subagentModels.modelsBySlug);
    const usable = requestedId !== undefined && (matchesParent || isModelValid(requestedId)) && !isModelBlocked(requestedId) && await isMaxModeCompatible(requestedId);
    if (!usable && trimmed.toLowerCase() !== "fast") {
      throw new ToolCallArgParseError(invalidRequestedModelError(trimmed));
    }
    if (usable) resolvedRequestedModelId = requestedId;
  }
  if (requestedModel !== undefined && resolvedRequestedModelId !== undefined && !forceDefaultModel) {
    return logCandidate(resolvedRequestedModelId);
  }
  if (subagentConfig.inheritParentModel === true && await isParentModelUsable()) return parentModelId;
  if (userRequestedModelId !== undefined && !isModelBlocked(userRequestedModelId) && await isMaxModeCompatible(userRequestedModelId)) {
    if (isModelValid(userRequestedModelId)) return logCandidate(userRequestedModelId);
    if (await isParentModelUsable()) return parentModelId;
  }
  if (enableExploreParentModelInheritance && isExploreSubagent && !isComposerSubagentDefaultId(parentModelId) &&
      subagentModels.modelsBySlug.has(parentModelId) && !isModelBlocked(parentModelId) && isModelValid(parentModelId) && await isMaxModeCompatible(parentModelId)) {
    return parentModelId;
  }
  if (subagentConfig.defaultModelIds !== undefined && subagentConfig.defaultModelIds.length > 0) {
    const defaultCandidates = isExploreSubagent && subagentConfig.defaultModelIds.length > 1
      ? orderedExploreSubagentComposerIds([...subagentConfig.defaultModelIds], parentModelId, compareModelCosts)
      : subagentConfig.defaultModelIds;
    for (const modelId of defaultCandidates) {
      if (isExploreSubagent && compareModelCosts(modelId, parentModelId) > 0) continue;
      if (isModelValid(modelId) && !isModelBlocked(modelId) && await isMaxModeCompatible(modelId)) return logCandidate(modelId);
    }
  }
  if (await isParentModelUsable()) return parentModelId;
  throw new ToolCallArgParseError(noUsableModelError());
}

export function getEffectiveReadonlyForSubagent(
  subagentConfig: TaskSubagentConfigRuntime,
): boolean {
  return subagentConfig.permissionMode === CustomSubagentPermissionMode.READONLY;
}

export function shouldUseAskModeForSubagent(
  effectiveReadonly: boolean,
  subagentConfig: TaskSubagentConfigRuntime,
): boolean {
  return effectiveReadonly && !subagentConfig.computeAllowedWritePaths;
}

export function createUserMessageAction(
  subagentConfig: TaskSubagentConfigRuntime,
  prompt: string,
  messageId: string,
  useAskMode: boolean,
  selectedContext: SelectedContext | undefined,
): ConversationAction {
  const reminderGenerator = subagentConfig.systemReminder;
  const staticSystemReminder =
    reminderGenerator !== undefined && reminderGenerator.length === 0
      ? reminderGenerator()
      : undefined;
  const userMessage = new UserMessage({
    text: prompt,
    messageId,
    mode: useAskMode ? AgentMode.ASK : AgentMode.AGENT,
    ...(selectedContext !== undefined ? { selectedContext } : {}),
    ...(staticSystemReminder !== undefined && staticSystemReminder !== ""
      ? { subagentSystemReminder: staticSystemReminder }
      : {}),
  });
  return new ConversationAction({
    action: {
      case: "userMessageAction",
      value: new UserMessageAction({ userMessage }),
    },
  });
}

export interface ConversationBlobStore {
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>;
}

export async function extractLastAssistantMessage(
  ctx: Context,
  newTurns: readonly Uint8Array[],
  blobStore: ConversationBlobStore,
): Promise<string | undefined> {
  for (let index = newTurns.length - 1; index >= 0; index -= 1) {
    const turnBlob = await blobStore.getBlob(ctx, newTurns[index]!);
    if (turnBlob === undefined) {
      continue;
    }
    const turnStructure = ConversationTurnStructure.fromBinary(turnBlob);
    if (turnStructure.turn.case !== "agentConversationTurn") {
      continue;
    }
    const steps = await collectConversationStepsFromStepBlobIds({
      ctx,
      stepBlobIds: turnStructure.turn.value.steps,
      blobStore,
    });
    for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
      const step = steps[stepIndex]!;
      if (step.message.case === "assistantMessage") {
        return step.message.value.text;
      }
    }
  }
  return undefined;
}

export async function collectConversationStepsFromStepBlobIds(args: {
  readonly ctx: Context;
  readonly stepBlobIds: readonly Uint8Array[];
  readonly blobStore: ConversationBlobStore;
}): Promise<ConversationStep[]> {
  const stepBlobs = await Promise.all(
    args.stepBlobIds.map((stepBlobId) => args.blobStore.getBlob(args.ctx, stepBlobId)),
  );
  return stepBlobs
    .filter((stepBlob): stepBlob is Uint8Array => stepBlob !== undefined)
    .map((stepBlob) => ConversationStep.fromBinary(stepBlob));
}

export async function collectConversationTurnStructures(args: {
  readonly ctx: Context;
  readonly turns: readonly Uint8Array[];
  readonly blobStore: ConversationBlobStore;
}): Promise<Array<ConversationTurnStructure | undefined>> {
  const turnBlobs = await Promise.all(
    args.turns.map((turnBlobId) => args.blobStore.getBlob(args.ctx, turnBlobId)),
  );
  return turnBlobs.map((turnBlob) =>
    turnBlob === undefined ? undefined : ConversationTurnStructure.fromBinary(turnBlob),
  );
}

export async function collectConversationStepsWithToolCallCount(
  ctx: Context,
  turns: readonly Uint8Array[],
  blobStore: ConversationBlobStore,
): Promise<{ readonly conversationSteps: ConversationStep[]; readonly toolCallCount: number }> {
  const turnStructures = await collectConversationTurnStructures({ ctx, turns, blobStore });
  const stepsByTurn = await Promise.all(
    turnStructures.map((turnStructure) =>
      turnStructure?.turn.case === "agentConversationTurn"
        ? collectConversationStepsFromStepBlobIds({
            ctx,
            stepBlobIds: turnStructure.turn.value.steps,
            blobStore,
          })
        : [],
    ),
  );
  const conversationSteps = stepsByTurn.flat();
  return {
    conversationSteps,
    toolCallCount: conversationSteps.filter((step) => step.message.case === "toolCall").length,
  };
}

export async function countToolCallsFromTurns(
  ctx: Context,
  turns: readonly Uint8Array[],
  blobStore: ConversationBlobStore,
): Promise<number> {
  const result = await collectConversationStepsWithToolCallCount(ctx, turns, blobStore);
  return result.toolCallCount;
}

export function taskEnvironmentToProto(
  environment: TaskEnvironment,
): SubagentExecutionEnvironment {
  switch (environment) {
    case "cloud":
      return SubagentExecutionEnvironment.CLOUD;
    case "local":
      return SubagentExecutionEnvironment.LOCAL;
    default:
      return SubagentExecutionEnvironment.UNSPECIFIED;
  }
}

export function targetMachineToEnvironment(
  target: TaskTargetMachine,
): SubagentExecutionEnvironment {
  return target.type === "same_machine"
    ? SubagentExecutionEnvironment.LOCAL
    : SubagentExecutionEnvironment.CLOUD;
}

export type ClientSubagentPlacement = {
  readonly environment: SubagentExecutionEnvironment;
  readonly cloudBaseBranch: string | undefined;
};

export function toClientSubagentPlacement(
  target: TaskTargetMachine,
): ClientSubagentPlacement {
  switch (target.type) {
    case "same_machine":
      return {
        environment: SubagentExecutionEnvironment.LOCAL,
        cloudBaseBranch: undefined,
      };
    case "new_cloud_vm":
      return {
        environment: SubagentExecutionEnvironment.CLOUD,
        cloudBaseBranch: target.base_branch,
      };
    case "self_hosted_worker":
    case "self_hosted_pool":
      throw new ToolCallArgParseError(
        "Invalid arguments:\nSelf-hosted machine placement requires server-side first-class subagent execution and is not supported by a fresh client-executed Task.",
      );
  }
}

export function targetMachineFromLegacyArgs(
  args: LegacyTaskTargetArgs,
): TaskTargetMachine {
  if (args.environment !== "cloud") {
    return { type: "same_machine" };
  }
  const baseBranch = args.cloud_base_branch?.trim();
  const buildId = args.cloud_requested_environment_build_id?.trim();
  return {
    type: "new_cloud_vm",
    ...(baseBranch !== undefined && baseBranch.length > 0
      ? { base_branch: baseBranch }
      : {}),
    ...(buildId !== undefined && buildId.length > 0
      ? { environment_build_id: buildId }
      : {}),
  };
}

export function targetMachineToProto(target: TaskTargetMachine): TargetMachine {
  switch (target.type) {
    case "same_machine":
      return new TargetMachine({
        machine: {
          case: "sameMachine",
          value: new SameMachineTarget(),
        },
      });
    case "new_cloud_vm":
      return new TargetMachine({
        machine: {
          case: "newCloudVm",
          value: new NewCloudVmTarget({
            ...(target.environment_build_id !== undefined
              ? { environmentBuildId: target.environment_build_id }
              : {}),
            ...(target.base_branch !== undefined
              ? { baseBranch: target.base_branch }
              : {}),
          }),
        },
      });
    case "self_hosted_worker":
      return new TargetMachine({
        machine: {
          case: "selfHostedWorker",
          value: new SelfHostedWorkerTarget({ workerId: target.worker_id }),
        },
      });
    case "self_hosted_pool":
      return new TargetMachine({
        machine: {
          case: "selfHostedPool",
          value: new SelfHostedPoolTarget({
            ...(target.pool !== undefined ? { pool: target.pool } : {}),
            labels: Object.entries(target.labels ?? {}).map(
              ([key, value]) => new SelfHostedWorkerLabel({ key, value }),
            ),
          }),
        },
      });
  }
}

export function targetMachineFromProto(
  proto: TargetMachine | undefined,
): TaskTargetMachine | undefined {
  switch (proto?.machine.case) {
    case "sameMachine":
      return { type: "same_machine" };
    case "newCloudVm":
      return {
        type: "new_cloud_vm",
        ...(proto.machine.value.environmentBuildId !== undefined
          ? { environment_build_id: proto.machine.value.environmentBuildId }
          : {}),
        ...(proto.machine.value.baseBranch !== undefined
          ? { base_branch: proto.machine.value.baseBranch }
          : {}),
      };
    case "selfHostedWorker":
      return {
        type: "self_hosted_worker",
        worker_id: proto.machine.value.workerId,
      };
    case "selfHostedPool":
      return {
        type: "self_hosted_pool",
        ...(proto.machine.value.pool !== undefined
          ? { pool: proto.machine.value.pool }
          : {}),
        ...(proto.machine.value.labels.length > 0
          ? {
              labels: Object.fromEntries(
                proto.machine.value.labels.map((label) => [label.key, label.value]),
              ),
            }
          : {}),
      };
    default:
      return undefined;
  }
}

export type CloudSubagentPersistedStateArgs = {
  readonly bcId: string;
  readonly transcriptPath?: string;
  readonly modelId?: string;
  readonly machine: TaskTargetMachine;
};

export function buildCloudSubagentPersistedState(
  args: CloudSubagentPersistedStateArgs,
): SubagentPersistedState {
  return new SubagentPersistedState({
    environment: SubagentExecutionEnvironment.CLOUD,
    cloudSubagent: new CloudSubagentReference({
      bcId: args.bcId,
      ...(args.transcriptPath !== undefined
        ? { transcriptPath: args.transcriptPath }
        : {}),
    }),
    ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
    machine: targetMachineToProto(args.machine),
  });
}

export function assertMachineAndLegacyArgsNotBothSet(
  args: TaskTargetValidationArgs,
): void {
  if (args.machine === undefined) {
    return;
  }
  const conflictingKeys: readonly (keyof LegacyTaskTargetArgs)[] = [
    "environment",
    "cloud_base_branch",
    "cloud_requested_environment_build_id",
  ];
  const conflicting = conflictingKeys.filter((key) => args[key] !== undefined);
  if (conflicting.length > 0) {
    throw new ToolCallArgParseError(
      `Invalid arguments:\nmachine replaces ${conflicting.join(", ")}; specify machine alone.`,
    );
  }
}

export function assertCloudOnlyTaskArgsAllowed(
  args: LegacyTaskTargetArgs,
): void {
  const hasCloudBaseBranch =
    args.cloud_base_branch !== undefined && args.cloud_base_branch.trim().length > 0;
  if (hasCloudBaseBranch && args.environment !== "cloud") {
    throw new ToolCallArgParseError(
      "Invalid arguments:\ncloud_base_branch may only be specified when environment equals cloud.",
    );
  }
  const hasRequestedBuild =
    args.cloud_requested_environment_build_id !== undefined &&
    args.cloud_requested_environment_build_id.trim().length > 0;
  if (hasRequestedBuild && args.environment !== "cloud") {
    throw new ToolCallArgParseError(
      "Invalid arguments:\ncloud_requested_environment_build_id may only be specified when environment equals cloud.",
    );
  }
}
