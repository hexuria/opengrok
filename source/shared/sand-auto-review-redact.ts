export const SAND_AUTO_REVIEW_SECRET_VALUE_PATTERN =
  /^(?:bearer\s+|sk[-_]|gh[pousr]_|xox[baprs]-|AIza)[^\s]*$/i;
export const SAND_AUTO_REVIEW_SECRET_KEY_PATTERN =
  /(?:auth|credential|key|password|secret|signature|token)/i;

export function redactSandAutoReviewInlineSecrets(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'`]+/gi, (rawUrl) => {
      try {
        const href = new URL(rawUrl).href.replace(/^(https?:\/\/)[^/?#]*@/i, "$1");
        const withoutHash = href.split("#")[0] ?? href;
        return withoutHash.split("?")[0] ?? withoutHash;
      } catch {
        return rawUrl;
      }
    })
    .replace(
      /((?:--)?(?:api[_-]?key|authorization|credential|password|secret|signature|token)\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1…",
    )
    .replace(/\bBearer\s+[^\s"'`]+/gi, "Bearer …")
    .replace(/\b(?:sk[-_]|gh[pousr]_|xox[baprs]-|AIza)[A-Za-z0-9+/_=-]+/gi, "…");
}
