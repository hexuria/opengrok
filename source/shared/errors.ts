export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorLogTag(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as Error & { readonly code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? `${error.name} (${code})` : error.name;
}
