export const SAND_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES = 20;
export const SAND_AUTO_REVIEW_INSTRUCTION_MAX_CHARS = 1_000;
export interface SandAutoReviewInstructions { readonly isEnabled: boolean; readonly allowInstructions: readonly string[]; readonly blockInstructions: readonly string[]; }
export const DEFAULT_SAND_AUTO_REVIEW_INSTRUCTIONS: SandAutoReviewInstructions = { isEnabled: true, allowInstructions: [], blockInstructions: [] };
function normalizeInstructionList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = []; const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim(); const clamped = trimmed.length <= SAND_AUTO_REVIEW_INSTRUCTION_MAX_CHARS ? trimmed : trimmed.slice(0, SAND_AUTO_REVIEW_INSTRUCTION_MAX_CHARS);
    if (clamped.length === 0 || seen.has(clamped)) continue;
    seen.add(clamped); result.push(clamped);
    if (result.length >= SAND_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES) break;
  }
  return result;
}
export function normalizeSandAutoReviewInstructions(partial: { readonly isEnabled?: unknown; readonly allowInstructions?: unknown; readonly blockInstructions?: unknown } | null | undefined): SandAutoReviewInstructions {
  return { isEnabled: partial?.isEnabled !== false, allowInstructions: normalizeInstructionList(partial?.allowInstructions), blockInstructions: normalizeInstructionList(partial?.blockInstructions) };
}
