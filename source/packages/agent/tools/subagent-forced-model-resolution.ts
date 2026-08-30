import { isBuiltInComposerSubagentSlug } from "./composer-subagent-resolution.js";
import { SubagentModelForcePolicy } from "./subagent-model-force-policy.js";

type ForcePolicy = (typeof SubagentModelForcePolicy)[keyof typeof SubagentModelForcePolicy];
type ForcedModelLog = (args: {
  candidateModelId: string;
  modelResolutionReason: string;
  reasonDetails: Record<string, unknown>;
}) => string;

interface ResolvePinnedForceModelArgs {
  forceModelId?: string | undefined;
  subagentModelForcePolicy: ForcePolicy;
  isModelBlocked: (modelId: string) => boolean;
  isMaxModeCompatible: (modelId: string) => Promise<boolean>;
  logForcedModel: ForcedModelLog;
}

export async function resolvePinnedForceModelId(args: ResolvePinnedForceModelArgs): Promise<string | undefined> {
  const { forceModelId, subagentModelForcePolicy, isModelBlocked, isMaxModeCompatible, logForcedModel } = args;
  if (forceModelId !== undefined && !isModelBlocked(forceModelId) && await isMaxModeCompatible(forceModelId)) {
    return logForcedModel({
      candidateModelId: forceModelId,
      modelResolutionReason: "force_model",
      reasonDetails: { forceModelId, subagentModelForcePolicy },
    });
  }
  return undefined;
}

interface TryResolveForcedSubagentModelArgs extends ResolvePinnedForceModelArgs {
  userRequestedModelId?: string | undefined;
  isModelValid: (modelId: string) => boolean;
}

export async function tryResolveForcedSubagentModel(args: TryResolveForcedSubagentModelArgs): Promise<string | undefined> {
  const { subagentModelForcePolicy, forceModelId, userRequestedModelId, isModelBlocked, isModelValid, isMaxModeCompatible, logForcedModel } = args;
  switch (subagentModelForcePolicy) {
    case SubagentModelForcePolicy.RequestBasedComposer: {
      if (forceModelId === undefined) {
        return undefined;
      }
      const userSelectedForcedComposerModelId = userRequestedModelId !== undefined && isBuiltInComposerSubagentSlug(userRequestedModelId) && !isModelBlocked(userRequestedModelId) && isModelValid(userRequestedModelId) && await isMaxModeCompatible(userRequestedModelId) ? userRequestedModelId : undefined;
      if (userSelectedForcedComposerModelId !== undefined) {
        return logForcedModel({
          candidateModelId: userSelectedForcedComposerModelId,
          modelResolutionReason: "force_model_user_composer_selection",
          reasonDetails: {
            forceModelId,
            userSelectedForcedComposerModelId,
            subagentModelForcePolicy,
          },
        });
      }
      return resolvePinnedForceModelId({
        forceModelId,
        subagentModelForcePolicy,
        isModelBlocked,
        isMaxModeCompatible,
        logForcedModel,
      });
    }
    case SubagentModelForcePolicy.ParentPin:
      return resolvePinnedForceModelId({
        forceModelId,
        subagentModelForcePolicy,
        isModelBlocked,
        isMaxModeCompatible,
        logForcedModel,
      });
    case SubagentModelForcePolicy.None:
      return undefined;
    default: {
      const _exhaustive = subagentModelForcePolicy;
      throw new Error(`Unhandled subagent model force policy: ${String(_exhaustive)}`);
    }
  }
}
