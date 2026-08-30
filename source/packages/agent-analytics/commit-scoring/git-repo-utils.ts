function parseGitUrl(urlString: string): URL | null {
  try {
    let normalizedUrl = urlString;
    if (urlString.includes("@") && !urlString.startsWith("http")) {
      if (!urlString.startsWith("ssh://")) {
        normalizedUrl = urlString.replace(/^([^@]+)@([^:]+):(.*)/, "ssh://$1@$2/$3");
      }
    }
    return new URL(normalizedUrl);
  } catch (_error) {
    return null;
  }
}

export function extractRepoNameFromGitUrl(upstreamURL: string | undefined): string | undefined {
  if (!upstreamURL) {
    return undefined;
  }
  const normalizedUpstreamURL = upstreamURL.replace("https///", "https://").replace("http///", "http://");
  if (normalizedUpstreamURL.startsWith("gitlab-remote://")) {
    try {
      const url = new URL(normalizedUpstreamURL);
      const projectId = url.searchParams.get("project");
      if (projectId) {
        if (projectId.includes("/")) {
          return projectId;
        }
        return undefined;
      }
    } catch (_error) {
    }
  }
  const url = parseGitUrl(normalizedUpstreamURL);
  if (!url) {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  const pathParts = url.pathname.split("/").filter(part => part.length > 0);
  if (pathParts.length > 0 && pathParts[pathParts.length - 1]!.endsWith(".git")) {
    pathParts[pathParts.length - 1] = pathParts[pathParts.length - 1]!.slice(0, -4);
  }
  const isAzureDevOpsHost = hostname === "dev.azure.com" || hostname === "ssh.dev.azure.com" || hostname.endsWith(".visualstudio.com");
  if (isAzureDevOpsHost) {
    const azurePathParts = [...pathParts];
    if (hostname === "ssh.dev.azure.com" && azurePathParts.length > 0 && azurePathParts[0]!.toLowerCase() === "v3") {
      azurePathParts.shift();
    }
    const filteredAzurePathParts = azurePathParts.filter(part => part.toLowerCase() !== "_git");
    return filteredAzurePathParts.length >= 1 ? filteredAzurePathParts.join("/") : undefined;
  }
  if (hostname.includes("github") || hostname.endsWith(".ghe.com")) {
    return pathParts.length >= 2 ? pathParts.slice(0, 2).join("/") : undefined;
  }
  if (hostname.includes("gitlab")) {
    return pathParts.length >= 1 ? pathParts.join("/") : undefined;
  }
  if (hostname.includes("bitbucket") || hostname.includes("stash")) {
    if (pathParts.length >= 3 && pathParts[0]!.toLowerCase() === "scm") {
      return pathParts.slice(1, 3).join("/");
    }
    if (pathParts.length >= 2) {
      return pathParts.slice(0, 2).join("/");
    }
    return undefined;
  }
  const isGerritHost = hostname.includes("gerrit");
  const hasGerritPath = pathParts.length > 0 && pathParts[0]!.toLowerCase() === "gerrit";
  if (isGerritHost || hasGerritPath) {
    const gerritPathParts = [...pathParts];
    if (hasGerritPath) {
      gerritPathParts.shift();
    }
    if (gerritPathParts.length > 0 && gerritPathParts[0]!.toLowerCase() === "a") {
      gerritPathParts.shift();
    }
    return gerritPathParts.length >= 1 ? gerritPathParts.join("/") : undefined;
  }
  if (pathParts.length >= 2) {
    return pathParts.slice(0, 2).join("/");
  }
  return undefined;
}
