export function ensureFinitePositive({ value, name, context }: { value: number; name: string; context: string }): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${context} ${name} must be a finite positive number, got ${value}`);
  return value;
}
