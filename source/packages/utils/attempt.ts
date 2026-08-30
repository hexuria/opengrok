export function attemptSync<T>(operation: () => T): { ok: true; value: T } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    return { ok: false, error };
  }
}
