export const NON_PUBLIC_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".corp",
  ".cluster",
  ".svc",
  ".arpa",
  ".onion",
] as const;

export function hasNonPublicHostnameSuffix(hostname: string): boolean {
  return NON_PUBLIC_HOSTNAME_SUFFIXES.some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
  );
}
