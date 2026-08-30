function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesCommandGlob(pattern: string, value: string): boolean {
  const trimmedPattern = pattern.trim();
  const escapedPattern = escapeRegExp(trimmedPattern);
  const regexSource = `^${escapedPattern.replace(/\\\*/g, ".*")}$`;
  try {
    return new RegExp(regexSource).test(value);
  } catch {
    return trimmedPattern === value;
  }
}
