export function stripS3EtagQuotes(raw: string | null | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return "";
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}
export function normalizeS3Etag(raw: string | null | undefined): string { return stripS3EtagQuotes(raw).toLowerCase(); }
