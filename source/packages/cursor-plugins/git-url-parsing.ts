import {
  isAzureDevopsServicesHost,
  isBitbucketCloudHost,
  isGitHubDotComHost,
  isGitLabHost,
  parseAzureDevopsRepositoryPathSegments,
  parseBitbucketRepositoryPathSegments,
  parseGitHubRepositoryPathSegments,
  parseGitLabRepositoryPathSegments,
} from "../utils/git-provider-url.js";
import { isOriginGitHost } from "../utils/repo-url.js";

type Provider = "github" | "gitlab" | "bitbucket" | "azure_devops" | "generic";
interface ParsedGitUrl { provider: Provider; owner: string; repo: string; host: string }

function detectNonGitHubProvider(host: string): string | null {
  const lowerHost = host.toLowerCase();
  if (isGitLabHost(host)) return "GitLab";
  if (lowerHost.includes("bitbucket")) return "Bitbucket";
  if (lowerHost.includes("gitea") || lowerHost.includes("codeberg")) return "Gitea/Codeberg";
  if (lowerHost.includes("azure") && lowerHost.includes("dev")) return "Azure DevOps";
  return null;
}

function getProvider(host: string): Provider {
  if (isGitHubDotComHost(host)) return "github";
  if (isGitLabHost(host)) return "gitlab";
  if (isBitbucketCloudHost(host)) return "bitbucket";
  if (isAzureDevopsServicesHost(host)) return "azure_devops";
  return "generic";
}

function normalizeToUrl(gitUrl: string): URL | null {
  try {
    const normalized = gitUrl.startsWith("git@") ? `ssh://${gitUrl.replace(":", "/")}` : gitUrl;
    return new URL(normalized.includes("://") ? normalized : `https://${normalized}`);
  } catch { return null; }
}

export function parseGitUrl(gitUrl: string): ParsedGitUrl | null {
  const url = normalizeToUrl(gitUrl);
  if (url === null) return null;
  const host = url.hostname;
  let pathSegments = url.pathname.split("/").filter(Boolean);
  if (isOriginGitHost(host) && pathSegments[0]?.toLowerCase() === "git") pathSegments = pathSegments.slice(1);
  if (pathSegments.length >= 3 && pathSegments[0]!.toLowerCase() === "scm") pathSegments = pathSegments.slice(1);
  const repositoryPath = parseGitHubRepositoryPathSegments(pathSegments);
  return repositoryPath === undefined ? null : { provider: getProvider(host), owner: repositoryPath.owner, repo: repositoryPath.repo, host };
}

function hasBitbucketServerScmPrefix(input: string): boolean {
  const url = normalizeToUrl(input);
  if (url === null) return false;
  const segments = url.pathname.split("/").filter(Boolean);
  return segments.length >= 3 && segments[0]!.toLowerCase() === "scm";
}

function bitbucketPathSegments(url: URL): string[] {
  const segments = url.pathname.split("/");
  if (segments[0] === "") segments.shift();
  if (segments[segments.length - 1] === "") segments.pop();
  return segments;
}

function parseBitbucketRepositoryUrl(input: string) {
  const url = normalizeToUrl(input.trim());
  return url === null || !isBitbucketCloudHost(url.hostname) ? undefined : parseBitbucketRepositoryPathSegments(bitbucketPathSegments(url));
}

type Scm =
  | { url: string; owner: string; repo: string; host: string; provider: "github" | "gitlab" | "bitbucket"; project?: undefined }
  | { url: string; owner: string; repo: string; host: string; provider: "azure_devops"; project: string };

export function parseAndValidateScmUrl(input: string): Scm | { error: string } {
  const trimmed = input.trim();
  if (trimmed === "") return { error: "URL cannot be empty" };
  const parsed = parseGitUrl(trimmed);
  if (parsed === null) return { error: "Invalid URL format. Expected: github.com/owner/repo or gitlab.com/namespace/repo" };
  if (isGitLabHost(parsed.host)) {
    const url = normalizeToUrl(trimmed), repositoryPath = url === null ? undefined : parseGitLabRepositoryPathSegments(url.pathname.split("/").filter(Boolean));
    if (url === null || repositoryPath === undefined) return { error: "Invalid GitLab repository URL format. Expected: https://gitlab.com/namespace/repo" };
    const host = url.host.replace(/^www\./i, "");
    return { url: `https://${host}/${repositoryPath.repositorySegments.join("/")}`, owner: repositoryPath.repositorySegments[0]!, repo: repositoryPath.repositorySegments[repositoryPath.repositorySegments.length - 1]!, host, provider: "gitlab" };
  }
  if (parsed.provider === "bitbucket") {
    const repositoryPath = parseBitbucketRepositoryUrl(trimmed);
    if (repositoryPath === undefined) return { error: "Invalid Bitbucket repository URL format. Expected: https://bitbucket.org/{workspace}/{repo}" };
    const host = parsed.host.replace(/^www\./i, "");
    return { url: `https://${host}/${repositoryPath.workspace}/${repositoryPath.repo}`, owner: repositoryPath.workspace, repo: repositoryPath.repo, host, provider: "bitbucket" };
  }
  if (parsed.provider === "azure_devops") {
    const url = normalizeToUrl(trimmed), repositoryPath = url === null ? undefined : parseAzureDevopsRepositoryPathSegments(url.pathname.split("/").filter(Boolean));
    if (url === null || repositoryPath === undefined) return { error: "Invalid Azure DevOps repository URL format. Expected: https://dev.azure.com/{organization}/{project}/_git/{repo}" };
    const host = parsed.host.replace(/^www\./i, "");
    return { url: `https://${host}/${repositoryPath.organization}/${repositoryPath.project}/_git/${repositoryPath.repo}`, owner: repositoryPath.organization, repo: repositoryPath.repo, host, provider: "azure_devops", project: repositoryPath.project };
  }
  if (isGitHubCompatibleHost(parsed)) {
    const host = canonicalRepoHost(parsed.host.replace(/^www\./i, ""));
    const pathPrefix = hasBitbucketServerScmPrefix(trimmed) ? "scm/" : "";
    return { url: `https://${host}/${pathPrefix}${parsed.owner}/${parsed.repo}`, owner: parsed.owner, repo: parsed.repo, host, provider: "github" };
  }
  const nonGitHubProvider = detectNonGitHubProvider(parsed.host);
  return { error: `Only GitHub, GitLab, Bitbucket, and Azure DevOps URLs are currently supported.${nonGitHubProvider !== null ? ` ${nonGitHubProvider} is not supported yet.` : ""}` };
}

function isGitHubCompatibleHost(parsed: ParsedGitUrl): boolean {
  switch (parsed.provider) {
    case "github": return true;
    case "generic": return !isOriginGitHost(parsed.host) && detectNonGitHubProvider(parsed.host) === null;
    case "gitlab": case "bitbucket": case "azure_devops": return false;
  }
}

export function toScmSshUrl(gitUrl: string): string | null {
  const scm = parseAndValidateScmUrl(gitUrl);
  if ("error" in scm) return null;
  switch (scm.provider) {
    case "github": return `git@${scm.host}:${scm.owner}/${scm.repo}.git`;
    case "gitlab": return gitlabScmToSshUrl(scm);
    case "bitbucket": case "azure_devops": return null;
  }
}

function gitlabScmToSshUrl(scm: Scm): string | null {
  let pathname: string;
  try { pathname = new URL(scm.url).pathname.replace(/^\//, "").replace(/\.git$/i, ""); }
  catch { return null; }
  if (pathname.length === 0) return null;
  return `git@${scm.host.replace(/:\d+$/, "")}:${pathname}.git`;
}

export function canonicalRepoHost(host: string): string {
  return isGitHubDotComHost(host) ? "github.com" : host;
}
