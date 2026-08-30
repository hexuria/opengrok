export interface GptModelInfo {
  readonly isGpt5?: boolean | undefined;
  readonly isGpt5Family?: boolean | undefined;
  readonly isGpt51?: boolean | undefined;
  readonly isGpt52?: boolean | undefined;
  readonly isGpt54?: boolean | undefined;
  readonly isGpt55?: boolean | undefined;
  readonly isGpt56?: boolean | undefined;
  readonly isGpt52Codex?: boolean | undefined;
  readonly isGpt53Codex?: boolean | undefined;
  readonly isGpt53CodexSpark?: boolean | undefined;
}

export function usesGptPersistenceInstructions(modelInfo: GptModelInfo | null | undefined): boolean {
  return modelInfo?.isGpt5 === true ||
    modelInfo?.isGpt5Family === true ||
    modelInfo?.isGpt51 === true ||
    modelInfo?.isGpt52 === true ||
    modelInfo?.isGpt54 === true ||
    modelInfo?.isGpt55 === true ||
    modelInfo?.isGpt56 === true ||
    modelInfo?.isGpt52Codex === true ||
    modelInfo?.isGpt53Codex === true ||
    modelInfo?.isGpt53CodexSpark === true;
}
