const RELEASE_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export interface ParsedSandVersion { readonly release: readonly [number, number, number]; readonly prerelease: readonly string[] }

export function parseVersion(version: string): ParsedSandVersion | null {
  const hyphenIndex = version.indexOf("-");
  const releasePart = hyphenIndex === -1 ? version : version.slice(0, hyphenIndex);
  const prereleasePart = hyphenIndex === -1 ? null : version.slice(hyphenIndex + 1);
  const match = RELEASE_PATTERN.exec(releasePart);
  if (match == null) return null;
  const prerelease = prereleasePart == null ? [] : prereleasePart.split(".");
  if (prerelease.some((identifier) => identifier.length === 0)) return null;
  return { release: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease };
}

export function compareVersionIdentifiers(a: string, b: string): number {
  const aIsNumeric = /^\d+$/.test(a);
  const bIsNumeric = /^\d+$/.test(b);
  if (aIsNumeric && bIsNumeric) return Math.sign(Number(a) - Number(b));
  if (aIsNumeric) return -1;
  if (bIsNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export class SandVersionCompareError extends Error {}

export function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  if (parsedA == null || parsedB == null) throw new SandVersionCompareError(`Cannot compare versions "${a}" and "${b}"`);
  for (let index = 0; index < 3; index += 1) {
    const diff = parsedA.release[index]! - parsedB.release[index]!;
    if (diff !== 0) return Math.sign(diff);
  }
  if (parsedA.prerelease.length === 0 && parsedB.prerelease.length === 0) return 0;
  if (parsedA.prerelease.length === 0) return 1;
  if (parsedB.prerelease.length === 0) return -1;
  const length = Math.min(parsedA.prerelease.length, parsedB.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const diff = compareVersionIdentifiers(parsedA.prerelease[index]!, parsedB.prerelease[index]!);
    if (diff !== 0) return diff;
  }
  return Math.sign(parsedA.prerelease.length - parsedB.prerelease.length);
}

export function isNewerVersion(candidate: string, current: string): boolean { return compareVersions(candidate, current) > 0; }
export function isPrerelease(version: string): boolean { return (parseVersion(version)?.prerelease.length ?? 0) > 0; }
