export function findSystemErrno(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current = error;
  while (current != null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^E[A-Z_]+$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
