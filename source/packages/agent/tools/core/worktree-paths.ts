const ENABLED = true;
const WORKTRIES_REGEX = /(^\/(?:Users|home)\/[^/]+\/\.cursor\/)worktries(?=\/|$)/g;

export function maybeRedirectWorktriesPath(originalPath: string): string {
  if (!ENABLED) {
    return originalPath;
  }
  return originalPath.replace(WORKTRIES_REGEX, "$1worktrees");
}
