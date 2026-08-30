import { SubagentComposerModelId } from "./subagent-composer-model-ids.js";

type ModelDefinition = { readonly slug: string };

const LEGACY_SUBAGENT_COMPOSER_SLUG = "composer-1.5";
const BUILT_IN_COMPOSER_MODEL_ID_PATTERN = /^composer-\d+(?:\.\d+)?(?:-fast)?$/;

export function isBuiltInComposerSubagentSlug(modelId: string): boolean {
  return BUILT_IN_COMPOSER_MODEL_ID_PATTERN.test(canonicalSubagentComposerSlug(modelId));
}

export function canonicalSubagentComposerSlug(slug: string): string {
  return slug === LEGACY_SUBAGENT_COMPOSER_SLUG ? SubagentComposerModelId.standard : slug;
}

export function isComposerSubagentDefaultId(modelId: string): boolean {
  return BUILT_IN_COMPOSER_MODEL_ID_PATTERN.test(canonicalSubagentComposerSlug(modelId));
}

export function orderedExploreSubagentComposerIds(
  defaultModelIds: string[],
  parentModelId: string,
  compareModelCosts: (candidateModelId: string, parentModelId: string) => number,
): string[] {
  const [fastModelId, standardModelId, ...restModelIds] = defaultModelIds;
  if (fastModelId !== undefined && standardModelId !== undefined && compareModelCosts(fastModelId, parentModelId) > 0) {
    return [standardModelId, fastModelId, ...restModelIds];
  }
  return defaultModelIds;
}

export function taskArgSelectsFastComposerTier(alias: string): boolean {
  const t = alias.trim().toLowerCase();
  return t.endsWith("-fast");
}

export function shouldNormalizeTaskArgModelInput(modelsBySlug: ReadonlyMap<string, ModelDefinition>): boolean {
  return ![...modelsBySlug.keys()].some((slug) => slug !== slug.toLowerCase() || slug.includes("_"));
}

export function normalizeTaskArgModelInput(
  requestedModel: string,
  modelsBySlug: ReadonlyMap<string, ModelDefinition>,
): string {
  const trimmedRequestedModel = requestedModel.trim();
  if (!shouldNormalizeTaskArgModelInput(modelsBySlug)) {
    return trimmedRequestedModel;
  }
  return trimmedRequestedModel.toLowerCase().replaceAll("_", "-");
}

export function resolveTaskArgToSubagentComposerSlug(
  requestedModel: string,
  modelsBySlug: ReadonlyMap<string, ModelDefinition>,
): string | undefined {
  const normalizedRequestedModel = normalizeTaskArgModelInput(requestedModel, modelsBySlug);
  const mapped = modelsBySlug.get(normalizedRequestedModel)?.slug;
  if (mapped !== undefined) {
    return canonicalSubagentComposerSlug(mapped);
  }
  const t = normalizedRequestedModel.toLowerCase();
  if (taskArgSelectsFastComposerTier(normalizedRequestedModel)) {
    return SubagentComposerModelId.fast;
  }
  if (t === "default" || t === "auto") {
    return SubagentComposerModelId.standard;
  }
  return undefined;
}
