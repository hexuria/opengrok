const KNOWN_GIT_HOSTING_DOMAINS = new Set(["github.com", "gitlab.com", "bitbucket.org", "bitbucket.com", "codeberg.org", "gitea.com", "sr.ht"]);
const ORIGIN_WEB_HOST_PATTERN = /^origin(?:-[a-z0-9]+)?\.cursor\.com$/i;

export function isKnownGitHostingDomain(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (KNOWN_GIT_HOSTING_DOMAINS.has(lower)) return true;
  return [...KNOWN_GIT_HOSTING_DOMAINS].some((domain) => lower.endsWith(`.${domain}`));
}

function trimRepoPath(pathname: string): string { return pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, ""); }
function extractOwnerRepoFromPath(pathname: string): string | undefined {
  const parts = trimRepoPath(pathname).split("/").filter(Boolean);
  return parts.length < 2 ? undefined : `${parts[0]}/${parts.slice(1).join("/")}`;
}
function isOriginRepoHost(hostname: string): boolean { return ORIGIN_WEB_HOST_PATTERN.test(hostname); }
function extractOwnerRepoFromOriginPath(pathname: string): string | undefined {
  const segments = trimRepoPath(pathname).split("/").filter(Boolean);
  if (segments.length === 3 && segments[0]?.toLowerCase() === "git") return `${segments[1]}/${segments[2]}`;
  if (segments.length === 2 && segments[0]?.toLowerCase() !== "git") return `${segments[0]}/${segments[1]}`;
  return undefined;
}
function rewriteScpGitUrl(raw: string): string {
  if (raw.includes("://")) return raw;
  const match = raw.match(/^[^@/]+@([^:]+):(.+)$/);
  return match === null ? raw : `https://${match[1]}/${match[2]}`;
}

export function parseRepoNameFromUrl(repoUrl: string | null | undefined): string | undefined {
  try {
    const trimmed = repoUrl?.trim();
    if (!trimmed) return undefined;
    if (trimmed.includes("://")) {
      const parsed = new URL(trimmed);
      return isOriginRepoHost(parsed.hostname) ? extractOwnerRepoFromOriginPath(parsed.pathname) : extractOwnerRepoFromPath(parsed.pathname);
    }
    const slash = trimmed.indexOf("/");
    if (slash === -1) return undefined;
    const first = trimmed.slice(0, slash);
    const rest = trimmed.slice(slash);
    if (isOriginRepoHost(first.replace(/:\d+$/, ""))) return extractOwnerRepoFromOriginPath(rest);
    return extractOwnerRepoFromPath(isKnownGitHostingDomain(first) ? rest : `/${trimmed}`);
  } catch { return undefined; }
}

export function parseSelfHostedRepoScope(repoUrl: string): string | undefined {
  let candidate = repoUrl;
  if (!candidate.includes("://")) {
    const slash = candidate.indexOf("/");
    if (slash === -1) return undefined;
    const first = candidate.slice(0, slash);
    if (!first.includes(".") || isKnownGitHostingDomain(first)) return undefined;
    candidate = `https://${candidate}`;
  }
  try {
    const parsed = new URL(candidate);
    if (isKnownGitHostingDomain(parsed.hostname) || isOriginRepoHost(parsed.hostname)) return undefined;
    const parts = trimRepoPath(parsed.pathname).split("/").filter(Boolean);
    return parts.length === 0 ? undefined : `${parsed.host}/${parts.join("/")}`;
  } catch { return undefined; }
}

export function deriveRepoLabelValueFromUrl(repoUrl: string | null | undefined): string | undefined {
  const trimmed = repoUrl?.trim();
  if (!trimmed) return undefined;
  const rewritten = rewriteScpGitUrl(trimmed);
  return parseSelfHostedRepoScope(rewritten) ?? parseRepoNameFromUrl(rewritten);
}
