export function isWildcardRepoUrl(url: string): boolean {
  return url.trim() === "*";
}

export function isPathPatternRepoUrl(url: string): boolean {
  return !url.includes("://") && !url.includes("github.com") && !url.includes("gitlab.com") && !url.includes("bitbucket.org") && !url.includes("@");
}
