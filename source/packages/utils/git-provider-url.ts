const GIT_SUFFIX = /\.git$/i;
const BITBUCKET_NON_REPOSITORY_ROOT_PATHS = new Set(["account", "dashboard"]);
const stripGitSuffix = (segment: string): string => segment.replace(GIT_SUFFIX, "");

export const isGitHubDotComHost = (hostname: string): boolean => hostname.toLowerCase() === "github.com" || hostname.toLowerCase().endsWith(".github.com");
export const isGitLabHost = (hostname: string): boolean => hostname.toLowerCase().split(".").includes("gitlab");
export const isBitbucketCloudHost = (hostname: string): boolean => ["bitbucket.org", "www.bitbucket.org"].includes(hostname.toLowerCase());
export const isAzureDevopsServicesHost = (hostname: string): boolean => ["dev.azure.com", "www.dev.azure.com"].includes(hostname.toLowerCase());

export function parseGitHubRepositoryPathSegments(segments: readonly string[]): { owner: string; repo: string; hasSubpath: boolean } | undefined {
  const owner = segments[0], rawRepo = segments[1];
  if (!owner || !rawRepo) return undefined;
  const repo = stripGitSuffix(rawRepo);
  return repo ? { owner, repo, hasSubpath: segments.length > 2 } : undefined;
}

export function parseGitLabRepositoryPathSegments(segments: readonly string[]): { repositorySegments: string[]; hasSpecialRouteSeparator: boolean } | undefined {
  const specialRouteIndex = segments.indexOf("-");
  const hasSpecialRouteSeparator = specialRouteIndex !== -1;
  const repositorySegments = hasSpecialRouteSeparator ? segments.slice(0, specialRouteIndex) : [...segments];
  if (repositorySegments.length < 2 || repositorySegments.some((segment) => segment.length === 0)) return undefined;
  const last = repositorySegments.length - 1;
  const repo = stripGitSuffix(repositorySegments[last]!);
  if (!repo) return undefined;
  repositorySegments[last] = repo;
  return { repositorySegments, hasSpecialRouteSeparator };
}

function decodeBitbucketPathSegment(segment: string): string | undefined {
  try { const decoded = decodeURIComponent(segment); return decoded.length > 0 && !decoded.includes("/") ? decoded : undefined; } catch { return undefined; }
}

export function parseBitbucketRepositoryPathSegments(segments: readonly string[]): { workspace: string; repo: string; hasSubpath: boolean } | undefined {
  const rawWorkspace = segments[0], rawRepo = segments[1];
  if (rawWorkspace === undefined || rawRepo === undefined) return undefined;
  const workspace = decodeBitbucketPathSegment(rawWorkspace), decodedRepo = decodeBitbucketPathSegment(rawRepo);
  if (workspace === undefined || decodedRepo === undefined || BITBUCKET_NON_REPOSITORY_ROOT_PATHS.has(workspace.toLowerCase())) return undefined;
  const repo = stripGitSuffix(decodedRepo);
  return repo ? { workspace: encodeURIComponent(workspace), repo: encodeURIComponent(repo), hasSubpath: segments.length > 2 } : undefined;
}

export function parseAzureDevopsRepositoryPathSegments(segments: readonly string[]): { organization: string; project: string; repo: string; hasSubpath: boolean } | undefined {
  const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === "_git");
  if (gitIndex < 1 || gitIndex > 2) return undefined;
  const organization = segments[0], rawRepo = segments[gitIndex + 1];
  if (!organization || !rawRepo) return undefined;
  const repo = stripGitSuffix(rawRepo), project = gitIndex === 2 ? segments[1] : repo;
  return repo && project ? { organization, project, repo, hasSubpath: segments.length > gitIndex + 2 } : undefined;
}
