export const SAND_INFERENCE_PROVIDERS = ["cursor", "claude-code", "codex", "openrouter"] as const;
export type SandInferenceProvider = (typeof SAND_INFERENCE_PROVIDERS)[number];

export interface SandInferenceRouterUsageProvider {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly lastUsedAt: string | null;
}

export interface SandInferenceRouterUsage {
  readonly schemaVersion: 1;
  readonly providers: Record<SandInferenceProvider, SandInferenceRouterUsageProvider>;
}

export function isSandInferenceProvider(value: unknown): value is SandInferenceProvider {
  return typeof value === "string" && (SAND_INFERENCE_PROVIDERS as readonly string[]).includes(value);
}

/** OpenRouter slug: `vendor/model` or `vendor/model:free`. */
export function parseOpenRouterModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(trimmed) ? trimmed : null;
}

/** Settings Save is the source of truth; env is only a fallback when nothing is stored. */
export function resolveOpenRouterModelId(input: {
  readonly explicit?: unknown;
  readonly stored?: unknown;
  readonly env?: unknown;
}): string | null {
  return parseOpenRouterModelId(input.explicit) ?? parseOpenRouterModelId(input.stored) ?? parseOpenRouterModelId(input.env);
}

export function emptySandInferenceRouterUsage(): SandInferenceRouterUsage {
  const empty = (): SandInferenceRouterUsageProvider => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lastUsedAt: null });
  return { schemaVersion: 1, providers: { cursor: empty(), "claude-code": empty(), codex: empty(), openrouter: empty() } };
}
