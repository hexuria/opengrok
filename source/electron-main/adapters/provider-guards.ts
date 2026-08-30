export function requireObject<T extends object>(value: T | null | undefined, name: string): T {
  if (value == null || typeof value !== "object") throw new TypeError(`Missing Electron production adapter port: ${name}.`);
  return value;
}

export function requireFunction<T extends (...args: any[]) => unknown>(value: T | null | undefined, name: string): T {
  if (typeof value !== "function") throw new TypeError(`Missing Electron production adapter port: ${name}.`);
  return value;
}

export function requireDisposable<T extends { dispose(): void | Promise<void> }>(value: T | null | undefined, name: string): T {
  if (value == null || typeof value !== "object") throw new TypeError(`Missing Electron production adapter port: ${name}.`);
  requireFunction(value.dispose as (() => unknown) | undefined, `${name}.dispose`);
  return value;
}
