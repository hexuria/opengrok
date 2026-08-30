export interface SandModelCatalogValue {
  readonly value: string;
  readonly displayName?: string;
}

export interface SandModelCatalogParameter {
  readonly id: string;
  readonly name?: string;
  readonly type: "boolean" | "enum";
  readonly values: readonly SandModelCatalogValue[];
}

export interface SandModelCatalogParameterValue {
  readonly id: string;
  readonly value: string;
}

export interface SandModelCatalogEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly aliases: readonly string[];
  readonly params: readonly SandModelCatalogParameter[];
  readonly variants: readonly (readonly SandModelCatalogParameterValue[])[];
}

export interface AvailableModelWire {
  readonly name: string;
  readonly clientDisplayName?: string | null;
  readonly idAliases: readonly string[];
  readonly parameterDefinitions: readonly {
    readonly id: string;
    readonly name: string;
    readonly parameterType?: {
      readonly booleanParameter?: {
        readonly values: readonly SandModelCatalogValue[];
      };
      readonly enumParameter?: {
        readonly values: readonly SandModelCatalogValue[];
      };
    };
  }[];
  readonly variants: readonly {
    readonly parameterValues: readonly SandModelCatalogParameterValue[];
  }[];
}

export function findCatalogEntry(
  catalog: readonly SandModelCatalogEntry[],
  modelId: string,
): SandModelCatalogEntry | undefined {
  const needle = modelId.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  return catalog.find(
    (entry) =>
      entry.id.toLowerCase() === needle ||
      entry.aliases.some((alias) => alias.toLowerCase() === needle),
  );
}

function variantMatchesRequested(
  variant: readonly SandModelCatalogParameterValue[],
  requested: readonly (readonly [string, string])[],
): boolean {
  const byId = new Map(variant.map((parameter) => [parameter.id, parameter.value]));
  return requested.every(([id, value]) => byId.get(id) === value);
}

export function validateParamCombination(
  entry: SandModelCatalogEntry,
  params: Readonly<Record<string, string>>,
): string | null {
  if (entry.variants.length === 0) return null;
  const requested = Object.entries(params);
  if (requested.length === 0) return null;
  if (entry.variants.some((variant) => variantMatchesRequested(variant, requested))) {
    return null;
  }
  const conflicting = requested
    .filter(([dropId]) => {
      const rest = requested.filter(([id]) => id !== dropId);
      return entry.variants.some((variant) => variantMatchesRequested(variant, rest));
    })
    .map(([id]) => id);
  const requestedString = requested
    .map(([id, value]) => `${id}=${value}`)
    .join(", ");
  const hint =
    conflicting.length > 1
      ? ` These parameters can't be combined on ${entry.id}: ${conflicting.join(", ")}.`
      : "";
  return (
    `{${requestedString}} is not a supported parameter combination for ${entry.id}.` +
    hint +
    ` Change one of the conflicting parameters and retry (for example, on some models a 1M context can't be combined with the fast tier).`
  );
}

export function validateModelParams(
  entry: SandModelCatalogEntry,
  params: Readonly<Record<string, string>>,
): string[] {
  const errors: string[] = [];
  for (const [id, value] of Object.entries(params)) {
    const definition = entry.params.find((parameter) => parameter.id === id);
    if (definition == null) {
      const allowedIds = entry.params.map((parameter) => parameter.id).join(", ");
      errors.push(
        `'${id}' is not a parameter of ${entry.id}.` +
          (allowedIds.length > 0
            ? ` Allowed parameters: ${allowedIds}.`
            : " This model takes no parameters."),
      );
      continue;
    }
    if (!definition.values.some((candidate) => candidate.value === value)) {
      const allowed = definition.values.map((candidate) => candidate.value).join(", ");
      errors.push(
        `'${value}' is not a valid value for '${id}' on ${entry.id}. Allowed: ${allowed}.`,
      );
    }
  }
  if (errors.length === 0) {
    const combinationError = validateParamCombination(entry, params);
    if (combinationError != null) errors.push(combinationError);
  }
  return errors;
}

export function describeParamIncompatibilities(
  entry: SandModelCatalogEntry,
): string[] {
  if (entry.variants.length === 0) return [];
  const present: SandModelCatalogParameterValue[] = [];
  const seen = new Set<string>();
  for (const variant of entry.variants) {
    for (const { id, value } of variant) {
      const key = `${id}=${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        present.push({ id, value });
      }
    }
  }
  const coOccurs = (
    a: SandModelCatalogParameterValue,
    b: SandModelCatalogParameterValue,
  ): boolean =>
    entry.variants.some((variant) => {
      const byId = new Map(variant.map((parameter) => [parameter.id, parameter.value]));
      return byId.get(a.id) === a.value && byId.get(b.id) === b.value;
    });
  const notes: string[] = [];
  for (const [index, a] of present.entries()) {
    for (const b of present.slice(index + 1)) {
      if (a.id !== b.id && !coOccurs(a, b)) {
        notes.push(`${a.id}=${a.value} cannot be combined with ${b.id}=${b.value}`);
      }
    }
  }
  return notes;
}

export function toSandModelCatalogEntry(model: AvailableModelWire): SandModelCatalogEntry {
  const params: SandModelCatalogParameter[] = [];
  for (const definition of model.parameterDefinitions) {
    const booleanDefinition = definition.parameterType?.booleanParameter;
    const enumDefinition = definition.parameterType?.enumParameter;
    const rawValues = booleanDefinition?.values ?? enumDefinition?.values ?? [];
    const values = rawValues.map((value) => ({
      value: value.value,
      ...(value.displayName != null && value.displayName.trim().length > 0
        ? { displayName: value.displayName.trim() }
        : {}),
    }));
    if (values.length === 0) continue;
    params.push({
      id: definition.id,
      ...(definition.name.trim().length > 0 ? { name: definition.name.trim() } : {}),
      type: booleanDefinition != null ? "boolean" : "enum",
      values,
    });
  }
  const variants = model.variants.map((variant) =>
    variant.parameterValues.map((parameter) => ({
      id: parameter.id,
      value: parameter.value,
    })),
  );
  return {
    id: model.name,
    ...(model.clientDisplayName != null && model.clientDisplayName.trim().length > 0
      ? { displayName: model.clientDisplayName.trim() }
      : {}),
    aliases: [...model.idAliases],
    params,
    variants,
  };
}

export function mapAvailableModels(
  models: readonly AvailableModelWire[],
): SandModelCatalogEntry[] {
  return models
    .filter((model) => model.name.trim().length > 0)
    .map(toSandModelCatalogEntry);
}
