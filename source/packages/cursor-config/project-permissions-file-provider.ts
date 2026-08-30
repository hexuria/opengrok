import { parse, type ParseError } from "jsonc-parser";

export interface ParsedPermissionsAutoRunConfig {
  readonly allowInstructions: readonly string[] | undefined;
  readonly blockInstructions: readonly string[] | undefined;
}

export interface ProjectPermissionsFileConfig {
  readonly autoRun: ParsedPermissionsAutoRunConfig | undefined;
}

function filterStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function parsePermissionsAutoRunConfig(
  value: unknown,
): ParsedPermissionsAutoRunConfig | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const autoRun = value as Record<string, unknown>;
  return {
    allowInstructions: filterStrings(autoRun.allow_instructions),
    blockInstructions: filterStrings(autoRun.block_instructions),
  };
}

export function parseProjectPermissionsFileConfig(
  raw: string,
): ProjectPermissionsFileConfig | undefined {
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const config = parsed as Record<string, unknown>;
  const autoRunConfig = config.autoReview ?? config.autoRun;
  return {
    autoRun: parsePermissionsAutoRunConfig(autoRunConfig),
  };
}
