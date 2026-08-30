// Extracted from ../packages/agent/dist/context-processing.js as an
// uncomposed attachment/file-spill error leaf. The parent processSelectedContext
// function remains absent.
export function getSafeErrorType(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : typeof error;
}
